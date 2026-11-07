/**
 * Reconciliation: the part that catches what Microsoft 365 alone cannot see.
 *
 * Three independent pictures of the same week are compared:
 *   - what the timesheet claims,
 *   - what the workstation recorded (git commits and touched files per case folder),
 *   - what the CRM says is assigned to or worked by the user.
 *
 * Any disagreement becomes a finding. Nothing here changes the timesheet; it
 * only tells the user what to look at before submitting.
 */

const { CASE_ID_RE } = require('./local_evidence');

const SEV = { BLOCK: 'blocking', CHECK: 'check', INFO: 'info' };

function idsInRow(row) {
    const field = String(row['Tickets/Cases'] || '');
    const fromField = field.split(',').map((s) => s.trim()).filter((s) => s && s !== 'N/A');
    const fromDesc = String(row.Description || '').match(new RegExp(CASE_ID_RE.source, 'gi')) || [];
    return [...new Set([...fromField, ...fromDesc].map((s) => s.toUpperCase()))];
}

function normalizeClient(name, folderToClient) {
    const raw = String(name || '').trim();
    const mapped = folderToClient && folderToClient[raw];
    return (mapped || raw).toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
}

function normalizeSuppressionList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((s) => ({
        code: String(s.code || '').trim().toUpperCase(),
        caseId: s.caseId ? String(s.caseId).trim().toUpperCase() : '',
        client: s.client ? String(s.client).trim() : '',
        dates: Array.isArray(s.dates) ? s.dates.map((d) => String(d).trim()) : (s.date ? [String(s.date).trim()] : [])
    })).filter((s) => s.code);
}

function isSuppressedFinding({ suppressions, code, date, caseId, client, folderToClient }) {
    const codeKey = String(code || '').toUpperCase();
    const caseKey = String(caseId || '').toUpperCase();
    const clientKey = normalizeClient(client || '', folderToClient);
    return suppressions.some((s) => {
        if (s.code !== codeKey) return false;
        if (s.caseId && s.caseId !== caseKey) return false;
        if (s.client && normalizeClient(s.client, folderToClient) !== clientKey) return false;
        if (s.dates.length > 0 && !s.dates.includes(String(date || ''))) return false;
        return true;
    });
}

