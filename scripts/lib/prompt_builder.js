const fs = require('fs');
const path = require('path');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function knownIdsBlock({ local, crm, aliases }) {
    const byId = new Map();
    for (const c of crm.cases || []) {
        if (!c.caseId) continue;
        if (!byId.has(c.caseId)) byId.set(c.caseId, { id: c.caseId, client: c.client, title: c.title, sources: [] });
        const entry = byId.get(c.caseId);
        if (!entry.client) entry.client = c.client;
        if (!entry.title) entry.title = c.title;
        entry.sources.push(`CRM (${c.status || 'open'})`);
    }
    for (const c of local.cases) {
        if (!c.caseId) continue;
        if (!byId.has(c.caseId)) byId.set(c.caseId, { id: c.caseId, client: c.client, title: c.title, sources: [] });
        byId.get(c.caseId).sources.push('local case folder');
    }

    // Work with no case ID still has to be billed, so surface those folders too.
    const unnumbered = local.cases.filter((c) => !c.caseId).map((c) => `- (no ID) ${c.client} - ${c.title}`);

    const lines = [...byId.values()]
        .sort((a, b) => `${a.client}${a.id}`.localeCompare(`${b.client}${b.id}`))
        .map((e) => `- ${e.id} | ${e.client || 'unknown client'} | ${e.title || ''} | seen in: ${[...new Set(e.sources)].join(', ')}`);

    const out = [];
    out.push(lines.length ? lines.join('\n') : '- (none found locally or in the CRM)');
    if (unnumbered.length) {
        out.push('');
        out.push('Work items without a case number (bill under the client, Tickets/Cases = "N/A"):');
        out.push(unnumbered.join('\n'));
    }
    if (Object.keys(aliases || {}).length) {
        out.push('');
        out.push('Client folder names on disk map to these client names:');
        out.push(Object.entries(aliases).map(([k, v]) => `- ${k} = ${v}`).join('\n'));
    }
    return out.join('\n');
}

const MAX_COMMITS_SHOWN = 6;
const MAX_FILES_SHOWN = 6;
const DEFAULT_EVIDENCE_CHARS = 10000;

function localEvidenceBlock(local, range, maxChars) {
    const lines = [];
    for (const date of range.days) {
        const entries = local.byDate[date];
        if (!entries || entries.length === 0) continue;
        lines.push(`${date}:`);
        for (const e of entries) {
            const id = e.caseId ? `${e.caseId} ` : '';
            lines.push(`  - ${e.client} | ${id}${e.title}`);
            for (const c of e.commits.slice(0, MAX_COMMITS_SHOWN)) lines.push(`      commit ${c}`);
            if (e.commits.length > MAX_COMMITS_SHOWN) lines.push(`      commit ... and ${e.commits.length - MAX_COMMITS_SHOWN} more that day`);
            if (e.files.length) {
                lines.push(`      files touched (${e.fileCount}): ${e.files.slice(0, MAX_FILES_SHOWN).join(', ')}${e.fileCount > MAX_FILES_SHOWN ? ', ...' : ''}`);
            }
        }
    }
    if (lines.length === 0) return '(no local git or file activity found in this range)';

    // A composer that silently truncates the prompt would cut off the output
    // contract, so keep this section bounded rather than discovering it later.
    const block = lines.join('\n');
    return block.length > maxChars
        ? `${block.slice(0, maxChars)}\n... (local evidence truncated to keep the prompt within a safe length)`
        : block;
}

const MAX_CRM_CASES_SHOWN = 60;
const MAX_COMMENTS_PER_CASE = 4;
const MAX_STATUS_CHANGES_PER_CASE = 5;

