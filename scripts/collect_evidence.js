#!/usr/bin/env node
/** Prints the local evidence for a range as JSON. Reads only; writes nothing. */

const path = require('path');
const { loadConfig } = require('./lib/config');
const { parseRange } = require('./lib/date_range');
const { collectLocalEvidence } = require('./lib/local_evidence');

const rootDir = path.join(__dirname, '..');

try {
    const config = loadConfig(rootDir);
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('Usage: npm run evidence -- "last week"');
        process.exit(1);
    }
    const range = parseRange(args, { timezone: config.TIMEZONE, workingDays: config.WORKING_DAYS });
    const local = collectLocalEvidence({
        casesRoot: config.CASES_ROOT,
        range,
        ignoreFolders: config.IGNORE_FOLDERS,
        folderToClient: config.FOLDER_TO_CLIENT
    });
    console.log(JSON.stringify({
        range: { start: range.start, end: range.end, timezone: range.timezone, workingDays: range.workingDays },
        scanned: local.scanned,
        clients: local.clients,
        knownIds: local.knownIds,
        byDate: local.byDate
    }, null, 2));
} catch (e) {
    console.error(`Failed: ${e.message}`);
    process.exit(1);
}