function reconcile({ rows, meta, local, crm, range, config }) {
    const findings = [];
    const folderToClient = config.FOLDER_TO_CLIENT || {};
    const suppressions = normalizeSuppressionList(meta && meta.reconciliation_suppress);

    // Our own CRM/portal work is a separate line but it is still internal, so it
    // must not be judged as unevidenced client billing.
    const internalSystems = normalizeClient(config.INTERNAL_SYSTEMS_CLIENT || '', folderToClient);
    const isInternal = (client) => {
        const c = String(client || '');
        return /^internal$/i.test(c.trim())
            || (internalSystems && normalizeClient(c, folderToClient) === internalSystems);
    };

    const claimed = new Map();   // "date|CASEID" -> row index
    const claimedClientDay = new Map(); // "date|client" -> row index
    rows.forEach((row, i) => {
        claimedClientDay.set(`${row.Date}|${normalizeClient(row.Client, folderToClient)}`, i);
        for (const id of idsInRow(row)) claimed.set(`${row.Date}|${id}`, i);
    });

    // 1. Local work that never made it onto the timesheet.
    for (const [date, entries] of Object.entries(local.byDate)) {
        if (!range.days.includes(date)) continue;
        for (const e of entries) {
            const strength = e.commits.length ? `${e.commits.length} commit(s)` : `${e.fileCount} file(s) touched`;
            if (e.caseId && claimed.has(`${date}|${e.caseId.toUpperCase()}`)) continue;
            if (!e.caseId && claimedClientDay.has(`${date}|${normalizeClient(e.client, folderToClient)}`)) continue;
            if (isSuppressedFinding({
                suppressions,
                code: 'MISSING_LOCAL_WORK',
                date,
                caseId: e.caseId,
                client: e.client,
                folderToClient
            })) continue;

            findings.push({
                severity: e.commits.length ? SEV.BLOCK : SEV.CHECK,
                code: 'MISSING_LOCAL_WORK',
                date,
                client: e.client,
                caseId: e.caseId,
                message: `Local evidence shows work on ${e.caseId || e.title} (${strength}) on ${date}, but the timesheet has no entry for it.`,
                detail: e.commits.slice(0, 3)
            });
        }
    }

    // 2. Days billed to a client with nothing corroborating them locally.
    const localByClientDay = new Set();
    for (const [date, entries] of Object.entries(local.byDate)) {
        for (const e of entries) localByClientDay.add(`${date}|${normalizeClient(e.client, folderToClient)}`);
    }
    rows.forEach((row, i) => {
        if (isInternal(row.Client)) return;
        const key = `${row.Date}|${normalizeClient(row.Client, folderToClient)}`;
        if (localByClientDay.has(key)) return;
        findings.push({
            severity: SEV.INFO,
            code: 'NO_LOCAL_TRACE',
            date: row.Date,
            client: row.Client,
            message: `${row.Hours} h billed to ${row.Client} on ${row.Date} with no local git or file activity. Fine for meeting/email-only days, worth a glance otherwise.`,
            detail: [`row ${i + 1}`]
        });
    });

    // 3. IDs on the timesheet that neither the workstation nor the CRM knows about.
    const known = new Set([...(local.knownIds || []), ...(crm.knownIds || [])].map((s) => s.toUpperCase()));
    const unknown = new Map();
    rows.forEach((row, i) => {
        for (const id of idsInRow(row)) {
            if (known.has(id)) continue;
            if (!unknown.has(id)) unknown.set(id, { id, client: row.Client, dates: [], rows: [] });
            unknown.get(id).dates.push(row.Date);
            unknown.get(id).rows.push(i + 1);
        }
    });
    for (const u of unknown.values()) {
        findings.push({
            severity: SEV.CHECK,
            code: 'UNKNOWN_ID',
            date: u.dates[0],
            client: u.client,
            caseId: u.id,
            message: `${u.id} is billed on ${u.dates.join(', ')} but is not a local case folder and is not in the CRM list. Confirm the ID before submitting.`,
            detail: u.rows.map((r) => `row ${r}`)
        });
    }

    // 4. Discovered IDs the model parked as pending.
    for (const d of meta.discovered_ids || []) {
        findings.push({
            severity: SEV.BLOCK,
            code: 'DISCOVERED_ID_CONFIRMATION_REQUIRED',
            date: d.date || range.start,
            client: d.client || '',
            caseId: d.id,
            message: `Copilot found ${d.id} (${d.client || 'client unknown'}) in the evidence and parked it as "${d.status || 'pending'}". Confirmation required before billing. Recommendation: ${d.recommendation || 'Verify'}. ${d.context || ''}`.trim(),
            detail: [d.evidence].filter(Boolean)
        });
    }

    // 4b. Non-internal rows without case numbers must be confirmed by the user.
    rows.forEach((row, i) => {
        const tickets = String(row['Tickets/Cases'] || '').trim().toUpperCase();
        if (!tickets || tickets === 'N/A') {
            if (!isInternal(row.Client)) {
                findings.push({
                    severity: SEV.BLOCK,
                    code: 'MISSING_CASE_ID_CONFIRMATION',
                    date: row.Date,
                    client: row.Client,
                    message: `Row ${i + 1} has no case/ticket ID for client ${row.Client} on ${row.Date}; user confirmation is required.`,
                    detail: [String(row.Description || '').slice(0, 160)]
                });
            }
        }
    });

    // 5. CRM days where the consultant personally touched a case but billed nothing.
    //    A day the user themself edited the record or answered the client is much
    //    stronger evidence than the record's last-modified stamp, which any
    //    workflow or colleague can move.
    if (crm.ok) {
        for (const c of crm.cases) {
            const id = String(c.caseId).toUpperCase();

            const activeDays = (c.activeDays || []).filter((d) => range.days.includes(d));
            for (const day of activeDays) {
                if (claimed.has(`${day}|${id}`)) continue;
                if (isSuppressedFinding({
                    suppressions,
                    code: 'CRM_WORK_NOT_BILLED',
                    date: day,
                    caseId: c.caseId,
                    client: c.client,
                    folderToClient
                })) continue;
                const status = (c.changes || []).find((ch) => ch.day === day && ch.statusComment);
                const outgoing = (c.portalComments || []).filter((pc) => pc.day === day && /out/i.test(pc.direction));
                const what = status
                    ? `set the status comment to "${status.statusComment.to || '(cleared)'}"`
                    : outgoing.length
                        ? `sent ${outgoing.length} portal comment(s) to the client`
                        : 'updated the record';
                findings.push({
                    severity: SEV.BLOCK,
                    code: 'CRM_WORK_NOT_BILLED',
                    date: day,
                    client: c.client,
                    caseId: c.caseId,
                    message: `On ${day} you ${what} on ${c.caseId} (${c.client}), but the timesheet has no entry for it.`,
                    detail: [c.title]
                });
            }

            // Fall back to the last-modified stamp only for cases we have no
            // per-day detail for, so an un-enriched case is not silently ignored.
            if (c.activeDays) continue;
            if (claimed.has(`${String(c.modifiedOn).slice(0, 10)}|${id}`)) continue;
            const modified = String(c.modifiedOn).slice(0, 10);
            if (!range.days.includes(modified)) continue;
            if (isSuppressedFinding({
                suppressions,
                code: 'CRM_ACTIVITY_NOT_BILLED',
                date: modified,
                caseId: c.caseId,
                client: c.client,
                folderToClient
            })) continue;
            findings.push({
                severity: SEV.CHECK,
                code: 'CRM_ACTIVITY_NOT_BILLED',
                date: modified,
                client: c.client,
                caseId: c.caseId,
                message: `CRM case ${c.caseId} (${c.client}) was modified on ${modified} inside the range but has no time on the timesheet.`,
                detail: [c.title]
            });
        }
    }

    // 6. Working days with no client work at all.
    const clientDays = new Set(rows.filter((r) => !isInternal(r.Client)).map((r) => r.Date));
    for (const day of range.workingDays) {
        if (clientDays.has(day)) continue;
        findings.push({
            severity: SEV.INFO,
            code: 'FULLY_INTERNAL_DAY',
            date: day,
            client: 'Internal',
            message: `${day} has no billable client time at all. Confirm that is correct.`
        });
    }

    const order = { [SEV.BLOCK]: 0, [SEV.CHECK]: 1, [SEV.INFO]: 2 };
    findings.sort((a, b) => (order[a.severity] - order[b.severity]) || String(a.date).localeCompare(String(b.date)));

    return {
        findings,
        blocking: findings.filter((f) => f.severity === SEV.BLOCK),
        counts: {
            blocking: findings.filter((f) => f.severity === SEV.BLOCK).length,
            check: findings.filter((f) => f.severity === SEV.CHECK).length,
            info: findings.filter((f) => f.severity === SEV.INFO).length
        }
    };
}

module.exports = { reconcile, idsInRow, normalizeClient, SEV };