function crmCasesBlock(crm, maxChars) {
    // Warnings are written for the console and may name local profile paths, so
    // they are scrubbed before they can reach the prompt.
    const scrub = (s) => String(s).replace(/[A-Za-z]:[\\/][^\s"']*/g, '<local path>');
    if (!crm.ok) {
        return `(CRM case list unavailable: ${scrub((crm.warnings || []).join(' ')) || 'not configured'})`;
    }
    const lines = [`Source: ${scrub(crm.source)}. ${crm.cases.length} case(s).`];
    for (const c of crm.cases.slice(0, MAX_CRM_CASES_SHOWN)) {
        const active = c.activeDays?.length ? ` | I touched it on: ${c.activeDays.join(', ')}` : '';
        lines.push(`- ${c.caseId} | ${c.client || 'unknown client'} | ${c.title} | status: ${c.status} | owner: ${c.owner} | last modified: ${String(c.modifiedOn).slice(0, 10)}${active}`);

        // The status-comment history is the closest thing the CRM has to a diary:
        // it is what the consultant wrote about the case, dated.
        const statusChanges = (c.changes || []).filter((ch) => ch.statusComment);
        for (const ch of statusChanges.slice(0, MAX_STATUS_CHANGES_PER_CASE)) {
            lines.push(`    ${ch.day} ${ch.time} status comment set to: "${ch.to || '(cleared)'}"`);
        }
        if (statusChanges.length > MAX_STATUS_CHANGES_PER_CASE) {
            lines.push(`    ... and ${statusChanges.length - MAX_STATUS_CHANGES_PER_CASE} more status comment change(s)`);
        }

        const otherChanges = (c.changes || []).filter((ch) => !ch.statusComment);
        if (otherChanges.length) {
            const days = [...new Set(otherChanges.map((ch) => ch.day))].join(', ');
            lines.push(`    other field updates on: ${days}`);
        }

        for (const pc of (c.portalComments || []).slice(0, MAX_COMMENTS_PER_CASE)) {
            const who = pc.author ? ` by ${pc.author}` : '';
            lines.push(`    ${pc.day} ${pc.time} portal comment (${pc.direction || 'unknown'})${who}: ${pc.subject ? `${pc.subject} - ` : ''}${pc.body || '(no text)'}`);
        }
        if ((c.portalComments || []).length > MAX_COMMENTS_PER_CASE) {
            lines.push(`    ... and ${c.portalComments.length - MAX_COMMENTS_PER_CASE} more portal comment(s)`);
        }
    }
    if (crm.cases.length > MAX_CRM_CASES_SHOWN) lines.push(`- ... and ${crm.cases.length - MAX_CRM_CASES_SHOWN} more`);

    const block = lines.join('\n');
    return block.length > maxChars
        ? `${block.slice(0, maxChars)}\n... (CRM evidence truncated to keep the prompt within a safe length)`
        : block;
}

/**
 * @param {object} opts { template, config, range, local, crm, objective, prefix }
 * @returns {string}
 */
function buildPrompt({ template, config, range, local, crm, objective, prefix = '' }) {
    if (!objective || !String(objective).trim()) throw new Error('buildPrompt requires a non-empty objective.');

    const aliasEntries = Object.entries(config.CLIENT_ALIASES || {});
    const budget = Number(config.PROMPT_EVIDENCE_CHARS || DEFAULT_EVIDENCE_CHARS);
    const replacements = {
        OBJECTIVE_OVERRIDE: objective,
        USER_NAME: config.USER_NAME,
        USER_EMAIL: config.USER_EMAIL,
        TIMEZONE: range.timezone || config.TIMEZONE,
        RANGE_START: range.start,
        RANGE_END: range.end,
        WORKING_DAYS_LIST: (config.WORKING_DAYS || []).map((d) => DAY_NAMES[d]).join(', '),
        WORKING_DAY_DATES: range.workingDays.join(', ') || '(none)',
        HOURS_PER_DAY: Number(config.HOURS_PER_DAY).toFixed(2),
        INCLUDE_NON_BILLABLE: config.INCLUDE_NON_BILLABLE === false ? 'No' : 'Yes',
        ALIAS_LIST: aliasEntries.length ? aliasEntries.map(([k, v]) => `${k} = ${v}`).join('; ') : '(none)',
        INTERNAL_SYSTEMS_CLIENT: config.INTERNAL_SYSTEMS_CLIENT || 'Internal Systems',
        KNOWN_IDS_BLOCK: knownIdsBlock({ local, crm, aliases: config.FOLDER_TO_CLIENT }),
        LOCAL_EVIDENCE_BLOCK: localEvidenceBlock(local, range, budget),
        CRM_CASES_BLOCK: crmCasesBlock(crm, budget)
    };

    let rendered = template;
    for (const [key, value] of Object.entries(replacements)) {
        rendered = rendered.split(`{{${key}}}`).join(String(value));
    }

    const leftovers = [...new Set(rendered.match(/{{[A-Z0-9_]+}}/g) || [])];
    if (leftovers.length > 0) {
        throw new Error(`Prompt template still contains unresolved placeholders: ${leftovers.join(', ')}`);
    }

    // Same guard as m365-case-intake: a local absolute path in the prompt is what
    // makes Copilot answer "I cannot access your local drive" and abandon the task.
    if (/[A-Za-z]:[\\/]{1,2}Users[\\/]/.test(rendered)) {
        throw new Error('Refusing to send a prompt that contains a local absolute filesystem path.');
    }

    return prefix ? `${prefix}${rendered}` : rendered;
}

function loadTemplate(rootDir) {
    return fs.readFileSync(path.join(rootDir, 'prompts', 'base_timesheet.yaml'), 'utf8');
}

function savePrompt(text, promptPath) {
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, text, 'utf8');
}

module.exports = { buildPrompt, loadTemplate, savePrompt, knownIdsBlock, localEvidenceBlock, crmCasesBlock };
