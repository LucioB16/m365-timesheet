const { CASE_ID_RE } = require('./local_evidence');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const roundQuarter = (n) => Math.round(Number(n || 0) * 4) / 4;
const fmtHours = (n) => round2(n).toFixed(2);

function normClient(s) {
    return String(s || '').trim().replace(/\s+/g, ' ');
}

function parseHoursHint(item) {
    const raw = item.hours_hint ?? item.hours ?? item.duration_hours ?? item.estimated_hours ?? '';
    if (typeof raw === 'number' && Number.isFinite(raw)) return roundQuarter(raw);
    const asNum = Number(String(raw).replace(',', '.').trim());
    if (Number.isFinite(asNum) && asNum > 0) return roundQuarter(asNum);
    const mins = Number(item.duration_minutes ?? item.minutes ?? NaN);
    if (Number.isFinite(mins) && mins > 0) return roundQuarter(mins / 60);
    return 0;
}

function toArray(v) {
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined) return [];
    return [v];
}

function splitIds(value) {
    return toArray(value)
        .flatMap((x) => String(x).split(','))
        .map((s) => s.trim())
        .filter(Boolean)
        .flatMap((s) => (s.match(new RegExp(CASE_ID_RE.source, 'gi')) || [s]))
        .map((s) => String(s).toUpperCase())
        .filter((s) => s !== 'N/A' && s !== 'NA' && s !== '-');
}

function looksInternalSystems(item, client, project, description) {
    if (/^internal systems$/i.test(client)) return true;
    const t = `${project} ${description} ${toArray(item.tickets || item.cases || item.ids).join(' ')}`.toLowerCase();
    return /\b(internal (crm|portal|sla|dataverse|system)|our own (crm|portal|sla)|\bint-\d{3,6}\b)\b/.test(t);
}

function compactText(parts, maxLen) {
    const clean = parts
        .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    if (!clean.length) return '';
    let out = '';
    for (const p of clean) {
        const next = out ? `${out} ${p}` : p;
        if (next.length <= maxLen) out = next;
        else break;
    }
    return out.slice(0, maxLen).trim();
}

function trimDanglingConnector(text) {
    return String(text || '')
        .trim()
        .replace(/[,\-:;]+$/, '')
        // A preceding space (not just \b) is required so a hyphenated compound
        // like "check-in" or "sign-in" does not lose its second half: \b alone
        // also matches right after the hyphen.
        .replace(/(?:^|\s)(and|or|with|for|to|in|on|of)\s*$/i, '')
        .trim();
}

function clipAtWordBoundary(text, maxLen) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLen) return cleaned;
    const cut = cleaned.slice(0, maxLen + 1);
    const idx = cut.lastIndexOf(' ');
    if (idx > 0) return trimDanglingConnector(cut.slice(0, idx));
    return trimDanglingConnector(cleaned.slice(0, maxLen));
}

function shortenCaseNote(text, max = 72) {
    const cleaned = compactText([text], 500);
    const sentences = cleaned.split(/[.;]/).map((s) => s.trim()).filter(Boolean);
    const firstSentence = (sentences[0] || cleaned).trim();

    // Several short sentences (e.g. two distinct meetings in one Internal
    // bucket) should all survive if they jointly fit, instead of silently
    // dropping everything after the first "." or ";".
    if (sentences.length > 1) {
        let out = '';
        for (const s of sentences) {
            const next = out ? `${out}; ${s}` : s;
            if (next.length <= max) out = next;
            else break;
        }
        if (out) return trimDanglingConnector(out);
    }

    if (firstSentence.length <= max) return trimDanglingConnector(firstSentence);

    const clauses = firstSentence.split(',').map((c) => trimDanglingConnector(c)).filter(Boolean);
    if (clauses.length > 1) {
        let out = '';
        for (const c of clauses) {
            const next = out ? `${out}, ${c}` : c;
            if (next.length <= max) out = next;
            else break;
        }
        if (out) return trimDanglingConnector(out);
    }
    return clipAtWordBoundary(firstSentence, max);
}

/**
 * Multi-id evidence items often interleave distinct "ID: did X." notes for
 * each id in one description. Downstream code used to take one shortened
 * snippet of the WHOLE string and stamp it identically onto every id, so two
 * unrelated cases ended up with the same sentence. This recovers each id's
 * own segment (the text between its header and the next recognized header),
 * so only ids with no explicit segment fall back to shared text.
 */
