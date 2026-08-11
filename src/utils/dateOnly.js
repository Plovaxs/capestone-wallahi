/**
 * Local calendar date for `date` (default now) as "YYYY-MM-DD".
 * `date.toISOString().split('T')[0]` returns the UTC calendar date instead,
 * which silently shifts by a day for any user not exactly on UTC -- e.g. a
 * WIB (UTC+7) user clocking in between local midnight and 7am still has
 * yesterday's UTC date, so "today" comparisons against that would land on
 * the wrong day for exactly the early-morning attendance window this app
 * cares most about.
 */
export function getLocalDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Parses a plain "YYYY-MM-DD" date-only string (from a `<input
 * type="date">`, or a stored `date`/`due_date`/`contract_end_date`/
 * `start_date` column) as LOCAL midnight. `new Date("YYYY-MM-DD")` parses
 * it as UTC midnight per spec, which silently shifts the effective
 * calendar day back one for any user west of UTC.
 */
export function parseLocalDateOnly(dateOnlyString) {
    const [year, month, day] = dateOnlyString.split('-').map(Number);
    return new Date(year, month - 1, day);
}
