/**
 * Renders the final deliverables locally: the CSV file the user pastes into the
 * timesheet system, and a markdown report with sections A-E.
 */

const fs = require('fs');
const path = require('path');
const { REQUIRED_COLUMNS } = require('./response_contract');

const csvCell = (v) => {
    const s = String(v === undefined || v === null ? '' : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows) {
    const lines = [REQUIRED_COLUMNS.join(',')];
    for (const row of rows) lines.push(REQUIRED_COLUMNS.map((c) => csvCell(row[c])).join(','));
    return `${lines.join('\n')}\n`;
}

const mdCell = (v) => String(v === undefined || v === null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function mdTable(rows) {
    const out = [`| ${REQUIRED_COLUMNS.join(' | ')} |`, `| ${REQUIRED_COLUMNS.map(() => '---').join(' | ')} |`];
    for (const row of rows) out.push(`| ${REQUIRED_COLUMNS.map((c) => mdCell(row[c])).join(' | ')} |`);
    return out.join('\n');
}

function renderReport({ rows, meta, validation, reconciliation, range, config, crm, local, promptChars }) {
    const t = validation.totals;
    const h = (n) => Number(n).toFixed(2);
    const out = [];

    out.push(`# Timesheet ${range.label}`);
    out.push('');
    out.push(`- Consultant: ${config.USER_NAME} <${config.USER_EMAIL}>`);
    out.push(`- Range: ${range.start} to ${range.end} (${range.timezone}), ${range.workingDays.length} working day(s)`);
    out.push(`- Daily quota: ${h(config.HOURS_PER_DAY)} h - expected period total ${h(t.expectedWorkingHours)} h`);
    const worktreeFoldCount = local.cases.reduce((sum, c) => sum + (c.linkedWorktrees ? c.linkedWorktrees.length : 0), 0);
    const worktreeNote = worktreeFoldCount ? ` (incl. ${worktreeFoldCount} linked worktree folder(s) folded in)` : '';
    out.push(`- Evidence: M365 Copilot (Claude Opus), ${local.cases.length} local case folder(s) with activity${worktreeNote}, CRM: ${crm.ok ? crm.source : 'unavailable'}`);
    if (range.crossesMonthBoundary) {
        out.push(`- **This range crosses a month boundary.** Submit it as ${range.months.map((m) => `${m.start}..${m.end}`).join(' and ')}; per-month CSVs were written alongside the full one.`);
    }
    out.push('');

    out.push('## A) Timesheet');
    out.push('');
    out.push(mdTable(rows));
    out.push('');

    out.push('## B) Roll-ups');
    out.push('');
    out.push('### Daily');
    out.push('');
    out.push('| Date | Hours | Quota | Status |');
    out.push('| --- | --- | --- | --- |');
    for (const day of range.days) {
        const total = t.byDate[day];
        if (total === undefined && !range.workingDays.includes(day)) continue;
        const quota = range.workingDays.includes(day) ? h(config.HOURS_PER_DAY) : '-';
        const ok = range.workingDays.includes(day) ? (Number(total || 0).toFixed(2) === h(config.HOURS_PER_DAY) ? 'OK' : 'MISMATCH') : 'non-working day';
        out.push(`| ${day} | ${h(total || 0)} | ${quota} | ${ok} |`);
    }
    out.push('');
    out.push('### By client');
    out.push('');
    out.push('| Client | Hours |');
    out.push('| --- | --- |');
    for (const [client, hours] of Object.entries(t.byClient)) out.push(`| ${client} | ${h(hours)} |`);
    out.push(`| **Total** | **${h(t.period)}** |`);
    out.push('');
    out.push(`- Billable: ${h(t.billable)} h`);
    out.push(`- Non-billable: ${h(t.nonBillable)} h`);
    out.push(`- Period total: ${h(t.period)} h (expected ${h(t.expectedWorkingHours)} h + ${h(t.nonWorkingDayHours)} h on non-working days)`);
    out.push('');
    out.push(validation.ok
        ? '**Validation passed:** all hours use 0.25 increments and two decimals, every working day ties to the quota, each day has at most one row per client, and every description is <= 255 characters.'
        : '**Validation FAILED:**');
    for (const e of validation.errors) out.push(`- ERROR: ${e}`);
    for (const w of validation.warnings) out.push(`- warning: ${w}`);
    out.push('');

    out.push('## C) CSV export');
    out.push('');
    out.push('```csv');
    out.push(toCsv(rows).trimEnd());
    out.push('```');
    out.push('');

    out.push('## D) Discovered IDs');
    out.push('');
    const discovered = meta.discovered_ids || [];
    if (discovered.length === 0) {
        out.push('No discovered IDs found.');
    } else {
        out.push('| ID | Possible client | Date | Evidence | Context | Recommendation | Status |');
        out.push('| --- | --- | --- | --- | --- | --- | --- |');
        for (const d of discovered) {
            out.push(`| ${mdCell(d.id)} | ${mdCell(d.client)} | ${mdCell(d.date)} | ${mdCell(d.evidence)} | ${mdCell(d.context)} | ${mdCell(d.recommendation)} | ${mdCell(d.status || 'Pending user confirmation')} |`);
        }
    }
    out.push('');

    out.push('## E) Reconciliation against local and CRM evidence');
    out.push('');
    out.push(`${reconciliation.counts.blocking} blocking, ${reconciliation.counts.check} to check, ${reconciliation.counts.info} informational.`);
    out.push('');
    if (reconciliation.findings.length === 0) {
        out.push('Nothing to reconcile: the timesheet accounts for every case with local activity in the range.');
    } else {
        out.push('| Severity | Code | Date | Client | Finding |');
        out.push('| --- | --- | --- | --- | --- |');
        for (const f of reconciliation.findings) {
            out.push(`| ${f.severity} | ${f.code} | ${f.date || ''} | ${mdCell(f.client)} | ${mdCell(f.message)} |`);
        }
    }
    out.push('');

    out.push('## F) Assumptions and items to verify');
    out.push('');
    out.push(`- Defaults used: quota ${h(config.HOURS_PER_DAY)} h/day, timezone ${range.timezone}, working days ${(config.WORKING_DAYS || []).join(',')}, non-billable ${config.INCLUDE_NON_BILLABLE === false ? 'excluded' : 'included'}.`);
    for (const a of meta.assumptions || []) out.push(`- ${a}`);
    for (const n of meta.needs_case_confirmation || []) {
        out.push(`- CASE ID CONFIRMATION: ${n.date || ''} ${n.client || ''} ${n.item || n.description || ''}`.trim());
    }
    for (const v of meta.verify || []) out.push(`- VERIFY ${v.date || ''} ${v.client || ''}: ${v.reason || ''}`);
    for (const c of meta.context_only || []) out.push(`- Context only (no hours): ${c.item || ''} - ${c.why || ''}`);
    for (const n of meta.evidence_notes || []) out.push(`- Evidence ${n.date || ''}: ${n.note || ''}`);
    for (const w of crm.warnings || []) out.push(`- CRM: ${w}`);
    out.push('');
    out.push('### Description lengths');
    out.push('');
    out.push(validation.descriptionLengths.map((d) => `${d.date} ${d.client}: ${d.length}`).join(' · '));
    out.push('');
    const longest = Math.max(0, ...validation.descriptionLengths.map((d) => d.length));
    out.push(longest <= 255
        ? `Description length check passed: all rows <= 255 chars (longest ${longest}).`
        : `Description length check FAILED: longest row is ${longest} chars.`);
    out.push('');
    out.push(`Prompt sent to M365 Copilot: ${promptChars} characters.`);
    out.push('');

    return out.join('\n');
}

function writeOutputs({ outDir, range, rows, report }) {
    fs.mkdirSync(outDir, { recursive: true });
    const base = `timesheet-${range.start}_${range.end}`;
    const csvPath = path.join(outDir, `${base}.csv`);
    const mdPath = path.join(outDir, `${base}.md`);
    fs.writeFileSync(csvPath, toCsv(rows), 'utf8');
    fs.writeFileSync(mdPath, report, 'utf8');

    const extra = [];
    if (range.crossesMonthBoundary) {
        for (const m of range.months) {
            const monthRows = rows.filter((r) => r.Date >= m.start && r.Date <= m.end);
            if (monthRows.length === 0) continue;
            const p = path.join(outDir, `${base}--${m.month}.csv`);
            fs.writeFileSync(p, toCsv(monthRows), 'utf8');
            extra.push(p);
        }
    }
    return { csvPath, mdPath, monthCsvPaths: extra };
}

module.exports = { renderReport, writeOutputs, toCsv, mdTable };