function splitPerIdSegments(description, ids) {
    const perId = new Map();
    const text = String(description || '');
    if (!ids.length || !text) return perId;
    const idSet = new Set(ids.map((i) => String(i).toUpperCase()));
    const headerRe = new RegExp(`(${CASE_ID_RE.source})\\s*[:\\-\u2013]`, 'gi');
    const matches = [];
    let m;
    while ((m = headerRe.exec(text))) {
        const id = m[1].toUpperCase();
        if (idSet.has(id)) matches.push({ id, headerStart: m.index, headerEnd: m.index + m[0].length });
    }
    for (let i = 0; i < matches.length; i++) {
        const sliceEnd = i + 1 < matches.length ? matches[i + 1].headerStart : text.length;
        const seg = text.slice(matches[i].headerEnd, sliceEnd).trim();
        if (seg && !perId.has(matches[i].id)) perId.set(matches[i].id, seg);
    }
    return perId;
}

function joinWithinLimit(parts, maxLen, sep = '; ') {
    const clean = parts.map((p) => String(p || '').trim()).filter(Boolean);
    let out = '';
    for (const p of clean) {
        const next = out ? `${out}${sep}${p}` : p;
        if (next.length <= maxLen) out = next;
        else break;
    }
    return out;
}

function ensureIdPrefixedDescription(description, ids) {
    if (!ids.length) return description;
    if (ids.some((id) => description.includes(id))) return description;
    return `${ids[0]}: ${description}`.trim();
}

/**
 * Evidence items routinely arrive already headed with their own case ID(s),
 * e.g. "CAS-123: did X" or "CAS-123 / CAS-456: did X". Per-id notes are later
 * re-prefixed with exactly one canonical "id: " header, so any such leading
 * header is stripped first - otherwise the id ends up duplicated ("CAS-123:
 * CAS-123: did X").
 */
function stripLeadingCaseIdHeader(note) {
    const idGroup = `(?:${CASE_ID_RE.source})(?:\\s*(?:[\\/,]|and)\\s*(?:${CASE_ID_RE.source}))*`;
    const re = new RegExp(`^${idGroup}\\s*[:\\-–]\\s*`, 'i');
    return String(note || '').replace(re, '').trim();
}

function normalizeClientKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
}

function pickCaseOverride({ client, project, description, overrides }) {
    if (!Array.isArray(overrides) || overrides.length === 0) return null;
    const key = normalizeClientKey(client);
    const text = `${project} ${description}`.toLowerCase();
    for (const o of overrides) {
        const caseId = String(o?.caseId || '').trim().toUpperCase();
        if (!caseId) continue;
        const targetClient = normalizeClientKey(o?.client || '');
        if (targetClient && targetClient !== key) continue;
        const matchExpr = String(o?.match || '').trim();
        if (!matchExpr) return caseId;
        const terms = matchExpr.toLowerCase().split('|').map((s) => s.trim()).filter(Boolean);
        if (terms.length === 0 || terms.some((term) => text.includes(term))) return caseId;
    }
    return null;
}

function pickCaseFromCrm({ client, project, description, day, crmCases }) {
    if (!Array.isArray(crmCases) || crmCases.length === 0) return null;
    const key = normalizeClientKey(client);
    const pool = crmCases.filter((c) => normalizeClientKey(c.client) === key);
    if (pool.length === 0) return null;

    const text = `${project} ${description}`.toLowerCase();
    const scored = pool.map((c) => {
        const title = String(c.title || '').toLowerCase();
        let score = 0;
        for (const t of ['disposition', 'chevron', 'portal', 'sla', 'invite', 'flow', 'invoice']) {
            if (text.includes(t) && title.includes(t)) score += 2;
        }
        if (String(c.modifiedOn || '').slice(0, 10) === day) score += 1;
        return { caseId: c.caseId, title: c.title, score };
    }).sort((a, b) => b.score - a.score);

    if (scored[0] && scored[0].score > 0) return scored[0].caseId;
    if (pool.length === 1) return pool[0].caseId;
    return null;
}

function makeInternalRow(day, hours, verifyNote = '') {
    return {
        Date: day,
        Client: 'Internal',
        'Project/Area': 'Internal / Non-Billable',
        'Tickets/Cases': 'N/A',
        Description: 'Internal: meetings, administration, coordination and uncovered support work for this day.',
        Hours: fmtHours(hours),
        Billable: 'No',
        Evidence: 'M365 discovery + local reconciliation',
        'Comments/Next Steps': verifyNote || 'VERIFY - insufficient evidence for remaining time'
    };
}

