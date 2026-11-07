const test = require('node:test');
const assert = require('node:assert');
const { reconcile } = require('../scripts/lib/reconcile');
const { parseRange } = require('../scripts/lib/date_range');
const { buildPrompt } = require('../scripts/lib/prompt_builder');

const range = parseRange('2026-08-24..2026-08-25', { timezone: 'UTC', workingDays: [1, 2, 3, 4, 5] });
const config = { FOLDER_TO_CLIENT: {}, CLIENT_ALIASES: {}, USER_NAME: 'X', USER_EMAIL: 'x@y.com', TIMEZONE: 'UTC', HOURS_PER_DAY: 8, WORKING_DAYS: [1, 2, 3, 4, 5], INCLUDE_NON_BILLABLE: true };

const localWith = (byDate, knownIds = []) => ({
    cases: [],
    byDate,
    knownIds,
    scanned: 1,
    clients: []
});
const noCrm = { ok: false, cases: [], knownIds: [], warnings: [], source: 'skipped' };
const meta = { discovered_ids: [], verify: [], assumptions: [] };

const row = (over = {}) => ({
    Date: '2026-08-24',
    Client: 'Acme Corp',
    'Project/Area': 'Power Platform',
    'Tickets/Cases': 'CAS-1000001-A1B1',
    Description: 'CAS-1000001-A1B1: Fixed the loop guard.',
    Hours: '8.00',
    Billable: 'Yes',
    Evidence: '',
    'Comments/Next Steps': '',
    ...over
});

test('commits on a case that is not billed are a blocking finding', () => {
    const local = localWith({
        '2026-08-24': [{ client: 'Acme Corp', caseId: 'CAS-9999999-Z9Z9', title: 'Other case', commits: ['10:00 did a thing'], files: [], fileCount: 0 }]
    }, ['CAS-9999999-Z9Z9']);
    const r = reconcile({ rows: [row()], meta, local, crm: noCrm, range, config });
    const f = r.findings.find((x) => x.code === 'MISSING_LOCAL_WORK');
    assert.ok(f);
    assert.equal(f.severity, 'blocking');
    assert.equal(r.counts.blocking, 1);
});

test('a case with local commits that IS billed produces no missing finding', () => {
    const local = localWith({
        '2026-08-24': [{ client: 'Acme Corp', caseId: 'CAS-1000001-A1B1', title: 'The case', commits: ['10:00 did a thing'], files: [], fileCount: 0 }]
    }, ['CAS-1000001-A1B1']);
    const r = reconcile({ rows: [row()], meta, local, crm: noCrm, range, config });
    assert.equal(r.counts.blocking, 0);
});

test('only touched files, no commits, is a check rather than blocking', () => {
    const local = localWith({
        '2026-08-24': [{ client: 'Umbrella Corp', caseId: 'CAS-1000003-C3D3', title: 'Invoice Capture', commits: [], files: ['notes.md'], fileCount: 1 }]
    }, ['CAS-1000003-C3D3']);
    const r = reconcile({ rows: [row()], meta, local, crm: noCrm, range, config });
    const f = r.findings.find((x) => x.code === 'MISSING_LOCAL_WORK');
    assert.equal(f.severity, 'check');
});

test('an ID that is neither local nor in the CRM is flagged', () => {
    const local = localWith({}, ['CAS-1111111-A1A1']);
    const r = reconcile({ rows: [row()], meta, local, crm: noCrm, range, config });
    assert.ok(r.findings.some((f) => f.code === 'UNKNOWN_ID' && f.caseId === 'CAS-1000001-A1B1'));
});

test('discovered IDs from the model become findings', () => {
    const local = localWith({}, ['CAS-1000001-A1B1']);
    const withDiscovered = { ...meta, discovered_ids: [{ id: 'CAS-7777777-Q1Q1', client: 'Initech LLC', date: '2026-08-25', recommendation: 'Verify' }] };
    const r = reconcile({ rows: [row()], meta: withDiscovered, local, crm: noCrm, range, config });
    const f = r.findings.find((x) => x.code === 'DISCOVERED_ID_CONFIRMATION_REQUIRED' && x.caseId === 'CAS-7777777-Q1Q1');
    assert.ok(f);
    assert.equal(f.severity, 'blocking');
});

test('a CRM case modified in range but never billed is flagged', () => {
    const local = localWith({}, ['CAS-1000001-A1B1']);
    const crm = { ok: true, source: 'test', cases: [{ caseId: 'CAS-2222222-B2B2', client: 'Globex Inc', title: 'Flow issue', status: 'Active', modifiedOn: '2026-08-25T10:00:00Z' }], knownIds: ['CAS-2222222-B2B2'], warnings: [] };
    const r = reconcile({ rows: [row()], meta, local, crm, range, config });
    assert.ok(r.findings.some((f) => f.code === 'CRM_ACTIVITY_NOT_BILLED' && f.caseId === 'CAS-2222222-B2B2'));
});

test('a client day with no local trace is informational only', () => {
    const local = localWith({}, ['CAS-1000001-A1B1']);
    const r = reconcile({ rows: [row()], meta, local, crm: noCrm, range, config });
    const f = r.findings.find((x) => x.code === 'NO_LOCAL_TRACE');
    assert.equal(f.severity, 'info');
});

test('a non-internal row with N/A case id requires confirmation', () => {
    const local = localWith({}, []);
    const rows = [row({ Client: 'Example Properties LLC', 'Tickets/Cases': 'N/A' })];
    const r = reconcile({ rows, meta, local, crm: noCrm, range, config });
    const f = r.findings.find((x) => x.code === 'MISSING_CASE_ID_CONFIRMATION');
    assert.ok(f);
    assert.equal(f.severity, 'blocking');
});

test('buildPrompt refuses to leak a local absolute path', () => {
    const template = 'Root is C:\\Users\\Someone\\Source and the objective is {{OBJECTIVE_OVERRIDE}} for {{USER_NAME}} {{USER_EMAIL}} {{TIMEZONE}} {{RANGE_START}} {{RANGE_END}} {{WORKING_DAYS_LIST}} {{WORKING_DAY_DATES}} {{HOURS_PER_DAY}} {{INCLUDE_NON_BILLABLE}} {{ALIAS_LIST}} {{KNOWN_IDS_BLOCK}} {{LOCAL_EVIDENCE_BLOCK}} {{CRM_CASES_BLOCK}}';
    assert.throws(
        () => buildPrompt({ template, config, range, local: localWith({}), crm: noCrm, objective: 'do it' }),
        /local absolute filesystem path/
    );
});

test('buildPrompt refuses to leave a placeholder unresolved', () => {
    assert.throws(
        () => buildPrompt({ template: 'hello {{NOT_A_REAL_KEY}} {{OBJECTIVE_OVERRIDE}}', config, range, local: localWith({}), crm: noCrm, objective: 'do it' }),
        /unresolved placeholders/
    );
});
