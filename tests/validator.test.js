const test = require('node:test');
const assert = require('node:assert');
const { validate } = require('../scripts/lib/validator');
const { parseRange } = require('../scripts/lib/date_range');

const range = parseRange('2026-08-24..2026-08-25', { timezone: 'UTC', workingDays: [1, 2, 3, 4, 5] });
const opts = { range, hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5], includeNonBillable: true };

const row = (over = {}) => ({
    Date: '2026-08-24',
    Client: 'Acme Corp',
    'Project/Area': 'Power Platform',
    'Tickets/Cases': 'CAS-1000001-A1B1',
    Description: 'CAS-1000001-A1B1: Rebuilt the day-prior loop guard and ran the DEV regression.',
    Hours: '8.00',
    Billable: 'Yes',
    Evidence: 'Teams sync',
    'Comments/Next Steps': '',
    ...over
});

const twoFullDays = () => [row(), row({ Date: '2026-08-25' })];

test('a clean two-day timesheet passes', () => {
    const r = validate(twoFullDays(), opts);
    assert.ok(r.ok, r.errors.join('\n'));
    assert.equal(r.totals.period, 16);
    assert.equal(r.totals.billable, 16);
});

test('a day that does not reach the quota fails', () => {
    const rows = twoFullDays();
    rows[0].Hours = '6.00';
    const r = validate(rows, opts);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => e.includes('2026-08-24 totals 6.00')));
});

test('hours that are not a multiple of 0.25 fail', () => {
    const rows = twoFullDays();
    rows[0].Hours = '7.90';
    const r = validate(rows, opts);
    assert.ok(r.errors.some((e) => e.includes('not a multiple of 0.25')));
});

test('hours without two decimals fail', () => {
    const rows = twoFullDays();
    rows[0].Hours = '8';
    const r = validate(rows, opts);
    assert.ok(r.errors.some((e) => e.includes('exactly two decimals')));
});

test('two rows for the same client on the same day fail', () => {
    const rows = [row({ Hours: '4.00' }), row({ Hours: '4.00' }), row({ Date: '2026-08-25' })];
    const r = validate(rows, opts);
    assert.ok(r.errors.some((e) => e.includes('duplicate row')));
});

test('a description over 255 characters fails', () => {
    const rows = twoFullDays();
    rows[0].Description = `CAS-1000001-A1B1: ${'x'.repeat(260)}`;
    const r = validate(rows, opts);
    assert.ok(r.errors.some((e) => e.includes('over the 255')));
});

test('a date outside the range fails', () => {
    const rows = twoFullDays();
    rows.push(row({ Date: '2026-09-01', Hours: '1.00' }));
    const r = validate(rows, opts);
    assert.ok(r.errors.some((e) => e.includes('outside the requested range')));
});

test('billable internal time fails', () => {
    const rows = twoFullDays();
    rows[0].Client = 'Internal';
    const r = validate(rows, opts);
    assert.ok(r.errors.some((e) => e.includes('cannot be billable')));
});

test('a bad Billable value fails', () => {
    const rows = twoFullDays();
    rows[0].Billable = 'yes';
    const r = validate(rows, opts);
    assert.ok(r.errors.some((e) => e.includes('exactly "Yes" or "No"')));
});

test('billable and non-billable split ties to the period total', () => {
    const rows = [
        row({ Hours: '6.00' }),
        row({ Client: 'Internal', 'Project/Area': 'Internal / Non-Billable', 'Tickets/Cases': 'N/A', Description: 'Internal: Company standup and admin.', Hours: '2.00', Billable: 'No' }),
        row({ Date: '2026-08-25' })
    ];
    const r = validate(rows, opts);
    assert.ok(r.ok, r.errors.join('\n'));
    assert.equal(r.totals.billable, 14);
    assert.equal(r.totals.nonBillable, 2);
    assert.equal(r.totals.period, 16);
});

test('a ticket listed but never named in the description is warned about', () => {
    const rows = twoFullDays();
    rows[0]['Tickets/Cases'] = 'CAS-1000001-A1B1,CAS-9999999-Z9Z9';
    const r = validate(rows, opts);
    assert.ok(r.warnings.some((w) => w.includes('CAS-9999999-Z9Z9')));
});

