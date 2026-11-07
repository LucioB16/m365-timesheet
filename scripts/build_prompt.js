#!/usr/bin/env node
/** Renders the prompt for a range without calling M365 Copilot. */

const path = require('path');
const { loadConfig } = require('./lib/config');
const { parseRange } = require('./lib/date_range');
const { collectLocalEvidence } = require('./lib/local_evidence');
const { collectCrmCases } = require('./lib/dataverse_cases');
const { buildPrompt, loadTemplate, savePrompt } = require('./lib/prompt_builder');

const rootDir = path.join(__dirname, '..');

const OBJECTIVE = 'Render only. This prompt was produced by "npm run prompt" and was not sent to M365 Copilot.';

(async () => {
    const config = loadConfig(rootDir);
    const args = process.argv.slice(2).filter((a) => a !== '--no-crm');
    const noCrm = process.argv.includes('--no-crm');
    if (args.length === 0) {
        console.error('Usage: npm run prompt -- "last week" [--no-crm]');
        process.exit(1);
    }
    const range = parseRange(args, { timezone: config.TIMEZONE, workingDays: config.WORKING_DAYS });
    const crm = noCrm
        ? { ok: false, cases: [], knownIds: [], warnings: ['skipped'], source: 'skipped' }
        : await collectCrmCases(config, range);
    const local = collectLocalEvidence({ casesRoot: config.CASES_ROOT, range, ignoreFolders: config.IGNORE_FOLDERS, folderToClient: config.FOLDER_TO_CLIENT });

    const prompt = buildPrompt({ template: loadTemplate(rootDir), config, range, local, crm, objective: OBJECTIVE });
    const promptPath = path.join(rootDir, 'logs', 'latest_prompt.md');
    savePrompt(prompt, promptPath);
    console.log(prompt);
    console.error(`\n[INFO] ${prompt.length} chars, saved to ${promptPath}`);
})().catch((e) => {
    console.error(`Failed: ${e.message}`);
    process.exit(1);
});
