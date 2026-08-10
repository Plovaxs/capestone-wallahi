/**
 * Weekday attendance is mandatory and counted toward punctuality/
 * performance stats; weekend attendance is optional (WFH employees who
 * want to log a weekend work session, or WFO employees who came in
 * voluntarily) and deliberately excluded from those stats -- clocking in
 * on a Saturday shouldn't inflate someone's punctuality score, and NOT
 * clocking in on a Sunday shouldn't hurt it either.
 *
 * Rows with no `date` (or an unparseable one) are treated as mandatory/
 * counted -- the safe default, and consistent with every attendance row
 * this app actually writes (date is always populated at insert time).
 */
export function isWeekend(dateStr) {
    if (!dateStr) return false;
    const parsed = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return false;
    const day = parsed.getDay();
    return day === 0 || day === 6;
}

export function isMandatoryAttendanceDay(dateStr) {
    return !isWeekend(dateStr);
}
