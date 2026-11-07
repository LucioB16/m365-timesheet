const fs = require('fs');
const path = require('path');

const REQUIRED = ['USER_NAME', 'USER_EMAIL', 'TIMEZONE', 'HOURS_PER_DAY', 'WORKING_DAYS', 'CASES_ROOT'];

const DEFAULTS = {
    TIMEZONE: 'US/Eastern',
    HOURS_PER_DAY: 8,
    WORKING_DAYS: [1, 2, 3, 4, 5],
    INCLUDE_NON_BILLABLE: true,
    RECENT_CASE_DAYS: 7,
    IGNORE_FOLDERS: [],
    CLIENT_ALIASES: {},
    FOLDER_TO_CLIENT: {},
    CASE_ID_OVERRIDES: [],
    CRM_URL: '',
    CRM_AZURE_CONFIG_DIR: '',
    CRM_VIEW_ID: '',
    CRM_USER_EMAIL: '',
    CRM_AZURE_CONFIG_DIRS: [],
    CRM_STATUS_COMMENT_FIELD: 'new_xpoinfo',
    CRM_TENANT_ID: '',
    CRM_DETAIL_MAX_CASES: 40,
    PROMPT_EVIDENCE_CHARS: 10000,
    SHOW_TIMESHEET_IN_CHAT: true,
    COPILOT_REPLY_TIMEOUT_MINUTES: 20,
    INTERNAL_SYSTEMS_CLIENT: 'Internal Systems',
    BROWSER_PROFILE_DIR: ''
};

function configPath(rootDir) {
    return path.join(rootDir, 'config.json');
}

function loadConfig(rootDir) {
    const p = configPath(rootDir);
    if (!fs.existsSync(p)) {
        throw new Error("config.json not found. Run 'npm run setup' first.");
    }
    const config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    assertConfig(config);
    return config;
}

function assertConfig(config) {
    const missing = REQUIRED.filter((k) => config[k] === undefined || config[k] === null || config[k] === '');
    if (missing.length > 0) {
        throw new Error(`config.json is missing required keys: ${missing.join(', ')}`);
    }
    if (!Array.isArray(config.WORKING_DAYS) || config.WORKING_DAYS.length === 0) {
        throw new Error('config.json WORKING_DAYS must be a non-empty array of weekday numbers (0=Sun..6=Sat).');
    }
    if (!(Number(config.HOURS_PER_DAY) > 0)) {
        throw new Error('config.json HOURS_PER_DAY must be a positive number.');
    }
    if (!fs.existsSync(config.CASES_ROOT)) {
        throw new Error(`config.json CASES_ROOT does not exist on disk: ${config.CASES_ROOT}`);
    }
    return config;
}

function saveConfig(rootDir, config) {
    fs.writeFileSync(configPath(rootDir), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

module.exports = { loadConfig, saveConfig, assertConfig, configPath, DEFAULTS, REQUIRED };
