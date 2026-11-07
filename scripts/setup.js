#!/usr/bin/env node
/**
 * First-run setup: builds config.json interactively, then opens a visible
 * browser so the user can sign in to M365 Copilot once. The login is stored in
 * the shared Copilot browser profile, so it is reused by every later run.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rootDir = path.join(__dirname, '..');
const { saveConfig, configPath, DEFAULTS } = require('./lib/config');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => new Promise((resolve) => {
    rl.question(def === undefined || def === '' ? `${q}: ` : `${q} [${def}]: `, (a) => resolve(a.trim() || String(def === undefined ? '' : def)));
});
const askBool = async (q, def) => /^(y|yes|s|si|sí|true|1)$/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseWorkingDays(input) {
    const tokens = String(input).split(/[,\s]+/).filter(Boolean);
    const days = tokens.map((t) => {
        if (/^\d$/.test(t)) return Number(t);
        const i = DAY_NAMES.findIndex((d) => d.toLowerCase() === t.slice(0, 3).toLowerCase());
        if (i < 0) throw new Error(`Unrecognised weekday "${t}".`);
        return i;
    });
    return [...new Set(days)].sort();
}

function parsePairs(input) {
    const out = {};
    for (const part of String(input).split(';').map((s) => s.trim()).filter(Boolean)) {
        const [k, ...rest] = part.split('=');
        if (!k || rest.length === 0) continue;
        out[k.trim()] = rest.join('=').trim();
    }
    return out;
}

(async () => {
    console.log('\nm365-timesheet setup\n====================\n');

    const existing = fs.existsSync(configPath(rootDir)) ? JSON.parse(fs.readFileSync(configPath(rootDir), 'utf8')) : {};
    const d = { ...DEFAULTS, ...existing };

    const config = {};
    config.USER_NAME = await ask('Your full name', d.USER_NAME);
    config.USER_EMAIL = await ask('Your work email (the M365 account)', d.USER_EMAIL);
    config.TIMEZONE = await ask('Timesheet timezone (the one hours are reported in)', d.TIMEZONE || 'US/Eastern');
    config.HOURS_PER_DAY = Number(await ask('Hours per working day', d.HOURS_PER_DAY || 8));
    config.WORKING_DAYS = parseWorkingDays(await ask('Working days (0=Sun..6=Sat, or Mon,Tue,...)', (d.WORKING_DAYS || [1, 2, 3, 4, 5]).join(',')));
    config.INCLUDE_NON_BILLABLE = await askBool('Include non-billable internal time by default?', d.INCLUDE_NON_BILLABLE !== false);

    console.log('\nLocal case folders\n------------------');
    config.CASES_ROOT = (await ask('Root folder that holds one subfolder per client', d.CASES_ROOT)).replace(/\\/g, '/');
    if (!fs.existsSync(config.CASES_ROOT)) console.log(`  ! warning: ${config.CASES_ROOT} does not exist yet.`);
    config.IGNORE_FOLDERS = (await ask('Client folders to ignore (comma separated, blank for none)', (d.IGNORE_FOLDERS || []).join(','))).split(',').map((s) => s.trim()).filter(Boolean);
    config.RECENT_CASE_DAYS = Number(await ask('How many days back do case folders usually keep a local git repo?', d.RECENT_CASE_DAYS || 7));
    config.FOLDER_TO_CLIENT = parsePairs(await ask('Folder-name to client-name map, "Folder=Client Name" separated by ;', Object.entries(d.FOLDER_TO_CLIENT || {}).map(([k, v]) => `${k}=${v}`).join(';')));
    config.CLIENT_ALIASES = parsePairs(await ask('Client aliases used in mail/meetings, "ALIAS=Client" separated by ;', Object.entries(d.CLIENT_ALIASES || {}).map(([k, v]) => `${k}=${v}`).join(';')));

    console.log('\nCRM (optional, used to list the cases you are working on)\n--------------------------------------------------------');
    config.CRM_URL = await ask('CRM org URL (blank to skip)', d.CRM_URL);
    if (config.CRM_URL) {
        config.CRM_USER_EMAIL = await ask('CRM account email', d.CRM_USER_EMAIL || config.USER_EMAIL);
        config.CRM_AZURE_CONFIG_DIR = (await ask('AZURE_CONFIG_DIR for that tenant (blank for the default)', d.CRM_AZURE_CONFIG_DIR)).replace(/\\/g, '/');
        config.CRM_VIEW_ID = await ask('Saved view GUID for "cases I am working on" (blank to use the built-in query)', d.CRM_VIEW_ID);
    } else {
        config.CRM_USER_EMAIL = '';
        config.CRM_AZURE_CONFIG_DIR = '';
        config.CRM_VIEW_ID = '';
    }

    config.BROWSER_PROFILE_DIR = d.BROWSER_PROFILE_DIR || '';

    saveConfig(rootDir, config);
    console.log(`\nWrote ${configPath(rootDir)}\n`);
    console.log(JSON.stringify(config, null, 2));

    const login = await askBool('\nOpen a browser now to sign in to M365 Copilot?', true);
    rl.close();

    if (!login) {
        console.log('\nSkipped. Run "npm run setup" again when you need to sign in.');
        return;
    }

    const { chromium } = (() => {
        try { return require('playwright'); } catch (e) {
            return require(path.join(rootDir, '..', 'm365-case-intake', 'node_modules', 'playwright'));
        }
    })();
    const profileDir = config.BROWSER_PROFILE_DIR || path.join(process.env.LOCALAPPDATA || rootDir, 'CopilotDailyProfile');
    console.log(`\nLaunching Edge with the profile at ${profileDir}.`);
    console.log('Sign in, confirm the chat loads, then CLOSE the browser window to finish.\n');
    const context = await chromium.launchPersistentContext(profileDir, { headless: false, channel: 'msedge', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto('https://m365.cloud.microsoft/chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((resolve) => context.on('close', resolve));
    console.log('Browser closed. Setup complete.');
})().catch((e) => {
    try { rl.close(); } catch (ignored) { /* already closed */ }
    console.error(`\nSetup failed: ${e.message}`);
    process.exit(1);
});
