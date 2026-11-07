#!/usr/bin/env node
/** Prints the CRM cases you are working on for a range. Read-only. */

const path = require('path');
const { loadConfig } = require('./lib/config');
const { parseRange } = require('./lib/date_range');
const { collectCrmCases } = require('./lib/dataverse_cases');

const rootDir = path.join(__dirname, '..');

(async () => {
    const config = loadConfig(rootDir);
    const args = process.argv.slice(2);
    const range = parseRange(args.length ? args : ['this month'], { timezone: config.TIMEZONE, workingDays: config.WORKING_DAYS });
    const crm = await collectCrmCases(config, range);

    for (const w of crm.warnings) console.error(`[warn] ${w}`);
    if (!crm.ok) process.exit(1);

    console.log(`Source: ${crm.source}`);
    console.log(`User:   ${crm.user ? crm.user.UserId : '?'}`);
    console.log(`Range:  ${range.start}..${range.end}`);
    console.log('');
    for (const c of crm.cases) {
        console.log(`${c.caseId}  ${String(c.modifiedOn).slice(0, 10)}  ${(c.client || '').padEnd(30).slice(0, 30)}  ${c.status.padEnd(14).slice(0, 14)}  ${c.title}`);
    }
    console.log(`\n${crm.cases.length} case(s).`);
})().catch((e) => {
    console.error(`Failed: ${e.message}`);
    process.exit(1);
});
