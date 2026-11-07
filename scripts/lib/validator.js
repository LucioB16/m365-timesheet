/**
 * All the arithmetic and formatting rules the model is asked to follow are
 * re-checked here, locally, because a timesheet that does not tie out is worse
 * than no timesheet. Errors block the run; warnings are reported and kept.
 */

const MAX_DESCRIPTION = 255;

const round2 = (n) => Math.round(n * 100) / 100;

function parseHours(raw) {
    const s = String(raw).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, value: NaN, twoDecimals: false };
    const value = Number(s);
    return { ok: Number.isFinite(value), value, twoDecimals: /^\d+\.\d{2}$/.test(s) };
}

function validate(rows, { range, hoursPerDay, workingDays, includeNonBillable }) {
    const errors = [];
    const warnings = [];
    const quota = Number(hoursPerDay);
    const workingSet = new Set(range.workingDays);
    const inRange = new Set(range.days);

    const seenPairs = new Map();
    const byDate = new Map();
    const byClient = new Map();
    let billable = 0;
    let nonBillable = 0;

    rows.forEach((row, idx) => {
        const where = `row ${idx + 1} (${row.Date || '?'} / ${row.Client || '?'})`;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(row.Date)) {
            errors.push(`${where}: Date "${row.Date}" is not ISO YYYY-MM-DD.`);
        } else if (!inRange.has(row.Date)) {
            errors.push(`${where}: Date is outside the requested range ${range.start}..${range.end}.`);
        }

        if (!row.Client) errors.push(`${where}: Client is empty.`);

        const key = `${row.Date}||${row.Client.toLowerCase()}`;
        if (seenPairs.has(key)) {
            errors.push(`${where}: duplicate row - ${row.Client} already has a row on ${row.Date} (see row ${seenPairs.get(key) + 1}). One row per client per day.`);
        } else {
            seenPairs.set(key, idx);
        }

        const h = parseHours(row.Hours);
        if (!h.ok) {
            errors.push(`${where}: Hours "${row.Hours}" is not a number.`);
        } else {
            if (!h.twoDecimals) errors.push(`${where}: Hours "${row.Hours}" must have exactly two decimals.`);
            if (round2(h.value * 4) % 1 !== 0) errors.push(`${where}: Hours ${row.Hours} is not a multiple of 0.25.`);
            if (h.value <= 0) errors.push(`${where}: Hours must be greater than zero.`);
            byDate.set(row.Date, round2((byDate.get(row.Date) || 0) + h.value));
            byClient.set(row.Client, round2((byClient.get(row.Client) || 0) + h.value));
        }

        const bill = String(row.Billable).trim();
        if (bill !== 'Yes' && bill !== 'No') {
            errors.push(`${where}: Billable must be exactly "Yes" or "No", got "${row.Billable}".`);
        } else if (h.ok) {
            if (bill === 'Yes') billable = round2(billable + h.value);
            else nonBillable = round2(nonBillable + h.value);
        }

        if (bill === 'Yes' && /^internal$/i.test(row.Client)) {
            errors.push(`${where}: Client "Internal" cannot be billable.`);
        }
        if (bill === 'No' && !/^internal$/i.test(row.Client) && !/non-?billable/i.test(row['Project/Area'] || '')) {
            warnings.push(`${where}: non-billable time booked to client "${row.Client}" - confirm this is intended.`);
        }
        if (includeNonBillable === false && bill === 'No') {
            warnings.push(`${where}: non-billable time was excluded in the settings but this row is Billable=No.`);
        }

        const desc = String(row.Description || '');
        if (!desc.trim()) {
            errors.push(`${where}: Description is empty.`);
        } else if (desc.length > MAX_DESCRIPTION) {
            errors.push(`${where}: Description is ${desc.length} characters, over the ${MAX_DESCRIPTION} limit.`);
        }
        if (/\b(worked on|looked at|various|misc\.?|general work)\b/i.test(desc) && !/[:;]/.test(desc)) {
            warnings.push(`${where}: Description looks vague - "${desc.slice(0, 60)}".`);
        }

        const tickets = String(row['Tickets/Cases'] || '').trim();
        if (!tickets) errors.push(`${where}: Tickets/Cases is empty (use "N/A" for internal work).`);
        if (tickets && tickets !== 'N/A') {
            for (const id of tickets.split(',').map((s) => s.trim()).filter(Boolean)) {
                if (/^INT-\d{3,6}$/i.test(id)) continue;
                if (!desc.includes(id)) warnings.push(`${where}: ticket ${id} is listed but never prefixed in the Description.`);
            }
        }
    });

    // Every working day must land exactly on the quota.
    for (const day of range.workingDays) {
        const total = byDate.get(day) || 0;
        if (round2(total) !== round2(quota)) {
            errors.push(`Day ${day} totals ${total.toFixed(2)} h but the daily quota is ${quota.toFixed(2)} h.`);
        }
    }
    for (const [day, total] of byDate) {
        if (!workingSet.has(day)) {
            warnings.push(`Day ${day} is not a working day but carries ${total.toFixed(2)} h - it must be marked VERIFY.`);
        }
    }

    const periodTotal = round2([...byDate.values()].reduce((a, b) => a + b, 0));
    const expected = round2(range.workingDays.length * quota);
    const nonWorkingHours = round2(periodTotal - round2([...workingSet].reduce((a, d) => a + (byDate.get(d) || 0), 0)));
    if (round2(billable + nonBillable) !== periodTotal) {
        errors.push(`Billable (${billable.toFixed(2)}) + non-billable (${nonBillable.toFixed(2)}) = ${round2(billable + nonBillable).toFixed(2)} does not equal the period total ${periodTotal.toFixed(2)}.`);
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        totals: {
            byDate: Object.fromEntries([...byDate.entries()].sort()),
            byClient: Object.fromEntries([...byClient.entries()].sort()),
            billable,
            nonBillable,
            period: periodTotal,
            expectedWorkingHours: expected,
            nonWorkingDayHours: nonWorkingHours
        },
        descriptionLengths: rows.map((r, i) => ({ row: i + 1, date: r.Date, client: r.Client, length: String(r.Description || '').length }))
    };
}

module.exports = { validate, parseHours, round2, MAX_DESCRIPTION };
