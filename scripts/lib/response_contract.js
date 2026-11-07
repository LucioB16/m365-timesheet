/**
 * Output contract for the timesheet run.
 *
 * Preferred contract: one fenced ```json block carrying evidence_items.
 * Legacy contract (still accepted): ```csv + ```json.
 * Anything else is INVALID and nothing downstream is allowed to run on it.
 */

const REQUIRED_COLUMNS = ['Date', 'Client', 'Project/Area', 'Tickets/Cases', 'Description', 'Hours', 'Billable', 'Evidence', 'Comments/Next Steps'];

const REFUSAL_PATTERNS = [
    /\bI (?:can(?:'|no)t|am unable to|do not have access)\b/i,
    /\bI don'?t have access to\b/i,
    /\bas an AI\b/i
];

function extractFences(text) {
    const fences = [];
    const re = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        fences.push({ lang: (m[1] || '').toLowerCase(), body: m[2].replace(/\s+$/, '') });
    }
    return fences;
}

/** RFC4180 parser. Handles quoted fields, embedded commas, quotes and newlines. */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const src = text.replace(/\r\n?/g, '\n');

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') { inQuotes = true; continue; }
        if (ch === ',') { row.push(field); field = ''; continue; }
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += ch;
    }
    if (inQuotes) throw new Error('CSV block ends inside an unterminated quoted field.');
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function toObjects(rows) {
    const header = rows[0].map((h) => h.trim());
    const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
    const extra = header.filter((c) => !REQUIRED_COLUMNS.includes(c));
    return {
        header,
        missing,
        extra,
        rows: rows.slice(1).map((cells, i) => {
            const obj = { __line: i + 2 };
            header.forEach((h, j) => { obj[h] = (cells[j] === undefined ? '' : String(cells[j])).trim(); });
            return obj;
        })
    };
}

/**
 * @param {string} text  raw reply captured from M365 Copilot
 * @returns {{status:'OK'|'INVALID', mode:'evidence'|'legacy', violations:string[], rows:Array, meta:object|null, header:string[]}}
 */
function classifyResponse(text) {
    const violations = [];
    const result = { status: 'INVALID', mode: 'evidence', violations, rows: [], meta: null, header: [] };

    if (!text || !text.trim()) {
        violations.push('EMPTY_REPLY: nothing was captured from the page.');
        return result;
    }

    const fences = extractFences(text);
    const csvFences = fences.filter((f) => f.lang === 'csv');
    const jsonFences = fences.filter((f) => f.lang === 'json');

    // Preferred path: evidence-only JSON contract.
    if (csvFences.length === 0 && jsonFences.length > 0) {
        if (jsonFences.length > 1) violations.push(`MULTIPLE_JSON_BLOCKS: ${jsonFences.length} json fences; only the first is used.`);
        let payload;
        try {
            payload = JSON.parse(jsonFences[0].body);
        } catch (e) {
            violations.push(`JSON_PARSE_ERROR: ${e.message}`);
            return result;
        }
        for (const key of ['range', 'evidence_items', 'discovered_ids', 'verify', 'assumptions']) {
            if (payload[key] === undefined) violations.push(`JSON_MISSING_KEY: "${key}" is required (use an empty array if there is nothing).`);
        }
        for (const key of ['evidence_items', 'discovered_ids', 'verify', 'assumptions', 'context_only', 'evidence_notes', 'needs_case_confirmation']) {
            if (payload[key] !== undefined && !Array.isArray(payload[key])) violations.push(`JSON_BAD_TYPE: "${key}" must be an array.`);
        }
        result.mode = 'evidence';
        result.meta = payload;
        const blocking = violations.filter((v) => !v.startsWith('MULTIPLE_'));
        result.status = blocking.length === 0 ? 'OK' : 'INVALID';
        return result;
    }

    if (csvFences.length === 0 || jsonFences.length === 0) {
        const outside = text.replace(/```[\s\S]*?```/g, '').trim();
        if (REFUSAL_PATTERNS.some((p) => p.test(outside))) {
            violations.push('CAPABILITY_REFUSAL: Copilot answered with a refusal instead of the expected block(s).');
        }
        if (csvFences.length === 0) violations.push('MISSING_CSV_BLOCK: no ```csv fence in the reply.');
        if (jsonFences.length === 0) violations.push('MISSING_JSON_BLOCK: no ```json fence in the reply.');
        return result;
    }
    if (csvFences.length > 1) violations.push(`MULTIPLE_CSV_BLOCKS: ${csvFences.length} csv fences; only the first is used.`);
    if (jsonFences.length > 1) violations.push(`MULTIPLE_JSON_BLOCKS: ${jsonFences.length} json fences; only the first is used.`);

    let parsed;
    try {
        parsed = toObjects(parseCsv(csvFences[0].body));
    } catch (e) {
        violations.push(`CSV_PARSE_ERROR: ${e.message}`);
        return result;
    }
    if (parsed.rows.length === 0) violations.push('EMPTY_CSV: the csv block has a header but no data rows.');
    if (parsed.missing.length) violations.push(`CSV_MISSING_COLUMNS: ${parsed.missing.join(', ')}`);
    if (parsed.extra.length) violations.push(`CSV_EXTRA_COLUMNS: ${parsed.extra.join(', ')}`);

    let meta;
    try {
        meta = JSON.parse(jsonFences[0].body);
    } catch (e) {
        violations.push(`JSON_PARSE_ERROR: ${e.message}`);
        return result;
    }
    for (const key of ['range', 'discovered_ids', 'verify', 'assumptions']) {
        if (meta[key] === undefined) violations.push(`JSON_MISSING_KEY: "${key}" is required (use an empty array if there is nothing).`);
    }
    for (const key of ['discovered_ids', 'verify', 'assumptions', 'context_only', 'evidence_notes']) {
        if (meta[key] !== undefined && !Array.isArray(meta[key])) violations.push(`JSON_BAD_TYPE: "${key}" must be an array.`);
    }

    result.mode = 'legacy';
    result.rows = parsed.rows;
    result.header = parsed.header;
    result.meta = meta;
    // MULTIPLE_* are warnings: the first block of each kind is still usable.
    const blocking = violations.filter((v) => !v.startsWith('MULTIPLE_'));
    result.status = blocking.length === 0 ? 'OK' : 'INVALID';
    return result;
}

module.exports = { classifyResponse, parseCsv, extractFences, REQUIRED_COLUMNS };
