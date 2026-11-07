const test = require('node:test');
const assert = require('node:assert');
const { classifyResponse, parseCsv } = require('../scripts/lib/response_contract');

const HEADER = 'Date,Client,Project/Area,Tickets/Cases,Description,Hours,Billable,Evidence,Comments/Next Steps';
const ROW = '2026-08-24,Acme Corp,Power Platform,"CAS-1 ,CAS-2","CAS-1: Fixed the loop. CAS-2: Shipped it.",8.00,Yes,"Teams sync",""';
const META = JSON.stringify({ range: { start: '2026-08-24', end: '2026-08-24', timezone: 'US/Eastern' }, discovered_ids: [], verify: [], assumptions: [], context_only: [], evidence_notes: [] });
const EVIDENCE = JSON.stringify({
    range: { start: '2026-08-24', end: '2026-08-24', timezone: 'US/Eastern' },
    evidence_items: [{ date: '2026-08-24', client: 'Acme Corp', project_area: 'Power Platform', tickets: ['CAS-1'], description: 'Fixed loop.', hours_hint: 2, billable: 'Yes', evidence: ['Teams'] }],
    discovered_ids: [],
    verify: [],
    assumptions: [],
    context_only: [],
    evidence_notes: []
});

const reply = (csv = `${HEADER}\n${ROW}`, json = META) => '```csv\n' + csv + '\n```\n\n```json\n' + json + '\n```';

test('accepts the evidence-only json contract', () => {
    const r = classifyResponse('```json\n' + EVIDENCE + '\n```');
    assert.equal(r.status, 'OK');
    assert.equal(r.mode, 'evidence');
    assert.equal(Array.isArray(r.meta.evidence_items), true);
});

test('the CSV parser honours quotes, embedded commas and doubled quotes', () => {
    const rows = parseCsv('a,b\n"x,y","he said ""hi"""');
    assert.deepEqual(rows[1], ['x,y', 'he said "hi"']);
});

test('accepts a well formed legacy csv+json reply', () => {
    const r = classifyResponse(reply());
    assert.equal(r.status, 'OK');
    assert.equal(r.mode, 'legacy');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].Hours, '8.00');
    assert.equal(r.rows[0]['Tickets/Cases'], 'CAS-1 ,CAS-2');
});

test('rejects a reply with no json block', () => {
    const r = classifyResponse('```csv\n' + HEADER + '\n' + ROW + '\n```');
    assert.equal(r.status, 'INVALID');
    assert.ok(r.violations.some((v) => v.startsWith('MISSING_JSON_BLOCK')));
});

test('detects a capability refusal', () => {
    const r = classifyResponse("I can't access your Outlook mailbox, so I cannot build this timesheet.");
    assert.equal(r.status, 'INVALID');
    assert.ok(r.violations.some((v) => v.startsWith('CAPABILITY_REFUSAL')));
});

test('rejects malformed json', () => {
    const r = classifyResponse(reply(undefined, '{ "range": {}, }'));
    assert.equal(r.status, 'INVALID');
    assert.ok(r.violations.some((v) => v.startsWith('JSON_PARSE_ERROR')));
});

test('rejects a missing evidence_items key in evidence mode', () => {
    const r = classifyResponse('```json\n' + JSON.stringify({ range: {}, discovered_ids: [], verify: [], assumptions: [] }) + '\n```');
    assert.equal(r.status, 'INVALID');
    assert.ok(r.violations.some((v) => v.includes('evidence_items')));
});

test('rejects unexpected csv columns', () => {
    const r = classifyResponse(reply(`${HEADER},Extra\n${ROW},x`));
    assert.equal(r.status, 'INVALID');
    assert.ok(r.violations.some((v) => v.startsWith('CSV_EXTRA_COLUMNS')));
});

test('rejects an unterminated quoted field', () => {
    const r = classifyResponse(reply(`${HEADER}\n2026-08-24,"Acme Corp,x,y,z,1.00,Yes,e,c`));
    assert.equal(r.status, 'INVALID');
    assert.ok(r.violations.some((v) => v.startsWith('CSV_PARSE_ERROR')));
});

test('an empty reply is invalid, not silently empty', () => {
    assert.equal(classifyResponse('').status, 'INVALID');
});