function composeTimesheetRows({ evidence, range, config, crm }) {
    const payload = evidence || {};
    const internalSystemsClient = config.INTERNAL_SYSTEMS_CLIENT || 'Internal Systems';
    const byKey = new Map();

    for (const raw of toArray(payload.evidence_items)) {
        const day = String(raw.date || raw.day || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !range.days.includes(day)) continue;

        const baseClient = normClient(raw.client || raw.customer || '');
        const project = normClient(raw.project_area || raw.project || raw.area || '');
        const descriptionRaw = String(raw.description || raw.action || raw.summary || 'Worked on client activities.').trim();
        const evidenceText = compactText(toArray(raw.evidence || raw.evidence_refs || raw.source || raw.sources), 255) || 'M365 evidence';
        const commentsText = compactText(toArray(raw.comments || raw.next_steps || ''), 255);
        let ids = [...new Set(splitIds(raw.tickets || raw.cases || raw.ids || raw.case_ids || raw.ticket_ids))];
        const hinted = parseHoursHint(raw);

        let client = baseClient || 'Internal';
        let billable = String(raw.billable ?? '').toLowerCase();
        if (billable === 'true') billable = 'yes';
        if (billable === 'false') billable = 'no';

        const internalSystems = looksInternalSystems(raw, client, project, descriptionRaw);
        if (internalSystems) {
            client = internalSystemsClient;
            billable = 'no';
        } else if (!client || /^internal$/i.test(client)) {
            client = 'Internal';
            billable = 'no';
        } else if (billable !== 'yes' && billable !== 'no') {
            billable = 'yes';
        }

        const rowProject = project || (client === 'Internal' ? 'Internal / Non-Billable' : (internalSystems ? 'Internal System' : 'General'));
        if (ids.length === 0 && !/^internal$/i.test(client) && client !== internalSystemsClient) {
            const forced = pickCaseOverride({
                client,
                project: rowProject,
                description: descriptionRaw,
                overrides: config.CASE_ID_OVERRIDES
            });
            const guessed = forced || pickCaseFromCrm({ client, project: rowProject, description: descriptionRaw, day, crmCases: crm?.cases || [] });
            if (guessed) ids = [guessed];
        }
        const rowIds = ids;
        // The final row may combine several evidence items for the same
        // day/client, so the per-note budget cannot be known exactly here -
        // but an item that only touches one or two ids can safely get much
        // more of the 255-char budget than one that already lists several,
        // instead of everyone sharing the same tight 74-char cap.
        const noteMax = rowIds.length <= 1 ? 220 : rowIds.length === 2 ? 110 : 74;
        const descForNote = rowIds.length ? stripLeadingCaseIdHeader(descriptionRaw) : descriptionRaw;
        const rowDesc = shortenCaseNote(descForNote, noteMax);
        // When one item covers several ids, prefer each id's own segment of
        // the text over the shared/whole-text fallback, so distinct cases
        // don't end up with an identical description.
        const perIdSegments = rowIds.length > 1 ? splitPerIdSegments(descriptionRaw, rowIds) : new Map();
        const noteForId = (id) => {
            const segment = perIdSegments.get(id);
            return segment ? shortenCaseNote(segment, noteMax) : rowDesc;
        };
        const key = `${day}|${client.toLowerCase()}`;

        if (!byKey.has(key)) {
            byKey.set(key, {
                Date: day,
                Client: client,
                'Project/Area': rowProject,
                _ids: new Set(rowIds),
                _notesById: new Map(),
                _genericNotes: [],
                _ev: [evidenceText],
                _comments: commentsText ? [commentsText] : [],
                _hours: hinted
            });
            if (rowIds.length) {
                rowIds.forEach((id) => byKey.get(key)._notesById.set(id, noteForId(id)));
            } else if (rowDesc) {
                byKey.get(key)._genericNotes.push(rowDesc);
            }
        } else {
            const r = byKey.get(key);
            rowIds.forEach((id) => r._ids.add(id));
            if (rowIds.length) {
                rowIds.forEach((id) => {
                    if (!r._notesById.has(id)) r._notesById.set(id, noteForId(id));
                });
            } else if (rowDesc) {
                r._genericNotes.push(rowDesc);
            }
            if (evidenceText) r._ev.push(evidenceText);
            if (commentsText) r._comments.push(commentsText);
            r._hours = roundQuarter(r._hours + hinted);
        }
    }

    const rows = [...byKey.values()].map((r) => {
        const sortedIds = [...r._ids].sort();
        const suppressIntIds = r.Client === internalSystemsClient;

        // Ids that ended up sharing the exact same note (the generic
        // fallback when several ids in one item have no individually
        // segmented text) are combined into one "ID1,ID2: note" part instead
        // of repeating the full note once per id - this avoids redundancy
        // and leaves more of the 255-char budget for ids that do have their
        // own distinct segment.
        const groups = [];
        const groupByNote = new Map();
        for (const id of sortedIds) {
            const note = String(r._notesById.get(id) || '').trim();
            if (!note) continue;
            if (suppressIntIds && /^INT-\d{3,6}$/i.test(id)) {
                groups.push({ ids: [id], note, bare: true });
                continue;
            }
            if (!groupByNote.has(note)) {
                const g = { ids: [], note, bare: false };
                groupByNote.set(note, g);
                groups.push(g);
            }
            groupByNote.get(note).ids.push(id);
        }
        const descParts = groups.map((g) => (g.bare ? g.note : `${g.ids.join(',')}: ${g.note}`));
        if (descParts.length === 0) descParts.push(...r._genericNotes);
        const description = joinWithinLimit(descParts.map((x) => x.replace(/\.+$/, '')), 255) || compactText(r._genericNotes, 255) || 'Internal: support and coordination tasks.';
        return {
            Date: r.Date,
            Client: r.Client,
            'Project/Area': r['Project/Area'],
            'Tickets/Cases': sortedIds.length ? sortedIds.join(',') : 'N/A',
            Description: ensureIdPrefixedDescription(description, suppressIntIds ? [] : sortedIds),
            Hours: fmtHours(r._hours),
            Billable: /^internal$/i.test(r.Client) || r.Client === internalSystemsClient ? 'No' : 'Yes',
            Evidence: compactText([...new Set(r._ev)], 255) || 'M365 evidence',
            'Comments/Next Steps': compactText([...new Set(r._comments)], 255)
        };
    });

    const byDay = new Map();
    rows.forEach((r, i) => {
        if (!byDay.has(r.Date)) byDay.set(r.Date, []);
        byDay.get(r.Date).push(i);
    });

    const quota = Number(config.HOURS_PER_DAY);
    for (const day of range.workingDays) {
        const idx = byDay.get(day) || [];
        let total = round2(idx.reduce((s, i) => s + Number(rows[i].Hours), 0));
        if (total < quota) {
            const add = roundQuarter(quota - total);
            const internalIdx = idx.find((i) => rows[i].Client === 'Internal');
            if (internalIdx !== undefined) {
                rows[internalIdx].Hours = fmtHours(roundQuarter(Number(rows[internalIdx].Hours) + add));
                rows[internalIdx]['Comments/Next Steps'] = compactText([rows[internalIdx]['Comments/Next Steps'], 'VERIFY - insufficient evidence for remaining time'], 255);
            } else {
                const newRow = makeInternalRow(day, add);
                rows.push(newRow);
                if (!byDay.has(day)) byDay.set(day, []);
                byDay.get(day).push(rows.length - 1);
            }
            total = round2(total + add);
        }
        if (total > quota) {
            let diff = roundQuarter(total - quota);
            const ordered = (byDay.get(day) || []).slice().sort((a, b) => Number(rows[b].Hours) - Number(rows[a].Hours));
            for (const i of ordered) {
                if (diff <= 0) break;
                const cur = Number(rows[i].Hours);
                const minKeep = 0.25;
                const canCut = roundQuarter(cur - minKeep);
                if (canCut <= 0) continue;
                const cut = Math.min(canCut, diff);
                rows[i].Hours = fmtHours(cur - cut);
                rows[i]['Comments/Next Steps'] = compactText([rows[i]['Comments/Next Steps'], `VERIFY - balance adjustment (-${fmtHours(cut)})`], 255);
                diff = roundQuarter(diff - cut);
            }
        }
    }

    rows.sort((a, b) => `${a.Date}|${a.Client}`.localeCompare(`${b.Date}|${b.Client}`));

    const meta = {
        range: payload.range || { start: range.start, end: range.end, timezone: range.timezone },
        discovered_ids: toArray(payload.discovered_ids),
        needs_case_confirmation: toArray(payload.needs_case_confirmation),
        verify: toArray(payload.verify),
        assumptions: [...new Set(['Rows composed locally from Copilot evidence_items.', ...toArray(payload.assumptions).map((x) => String(x))])],
        context_only: toArray(payload.context_only),
        evidence_notes: toArray(payload.evidence_notes)
    };
    return { rows, meta };
}

module.exports = { composeTimesheetRows, roundQuarter, fmtHours, parseHoursHint, looksInternalSystems };
