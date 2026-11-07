#!/usr/bin/env node
/**
 * Main entry point.
 *
 *   npm run timesheet -- "last week"
 *   npm run timesheet -- 2026-08-24..2026-08-28
 *   npm run timesheet -- "this month" --dry-run
 *
 * Flags:
 *   --dry-run       collect evidence and render the prompt, do not call Copilot
 *   --from-file X   skip Copilot and validate an existing captured reply
 *   --no-crm        skip the CRM lookup
 *   --hours N       override the daily quota for this run
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const { loadConfig } = require('./lib/config');
const { parseRange } = require('./lib/date_range');
const { collectLocalEvidence } = require('./lib/local_evidence');
const { collectCrmCases } = require('./lib/dataverse_cases');
const { buildPrompt, loadTemplate, savePrompt } = require('./lib/prompt_builder');
const { classifyResponse } = require('./lib/response_contract');
const { composeTimesheetRows } = require('./lib/compose_timesheet');
const { validate } = require('./lib/validator');
const { reconcile } = require('./lib/reconcile');
const { renderReport, writeOutputs, mdTable } = require('./lib/render');

const EXIT = { OK: 0, INVALID: 1, RECONCILE: 2, FAILURE: 3 };

const START = Date.now();
const stamp = () => `[${new Date().toTimeString().slice(0, 8)} +${((Date.now() - START) / 1000).toFixed(1).padStart(6, ' ')}s]`;
const log = (m) => console.log(`${stamp()} ${m}`);

const OBJECTIVE = [
    'In this single run, search my Microsoft 365 work environment for the given date range,',
    'recover evidence items with date/client/work-item attribution and estimated effort,',
    'and print only the evidence JSON block defined in the OUTPUT CONTRACT. Do not ask questions and do not add prose.'
].join(' ');

function parseArgs(argv) {
    const flags = { dryRun: false, fromFile: null, noCrm: false, hours: null };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') flags.dryRun = true;
        else if (a === '--no-crm') flags.noCrm = true;
        else if (a === '--from-file') flags.fromFile = argv[++i];
        else if (a === '--hours') flags.hours = Number(argv[++i]);
        else positional.push(a);
    }
    return { flags, positional };
}

(async () => {
    const { flags, positional } = parseArgs(process.argv.slice(2));
    const config = loadConfig(rootDir);
    if (flags.hours) config.HOURS_PER_DAY = flags.hours;

    if (positional.length === 0) {
        console.error('Usage: npm run timesheet -- "last week"   |   npm run timesheet -- 2026-08-24..2026-08-28');
        process.exit(EXIT.FAILURE);
    }

    const range = parseRange(positional, { timezone: config.TIMEZONE, workingDays: config.WORKING_DAYS });
    log(`[INFO] Range ${range.start}..${range.end} (${range.timezone}) - ${range.workingDays.length} working day(s), expected ${(range.workingDays.length * config.HOURS_PER_DAY).toFixed(2)} h`);
    if (range.crossesMonthBoundary) log(`[WARN] The range crosses a month boundary: ${range.months.map((m) => `${m.start}..${m.end}`).join(' | ')}. Per-month CSVs will also be written.`);

    let crm = { ok: false, cases: [], knownIds: [], warnings: ['CRM lookup skipped (--no-crm).'], source: 'skipped' };
    if (!flags.noCrm) {
        log('[INFO] Querying the CRM view for cases you are working on ...');
        crm = await collectCrmCases(config, range);
        log(crm.ok ? `[INFO] CRM: ${crm.cases.length} case(s) via ${crm.source}.` : `[WARN] CRM unavailable: ${crm.warnings.join(' ')}`);
    }

    log(`[INFO] Scanning local case folders under ${config.CASES_ROOT} (secondary corroboration) ...`);
    const local = collectLocalEvidence({
        casesRoot: config.CASES_ROOT,
        range,
        ignoreFolders: config.IGNORE_FOLDERS,
        folderToClient: config.FOLDER_TO_CLIENT
    });
    log(`[INFO] ${local.cases.length} case folder(s) with activity out of ${local.scanned} scanned; ${local.knownIds.length} case ID(s).`);

    const prompt = buildPrompt({ template: loadTemplate(rootDir), config, range, local, crm, objective: OBJECTIVE });
    const promptPath = path.join(rootDir, 'logs', 'latest_prompt.md');
    savePrompt(prompt, promptPath);
    log(`[INFO] Prompt rendered (${prompt.length} chars) -> ${promptPath}`);

    if (flags.dryRun) {
        console.log('\nDry run: nothing was sent to M365 Copilot. Review the prompt above.');
        process.exit(EXIT.OK);
    }

    const responsePath = flags.fromFile ? path.resolve(flags.fromFile) : path.join(rootDir, 'logs', 'latest_response.md');
    if (!flags.fromFile) {
        const { runCopilot } = require('./lib/playwright_runner');
        const runnerOptions = {
            profileDir: config.BROWSER_PROFILE_DIR || undefined,
            replyTimeoutMinutes: config.COPILOT_REPLY_TIMEOUT_MINUTES
        };
        try {
            await runCopilot(prompt, responsePath, runnerOptions);
        } catch (e) {
            const code = e && e.code ? e.code : '';
            if (code === 'OPUS_LIMIT_REACHED' || code === 'OPUS_MODEL_UNAVAILABLE') {
                log('[WARN] Opus is unavailable for this run. Retrying once with default/current model selection ...');
                await runCopilot(prompt, responsePath, { ...runnerOptions, skipModelSelection: true });
            } else {
                throw e;
            }
        }
    } else {
        log(`[INFO] Using the captured reply at ${responsePath} instead of calling Copilot.`);
    }

    if (!fs.existsSync(responsePath)) throw new Error(`No reply was captured at ${responsePath}.`);
    const raw = fs.readFileSync(responsePath, 'utf8');

    log('[INFO] Checking the reply against the output contract ...');
    const contract = classifyResponse(raw);
    for (const v of contract.violations) console.error(`  [CONTRACT] ${v}`);
    if (contract.status === 'INVALID') {
        console.error(`\nRun FAILED: the reply broke the output contract. Nothing was written. Raw reply kept at ${responsePath}.`);
        process.exit(EXIT.INVALID);
    }
    const composed = contract.mode === 'evidence'
        ? composeTimesheetRows({ evidence: contract.meta, range, config, crm, local })
        : { rows: contract.rows, meta: contract.meta };

    log('[INFO] Validating hours, totals and description lengths locally ...');
    const validation = validate(composed.rows, {
        range,
        hoursPerDay: config.HOURS_PER_DAY,
        workingDays: config.WORKING_DAYS,
        includeNonBillable: config.INCLUDE_NON_BILLABLE
    });
    for (const e of validation.errors) console.error(`  [INVALID] ${e}`);
    for (const w of validation.warnings) console.error(`  [warn]    ${w}`);

    log('[INFO] Reconciling against local git history and the CRM ...');
    const reconciliation = reconcile({ rows: composed.rows, meta: composed.meta, local, crm, range, config });
    for (const f of reconciliation.findings) {
        const tag = f.severity === 'blocking' ? '[BLOCKING]' : f.severity === 'check' ? '[CHECK]   ' : '[info]    ';
        console.error(`  ${tag} ${f.code} ${f.date || ''} ${f.message}`);
    }

    const report = renderReport({
        rows: composed.rows,
        meta: composed.meta,
        validation,
        reconciliation,
        range,
        config,
        crm,
        local,
        promptChars: prompt.length
    });
    const written = writeOutputs({ outDir: path.join(rootDir, 'output'), range, rows: composed.rows, report });

    console.log('');
    log(`[INFO] CSV    -> ${written.csvPath}`);
    for (const p of written.monthCsvPaths) log(`[INFO] CSV    -> ${p}  (month split)`);
    log(`[INFO] Report -> ${written.mdPath}`);
    console.log('');
    if (config.SHOW_TIMESHEET_IN_CHAT !== false) {
        console.log('Generated timesheet:');
        console.log(mdTable(composed.rows));
        console.log('');
    }

    if (!validation.ok) {
        console.error('Timesheet written but INVALID: the numbers do not tie out. Fix the flagged rows before submitting.');
        process.exit(EXIT.INVALID);
    }
    if (reconciliation.counts.blocking > 0) {
        console.error(`Timesheet written but ${reconciliation.counts.blocking} blocking reconciliation finding(s): local work is missing from it. Review section E.`);
        process.exit(EXIT.RECONCILE);
    }
    console.log(`Timesheet complete: ${validation.totals.period.toFixed(2)} h (${validation.totals.billable.toFixed(2)} billable / ${validation.totals.nonBillable.toFixed(2)} non-billable) across ${composed.rows.length} rows.`);
    if (reconciliation.counts.check > 0) console.log(`${reconciliation.counts.check} item(s) to check before submitting - see section E of the report.`);
    process.exit(EXIT.OK);
})().catch((e) => {
    console.error(`\nRun FAILED: ${e && e.stack ? e.stack : e}`);
    process.exit(EXIT.FAILURE);
});
