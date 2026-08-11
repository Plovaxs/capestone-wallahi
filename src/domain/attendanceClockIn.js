import { attendanceRepository } from '../data/repositories/attendanceRepository';
import { getServerNow } from '../utils/serverTime';

export const WORK_START_TIME = '08:00:00';

/**
 * Single source of truth for "insert today's clock-in row" -- previously
 * only lived inside AttendanceView's handleClockIn as a component-local
 * closure. Extracted so App.jsx's clock-in-on-login shortcut (see
 * attemptAutoClockInAfterLogin) and AttendanceView's own manual/auto-scan
 * clock-in both go through the exact same geofence gate, already-
 * clocked-in guard, server-clock-sourced punctuality decision, and insert
 * shape -- the two paths can never quietly drift apart on what "clocked
 * in" means.
 *
 * Callers own their own loading/toast UI; this returns a typed result
 * `{ success, reason?, error?, time?, status? }` instead of throwing so
 * each caller can render it however fits (a full toast/status pill in
 * AttendanceView, a single quiet toast-or-nothing in App.jsx).
 *
 * @param {object} params
 * @param {object} params.userProfile
 * @param {{latitude: number, longitude: number} | null} params.coords
 * @param {boolean} params.isInRange - already-computed geofence verdict (WFH/supervisor bypass, WFO geofence check, etc. are the caller's concern)
 * @param {string} params.today - 'YYYY-MM-DD'
 * @param {string} [params.source] - free-text provenance tag stored client-side only (not persisted), e.g. 'face-match' | 'manual' | 'face-login'
 */
export async function performClockIn({ userProfile, coords, isInRange, today, source = 'manual' }) {
    const requiresLocationGate = userProfile.role !== 'supervisor';

    if (requiresLocationGate && !coords) {
        return { success: false, reason: 'gps-waiting' };
    }
    if (requiresLocationGate && !isInRange) {
        return { success: false, reason: 'out-of-range' };
    }

    const runInsert = async () => {
        try {
            // 🟩 DOUBLE CLOCK-IN GUARD: a fresh existence check right before
            // the insert closes most of the cross-device/cross-tab race
            // window (the Web Locks wrapper below serializes concurrent
            // attempts *within this browser*; it can't fully close the
            // window without a DB unique constraint, which is out of scope
            // here). Routed through attendanceRepository (not a raw
            // supabase call) so this -- the single highest-frequency write
            // in the app -- gets the same timeout/circuit-breaker
            // protection every other repository call already gets, instead
            // of being able to hang indefinitely on a weak connection.
            const existing = await attendanceRepository.findByEmployeeAndDate(userProfile.id, today);
            if (existing) {
                return { success: false, reason: 'already-clocked-in' };
            }

            // 🟩 Uses the Supabase server's clock (via its response `Date`
            // header), not the device's -- otherwise punctuality is decided
            // by a value the user's own OS clock controls, trivially
            // spoofable by winding the system time back before clocking in.
            const now = await getServerNow();
            const time = now.toLocaleTimeString('en-GB', { hour12: false });
            const status = time > WORK_START_TIME ? 'Late' : 'Present';

            await attendanceRepository.insert([{
                employee_id: userProfile.id,
                date: today,
                status,
                clock_in: time,
                latitude: coords ? coords.latitude : null,
                longitude: coords ? coords.longitude : null,
                clock_method: source,
            }]);

            return { success: true, time, status, source };
        } catch (error) {
            return { success: false, reason: 'db-error', error };
        }
    };

    if (navigator.locks?.request) {
        return navigator.locks.request(`attendance-clock-in-${userProfile.id}`, runInsert);
    }
    return runInsert();
}

/**
 * Single source of truth for "record today's clock-out" -- extracted from
 * AttendanceView's handleClockOut (which used to run a raw inline
 * supabase.update()) so a second entry point (PIN-based clock-out) can
 * reuse the exact same logic instead of a third copy of it.
 *
 * Deliberately does NOT record location at clock-out (privacy) -- see the
 * comment this carries over from the original inline implementation.
 *
 * @param {object} params
 * @param {string} params.attendanceRowId - the id of today's already-existing attendance row (must have been clocked in already)
 * @param {string} [params.source] - free-text provenance tag, e.g. 'face-match' | 'pin'
 */
export async function performClockOut({ attendanceRowId, source = 'manual' }) {
    const now = await getServerNow();
    const time = now.toLocaleTimeString('en-GB', { hour12: false });

    try {
        await attendanceRepository.update(attendanceRowId, { clock_out: time, clock_method: source });
        return { success: true, time, source };
    } catch (error) {
        return { success: false, reason: 'db-error', error };
    }
}
