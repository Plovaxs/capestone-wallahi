import { calculateDistanceMeters } from '../geo/officeGeofence';

/**
 * "Impossible travel" detection: the same pattern SaaS security platforms
 * (Microsoft Entra, Datadog, Torq) use for login anomalies, applied to
 * attendance clock-ins instead -- if the same employee's two most recent
 * clock-in locations imply a travel speed no real mode of transport could
 * achieve, something is off (GPS spoofing to fake being in-geofence while
 * physically elsewhere, or credential sharing between two people in
 * different places). Deliberately advisory-only, surfaced for supervisor
 * review -- flags a genuine statistical/physical impossibility, not proof
 * of wrongdoing (a stale/cached GPS fix, a data-entry glitch, etc. can
 * also produce one).
 *
 * The threshold (900 km/h) is the standard "impossible travel" heuristic
 * used across the industry -- roughly commercial-flight speed, generous
 * enough that real travel between company sites never trips it, while
 * still catching physically-impossible jumps.
 */
const MAX_PLAUSIBLE_SPEED_KMH = 900;
// Guards against a divide-by-near-zero blowing up the speed calculation
// for two clock-ins recorded moments apart (a duplicate/glitched row) --
// there's nothing meaningful to evaluate at that gap either way.
const MIN_HOURS_ELAPSED_TO_EVALUATE = 0.25;

function toTimestamp(row) {
    return new Date(`${row.date}T${row.clock_in || '00:00:00'}`).getTime();
}

/**
 * @param {Array<{employee_id: string, date: string, clock_in?: string, latitude?: number, longitude?: number}>} attendanceRows
 * @returns {Array<{employee_id: string, fromDate: string, toDate: string, distanceKm: number, hoursElapsed: number, impliedSpeedKmh: number}>} sorted worst-first
 */
export function detectImpossibleTravel(attendanceRows) {
    if (!Array.isArray(attendanceRows)) return [];

    const byEmployee = new Map();
    for (const row of attendanceRows) {
        if (!row.employee_id || row.latitude == null || row.longitude == null || !row.date) continue;
        if (!byEmployee.has(row.employee_id)) byEmployee.set(row.employee_id, []);
        byEmployee.get(row.employee_id).push(row);
    }

    const flags = [];
    for (const [employeeId, rows] of byEmployee) {
        const sorted = [...rows].sort((a, b) => toTimestamp(a) - toTimestamp(b));

        for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            const curr = sorted[i];
            const hoursElapsed = (toTimestamp(curr) - toTimestamp(prev)) / (1000 * 60 * 60);
            if (hoursElapsed < MIN_HOURS_ELAPSED_TO_EVALUATE) continue;

            const distanceKm = calculateDistanceMeters(prev.latitude, prev.longitude, curr.latitude, curr.longitude) / 1000;
            const impliedSpeedKmh = distanceKm / hoursElapsed;

            if (impliedSpeedKmh > MAX_PLAUSIBLE_SPEED_KMH) {
                flags.push({
                    employee_id: employeeId,
                    fromDate: prev.date,
                    toDate: curr.date,
                    distanceKm: Math.round(distanceKm),
                    hoursElapsed: Math.round(hoursElapsed * 10) / 10,
                    impliedSpeedKmh: Math.round(impliedSpeedKmh),
                });
            }
        }
    }

    return flags.sort((a, b) => b.impliedSpeedKmh - a.impliedSpeedKmh);
}
