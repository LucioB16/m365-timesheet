const test = require('node:test');
const assert = require('node:assert');
const { composeTimesheetRows } = require('../scripts/lib/compose_timesheet');
const { parseRange } = require('../scripts/lib/date_range');

const range = parseRange('2026-08-24..2026-08-25', { timezone: 'UTC', workingDays: [1, 2, 3, 4, 5] });
const config = { HOURS_PER_DAY: 8, INTERNAL_SYSTEMS_CLIENT: 'Internal Systems' };

test('composes rows from evidence items and balances each day to quota', () => {
    const evidence = {
        range: { start: '2026-08-24', end: '2026-08-25', timezone: 'UTC' },
        evidence_items: [
            { date: '2026-08-24', client: 'Acme Corp', project_area: 'Power Platform', tickets: ['CAS-1000001-A1B1'], description: 'Fixed loop guard and retested.', hours_hint: 6.5, billable: 'Yes', evidence: ['Teams call'] },
            { date: '2026-08-25', client: 'Globex Inc', project_area: 'Power Automate', tickets: ['CAS-1000002-B2C2'], description: 'Published flow changes.', hours_hint: 8.0, billable: 'Yes', evidence: ['Run history'] }
        ],
        discovered_ids: [],
        verify: [],
        assumptions: []
    };
    const out = composeTimesheetRows({ evidence, range, config });
    const d1 = out.rows.filter((r) => r.Date === '2026-08-24');
    assert.equal(d1.reduce((s, r) => s + Number(r.Hours), 0).toFixed(2), '8.00');
    assert.ok(d1.some((r) => r.Client === 'Internal'));
    assert.equal(out.rows.filter((r) => r.Date === '2026-08-25').reduce((s, r) => s + Number(r.Hours), 0).toFixed(2), '8.00');
});

test('routes internal crm/sla work to separate internal systems client', () => {
    const evidence = {
        range: { start: '2026-08-24', end: '2026-08-24', timezone: 'UTC' },
        evidence_items: [
            { date: '2026-08-24', client: 'Internal', project_area: 'Internal SLA', tickets: ['INT-0001'], description: 'Updated internal CRM SLA rule.', hours_hint: 1.0, billable: 'No', evidence: ['Dataverse'] }
        ],
        discovered_ids: [],
        verify: [],
        assumptions: []
    };
    const out = composeTimesheetRows({ evidence, range: parseRange('2026-08-24..2026-08-24', { timezone: 'UTC', workingDays: [0, 1, 2, 3, 4, 5, 6] }), config });
    const row = out.rows.find((r) => r.Client === 'Internal Systems' && r.Billable === 'No');
    assert.ok(row);
    assert.equal(/INT-\d{3,6}/.test(row.Description), false);
});

test('shortens case notes without cutting words or leaving dangling connectors', () => {
    const evidence = {
        range: { start: '2026-08-24', end: '2026-08-24', timezone: 'UTC' },
        evidence_items: [
            {
                date: '2026-08-24',
                client: 'Acme Corp',
                project_area: 'Power Platform',
                tickets: ['CAS-1000001-A1B1'],
                description: 'Completed QA validation, removed obsolete flow path, prepared TEST/UAT deployment, coordinated release communication',
                hours_hint: 8.0,
                billable: 'Yes',
                evidence: ['Teams call']
            }
        ],
        discovered_ids: [],
        verify: [],
        assumptions: []
    };
    const out = composeTimesheetRows({
        evidence,
        range: parseRange('2026-08-24..2026-08-24', { timezone: 'UTC', workingDays: [0, 1, 2, 3, 4, 5, 6] }),
        config
    });
    const row = out.rows.find((r) => r.Client === 'Acme Corp');
    assert.ok(row);
    assert.equal(row.Description.endsWith(' and'), false);
    assert.equal(row.Description.endsWith(' dep'), false);
});
