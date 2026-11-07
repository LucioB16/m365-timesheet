/**
 * Per-case CRM detail: portal comments and field-level audit history.
 *
 * The case list alone only says "this case exists". What a timesheet needs is
 * *when* the consultant touched it and *what* they said, so this module pulls
 * the two sources that carry that in this org:
 *
 *  - adx_portalcomment activities (the client-facing conversation), and
 *  - RetrieveRecordChangeHistory, which exposes the old/new text of the status
 *    comment field along with who changed it and exactly when.
 *
 * Both are filtered to the run's date range and, where the source records it,
 * to the consultant's own identities.
 */

const { webApi, origin } = require('./dataverse_cases');

const DEFAULT_STATUS_COMMENT_FIELD = 'new_xpoinfo';
const MAX_COMMENT_CHARS = 240;
const MAX_STATUS_CHARS = 300;

function stripHtml(html) {
    return String(html || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function clip(text, max) {
    const s = stripHtml(text);
    return s.length > max ? `${s.slice(0, max)}...` : s;
}

function dayInZone(iso, timezone) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

function timeInZone(iso, timezone) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false
    }).format(d);
}

function inRange(day, range) {
    return day && day >= range.start && day <= range.end;
}

async function portalComments(config, token, incidentId, range, timezone) {
    const select = '$select=subject,description,createdon,adx_portalcommentdirectioncode,_createdby_value,_ownerid_value';
    const filter = `$filter=_regardingobjectid_value eq ${incidentId}`
        + ` and createdon ge ${range.start}T00:00:00Z and createdon le ${range.end}T23:59:59Z`;
    const data = await webApi(config, token, `adx_portalcomments?${select}&${filter}&$orderby=createdon asc&$top=100`);

    return (data.value || []).map((row) => ({
        day: dayInZone(row.createdon, timezone),
        time: timeInZone(row.createdon, timezone),
        direction: row['adx_portalcommentdirectioncode@OData.Community.Display.V1.FormattedValue'] || '',
        subject: clip(row.subject, 120),
        body: clip(row.description, MAX_COMMENT_CHARS),
        author: row['_createdby_value@OData.Community.Display.V1.FormattedValue'] || '',
        authorId: row._createdby_value || null
    })).filter((c) => inRange(c.day, range))
        // Attachment-only and empty portal comments carry no describable work.
        .filter((c) => c.body || c.subject);
}

/**
 * RetrieveRecordChangeHistory returns every audited change on the record, so we
 * filter locally rather than asking the server: the function does not accept a
 * date filter, and the volume per case is small.
 */
async function changeHistory(config, token, incidentId, range, timezone, statusField) {
    const target = encodeURIComponent(JSON.stringify({ '@odata.id': `incidents(${incidentId})` }));
    const data = await webApi(config, token, `RetrieveRecordChangeHistory(Target=@t)?@t=${target}`);
    const details = data?.AuditDetailCollection?.AuditDetails || [];

    const changes = [];
    for (const detail of details) {
        const record = detail.AuditRecord || {};
        const day = dayInZone(record.createdon, timezone);
        if (!inRange(day, range)) continue;

        const newValue = detail.NewValue || {};
        const oldValue = detail.OldValue || {};
        const fields = Object.keys(newValue)
            .filter((k) => !k.startsWith('@') && !k.includes('@odata') && k !== 'incidentid');

        changes.push({
            day,
            time: timeInZone(record.createdon, timezone),
            action: record['action@OData.Community.Display.V1.FormattedValue'] || 'Update',
            userId: record._userid_value || null,
            user: record['_userid_value@OData.Community.Display.V1.FormattedValue'] || '',
            fields,
            statusComment: Object.prototype.hasOwnProperty.call(newValue, statusField)
                ? { from: clip(oldValue[statusField], MAX_STATUS_CHARS), to: clip(newValue[statusField], MAX_STATUS_CHARS) }
                : null
        });
    }
    return changes;
}

/**
 * @returns cases enriched with `portalComments`, `changes` and `activeDays`
 */
async function enrichCases(config, token, cases, range, options = {}) {
    const timezone = options.timezone || 'UTC';
    const statusField = config.CRM_STATUS_COMMENT_FIELD || DEFAULT_STATUS_COMMENT_FIELD;
    const myIds = new Set((options.identityIds || []).filter(Boolean));
    const warnings = [];
    const limit = Number(config.CRM_DETAIL_MAX_CASES || 40);

    const targets = cases.slice(0, limit);
    const enriched = new Array(targets.length);

    // Each case needs two independent round trips, so a small pool turns a long
    // serial crawl into a few seconds without hammering the org.
    const concurrency = Math.max(1, Number(config.CRM_DETAIL_CONCURRENCY || 6));
    let cursor = 0;

    async function worker() {
        while (cursor < targets.length) {
            const index = cursor++;
            const c = targets[index];
            if (!c.incidentId) {
                enriched[index] = { ...c, portalComments: [], changes: [], activeDays: [] };
                continue;
            }

            const [comments, changes] = await Promise.all([
                portalComments(config, token, c.incidentId, range, timezone).catch((e) => {
                    warnings.push(`Portal comments for ${c.caseId} failed: ${e.message.split('::')[0].trim()}`);
                    return [];
                }),
                changeHistory(config, token, c.incidentId, range, timezone, statusField).catch((e) => {
                    warnings.push(`Change history for ${c.caseId} failed: ${e.message.split('::')[0].trim()}`);
                    return [];
                })
            ]);

            // A day only counts as "mine" when I authored the change or the comment.
            // Client replies prove the case was live, not that I billed time on it.
            const mineDays = new Set();
            for (const ch of changes) if (!myIds.size || myIds.has(ch.userId)) mineDays.add(ch.day);
            for (const pc of comments) if (myIds.size && myIds.has(pc.authorId)) mineDays.add(pc.day);

            enriched[index] = {
                ...c,
                portalComments: comments,
                changes,
                activeDays: [...mineDays].sort()
            };
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

    if (cases.length > limit) {
        warnings.push(`Only the first ${limit} case(s) were enriched with portal comments and audit history (CRM_DETAIL_MAX_CASES).`);
    }

    return { cases: enriched, warnings };
}

module.exports = { enrichCases, stripHtml, DEFAULT_STATUS_COMMENT_FIELD };
