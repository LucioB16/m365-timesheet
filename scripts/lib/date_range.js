/**
 * Date range parsing for the timesheet skill.
 *
 * Everything is handled as plain `YYYY-MM-DD` strings backed by UTC-noon Date
 * objects, so no local timezone offset can ever shift a day boundary.
 * Ambiguous numeric formats (03/04/2026) are rejected rather than guessed,
 * because guessing wrong silently bills the wrong week.
 */

const MS_DAY = 86400000;

const toDate = (iso) => new Date(`${iso}T12:00:00Z`);
const toIso = (d) => d.toISOString().slice(0, 10);
const shift = (iso, days) => toIso(new Date(toDate(iso).getTime() + days * MS_DAY));
const dow = (iso) => toDate(iso).getUTCDay();

function todayIso(timezone) {
    // en-CA renders as YYYY-MM-DD, which is exactly the shape we want.
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (e) {
        return new Date().toISOString().slice(0, 10);
    }
}

function startOfWeek(iso) {
    // Weeks start on Monday.
    const d = dow(iso);
    return shift(iso, d === 0 ? -6 : 1 - d);
}

function endOfMonth(iso) {
    const d = toDate(iso);
    return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)));
}

function startOfMonth(iso) {
    return `${iso.slice(0, 7)}-01`;
}

function isIso(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toDate(s).getTime()) && toIso(toDate(s)) === s;
}

function normalizeOne(token, today) {
    const t = String(token).trim();
    if (isIso(t)) return t;

    // Unambiguous only when one component cannot be a month.
    const slash = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (slash) {
        const [, a, b, y] = slash;
        const na = Number(a);
        const nb = Number(b);
        if (na > 12 && nb <= 12) return `${y}-${String(nb).padStart(2, '0')}-${String(na).padStart(2, '0')}`; // DD/MM
        if (nb > 12 && na <= 12) return `${y}-${String(na).padStart(2, '0')}-${String(nb).padStart(2, '0')}`; // MM/DD
        throw new Error(`Ambiguous date "${t}": it could be day-first or month-first. Use YYYY-MM-DD instead.`);
    }

    const named = new Date(`${t} 12:00:00Z`);
    if (!Number.isNaN(named.getTime()) && /[A-Za-z]/.test(t)) return toIso(named);

    throw new Error(`Could not understand the date "${t}". Use YYYY-MM-DD.`);
}

/**
 * @param {string|string[]} input   "last week", "2026-08-24..2026-08-28", ["2026-08-24","2026-08-28"], ...
 * @param {object} opts            { timezone, workingDays }
 * @returns {{start:string,end:string,label:string,days:string[],workingDays:string[],months:Array}}
 */
function parseRange(input, opts = {}) {
    const timezone = opts.timezone || 'US/Eastern';
    const workingDays = opts.workingDays || [1, 2, 3, 4, 5];
    const today = todayIso(timezone);

    const tokens = Array.isArray(input) ? input.filter(Boolean).map(String) : [String(input || '')];
    const raw = tokens.join(' ').trim();
    if (!raw) throw new Error('No date range was given. Pass one, e.g. "last week" or "2026-08-24..2026-08-28".');

    const phrase = raw.toLowerCase().replace(/\s+/g, ' ');
    let start;
    let end;

    const explicit = raw.split(/\s*(?:\.\.|\bto\b|\bthrough\b|–|—)\s*|\s+/i).map((s) => s.trim()).filter(Boolean);

    if (phrase === 'today') {
        start = end = today;
    } else if (phrase === 'yesterday') {
        start = end = shift(today, -1);
    } else if (phrase === 'this week') {
        start = startOfWeek(today);
        end = shift(start, 6);
    } else if (phrase === 'last week') {
        start = shift(startOfWeek(today), -7);
        end = shift(start, 6);
    } else if (phrase === 'this month') {
        start = startOfMonth(today);
        end = endOfMonth(today);
    } else if (phrase === 'last month') {
        const anchor = shift(startOfMonth(today), -1);
        start = startOfMonth(anchor);
        end = endOfMonth(anchor);
    } else if (/^(past|last) (\d+) (day|days)$/.test(phrase)) {
        const n = Number(phrase.match(/(\d+)/)[1]);
        end = today;
        start = shift(today, -(n - 1));
    } else if (/^(past|last) (\d+) (week|weeks)$/.test(phrase)) {
        const n = Number(phrase.match(/(\d+)/)[1]);
        end = shift(startOfWeek(today), -1);
        start = shift(end, -(n * 7 - 1));
    } else if (explicit.length >= 2) {
        start = normalizeOne(explicit[0], today);
        end = normalizeOne(explicit[explicit.length - 1], today);
    } else {
        start = end = normalizeOne(explicit[0], today);
    }

    if (start > end) [start, end] = [end, start];

    const days = [];
    for (let d = start; d <= end; d = shift(d, 1)) days.push(d);

    const working = days.filter((d) => workingDays.includes(dow(d)));

    // A range that crosses a month boundary usually has to be submitted as two
    // timesheets, so surface the split instead of letting it be discovered later.
    const months = [];
    for (const d of days) {
        const key = d.slice(0, 7);
        const last = months[months.length - 1];
        if (!last || last.month !== key) months.push({ month: key, start: d, end: d });
        else last.end = d;
    }

    return {
        start,
        end,
        label: start === end ? start : `${start}..${end}`,
        timezone,
        days,
        workingDays: working,
        months,
        crossesMonthBoundary: months.length > 1
    };
}

module.exports = { parseRange, todayIso, isIso, shift, toIso, toDate, dow, startOfWeek, startOfMonth, endOfMonth };
