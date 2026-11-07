const test = require('node:test');
const assert = require('node:assert');
const { parseRange, isIso, startOfWeek } = require('../scripts/lib/date_range');

const opts = { timezone: 'UTC', workingDays: [1, 2, 3, 4, 5] };

test('parses an explicit ISO range', () => {
    const r = parseRange('2026-08-24..2026-08-28', opts);
    assert.equal(r.start, '2026-08-24');
    assert.equal(r.end, '2026-08-28');
    assert.equal(r.days.length, 5);
    assert.equal(r.workingDays.length, 5);
    assert.equal(r.crossesMonthBoundary, false);
});

test('parses two positional dates and the "to" form', () => {
    assert.deepEqual(parseRange(['2026-08-24', '2026-08-28'], opts).days.length, 5);
    assert.deepEqual(parseRange('2026-08-24 to 2026-08-28', opts).days.length, 5);
});

test('swaps a reversed range instead of returning nothing', () => {
    const r = parseRange('2026-08-28..2026-08-24', opts);
    assert.equal(r.start, '2026-08-24');
    assert.equal(r.end, '2026-08-28');
});

test('excludes weekends from workingDays but keeps them in days', () => {
    const r = parseRange('2026-08-24..2026-08-30', opts);
    assert.equal(r.days.length, 7);
    assert.equal(r.workingDays.length, 5);
});

test('detects a month boundary and splits it', () => {
    const r = parseRange('2026-08-31..2026-09-04', opts);
    assert.equal(r.crossesMonthBoundary, true);
    assert.deepEqual(r.months.map((m) => m.month), ['2026-08', '2026-09']);
    assert.equal(r.months[0].end, '2026-08-31');
    assert.equal(r.months[1].start, '2026-09-01');
});

test('rejects an ambiguous slash date instead of guessing', () => {
    assert.throws(() => parseRange('03/04/2026', opts), /Ambiguous date/);
});

test('accepts an unambiguous slash date', () => {
    assert.equal(parseRange('24/08/2026', opts).start, '2026-08-24');
    assert.equal(parseRange('08/24/2026', opts).start, '2026-08-24');
});

test('weeks start on Monday', () => {
    assert.equal(startOfWeek('2026-08-30'), '2026-08-24'); // a Sunday
    assert.equal(startOfWeek('2026-08-24'), '2026-08-24'); // a Monday
});

test('relative phrases produce a 7 day span', () => {
    const r = parseRange('last week', opts);
    assert.equal(r.days.length, 7);
    assert.ok(isIso(r.start));
});

test('an empty range is refused', () => {
    assert.throws(() => parseRange('', opts), /No date range/);
});
