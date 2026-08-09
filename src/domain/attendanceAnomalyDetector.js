/**
 * Personalized (per-employee) statistical anomaly detection on attendance
 * clock-in times -- z-score against each employee's OWN historical
 * pattern, not a single company-wide rule. A genuinely useful "AI"
 * addition for a supervisor: catches things a manual scan of a table
 * wouldn't, like someone whose clock-in time suddenly drifts far outside
 * their own normal routine (worth a check-in conversation), without
 * needing a fixed cutoff that's meaningless across people who
 * legitimately work different shifts/hours.
 *
 * Deliberately advisory-only, surfaced for human review -- this flags
 * statistical outliers relative to a person's own history, which is not
 * the same thing as wrongdoing (a schedule change, a one-off early
 * meeting, daylight saving, etc. can all produce a real, legitimate
 * anomaly here).
 */
const DEFAULT_MIN_SAMPLE_SIZE = 5;
// 🟩 Iglewicz & Hoaglin's recommended cutoff for the modified z-score below.
const DEFAULT_Z_THRESHOLD = 3.5;

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 'HH:MM:SS' (or 'HH:MM') -> minutes since midnight. Returns null for anything unparseable. */
function timeStringToMinutes(timeStr) {
    if (typeof timeStr !== 'string') return null;
    const match = timeStr.match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return hours * 60 + minutes;
}

/**
 * @param {Array<{employee_id: string, date: string, clock_in: string}>} attendanceRows
 * @param {object} [options]
 * @param {number} [options.minSampleSize] - an employee needs at least this many clock-ins before a baseline is trusted enough to flag anything
 * @param {number} [options.zThreshold] - modified z-score cutoff (3.5 is Iglewicz & Hoaglin's standard recommendation)
 * @returns {Array<{employee_id: string, date: string, clock_in: string, zScore: number, employeeMedianMinutes: number, employeeMadMinutes: number}>}
 */
export function detectAttendanceAnomalies(attendanceRows, { minSampleSize = DEFAULT_MIN_SAMPLE_SIZE, zThreshold = DEFAULT_Z_THRESHOLD } = {}) {
    if (!Array.isArray(attendanceRows) || attendanceRows.length === 0) return [];

    const byEmployee = new Map();
    for (const row of attendanceRows) {
        const minutes = timeStringToMinutes(row.clock_in);
        if (minutes === null || !row.employee_id) continue;
        if (!byEmployee.has(row.employee_id)) byEmployee.set(row.employee_id, []);
        byEmployee.get(row.employee_id).push({ ...row, _minutes: minutes });
    }

    const anomalies = [];
    for (const rows of byEmployee.values()) {
        if (rows.length < minSampleSize) continue;

        // 🟩 MEDIAN + MAD (median absolute deviation), not mean + stddev: a
        // classic mean/stddev z-score is vulnerable to "masking" -- a
        // single extreme outlier inflates the standard deviation it's
        // itself being measured against, understating its own severity
        // (and can hide a second, smaller outlier entirely). Median and
        // MAD are far less sensitive to the very outliers they're meant to
        // detect, the standard robust-statistics fix for this. 0.6745
        // rescales MAD to be comparable to a standard deviation under a
        // normal distribution (the conventional constant for this method).
        const employeeMedianMinutes = median(rows.map((r) => r._minutes));
        const absDeviations = rows.map((r) => Math.abs(r._minutes - employeeMedianMinutes));
        const mad = median(absDeviations);

        // MAD of exactly 0 (more than half this employee's clock-ins land
        // on the exact same minute) makes the ratio below undefined/
        // infinite -- anything else, even a small-but-real MAD like 0.5min,
        // is a legitimate variance estimate worth dividing by (a very
        // punctual employee isn't "near-zero variance", they're just punctual).
        if (mad === 0) continue;

        for (const row of rows) {
            const zScore = 0.6745 * (row._minutes - employeeMedianMinutes) / mad;
            if (Math.abs(zScore) >= zThreshold) {
                anomalies.push({
                    employee_id: row.employee_id,
                    date: row.date,
                    clock_in: row.clock_in,
                    zScore,
                    employeeMedianMinutes,
                    employeeMadMinutes: mad,
                });
            }
        }
    }

    return anomalies.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
}
