#!/usr/bin/env node
/**
 * Re-validate and re-render a reply that was already captured, without calling
 * M365 Copilot again. Useful after a manual salvage of logs/latest_response.md.
 *
 *   npm run parse -- "last week" [path/to/response.md]
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config');
const { parseRange } = require('./lib/date_range');
const { collectLocalEvidence } = require('./lib/local_evidence');
const { collectCrmCases } = require('./lib/dataverse_cases');
const { classifyResponse } = require('./lib/response_contract');
const { composeTimesheetRows } = require('./lib/compose_timesheet');
const { validate } = require('./lib/validator');
const { reconcile } = require('./lib/reconcile');
const { renderReport, writeOutputs } = require('./lib/render');

const rootDir = path.join(__dirname, '..');

(async () => {
    const config = loadConfig(rootDir);
    const argv = process.argv.slice(2);
    const noCrm = argv.includes('--no-crm');
    const args = argv.filter((a) => a !== '--no-crm');
    if (args.length === 0) {
        console.error('Usage: npm run parse -- "last week" [path/to/response.md]');
        process.exit(1);
    }
    const maybePath = args[args.length - 1];
    const responsePath = fs.existsSync(maybePath) && /\.(md|txt)$/i.test(maybePath)
        ? path.resolve(args.pop())
        : path.join(rootDir, 'logs', 'latest_response.md');

    const range = parseRange(args, { timezone: config.TIMEZONE, workingDays: config.WORKING_DAYS });
    const contract = classifyResponse(fs.readFileSync(responsePath, 'utf8'));
    for (const v of contract.violations) console.error(`[CONTRACT] ${v}`);
    if (contract.status === 'INVALID') process.exit(1);

    const local = collectLocalEvidence({ casesRoot: config.CASES_ROOT, range, ignoreFolders: config.IGNORE_FOLDERS, folderToClient: config.FOLDER_TO_CLIENT });
    const crm = noCrm ? { ok: false, cases: [], knownIds: [], warnings: ['skipped'], source: 'skipped' } : await collectCrmCases(config, range);

    const composed = contract.mode === 'evidence'
        ? composeTimesheetRows({ evidence: contract.meta, range, config, crm, local })
        : { rows: contract.rows, meta: contract.meta };
    const validation = validate(composed.rows, { range, hoursPerDay: config.HOURS_PER_DAY, workingDays: config.WORKING_DAYS, includeNonBillable: config.INCLUDE_NON_BILLABLE });
    const reconciliation = reconcile({ rows: composed.rows, meta: composed.meta, local, crm, range, config });
    const report = renderReport({ rows: composed.rows, meta: composed.meta, validation, reconciliation, range, config, crm, local, promptChars: 0 });
    const written = writeOutputs({ outDir: path.join(rootDir, 'output'), range, rows: composed.rows, report });

    for (const e of validation.errors) console.error(`[INVALID] ${e}`);
    for (const f of reconciliation.findings) console.error(`[${f.severity}] ${f.code} ${f.date || ''} ${f.message}`);
    console.log(`\nCSV    -> ${written.csvPath}\nReport -> ${written.mdPath}`);
    process.exit(validation.ok ? (reconciliation.counts.blocking ? 2 : 0) : 1);
})().catch((e) => {
    console.error(`Failed: ${e.message}`);
    process.exit(1);
});
