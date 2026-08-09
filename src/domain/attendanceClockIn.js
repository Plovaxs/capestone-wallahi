import { supabase } from '../supabaseClient';
import { getServerNow } from '../utils/serverTime';

export const ATTENDANCE_TABLE = 'attendance';
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
        // 🟩 DOUBLE CLOCK-IN GUARD: a fresh existence check right before the
        // insert closes most of the cross-device/cross-tab race window (the
        // Web Locks wrapper below serializes concurrent attempts *within
        // this browser*; it can't fully close the window without a DB
        // unique constraint, which is out of scope here).
        const { data: existing, error: existingCheckError } = await supabase
            .from(ATTENDANCE_TABLE)
            .select('id')
            .eq('employee_id', userProfile.id)
            .eq('date', today)
            .maybeSingle();

        if (existingCheckError) {
            return { success: false, reason: 'db-error', error: existingCheckError };
        }
        if (existing) {
            return { success: false, reason: 'already-clocked-in' };
        }

        // 🟩 Uses the Supabase server's clock (via its response `Date`
        // header), not the device's -- otherwise punctuality is decided by
        // a value the user's own OS clock controls, trivially spoofable by
        // winding the system time back before clocking in.
        const now = await getServerNow();
        const time = now.toLocaleTimeString('en-GB', { hour12: false });
        const status = time > WORK_START_TIME ? 'Late' : 'Present';

        const { error } = await supabase.from(ATTENDANCE_TABLE).insert([{
            employee_id: userProfile.id,
            date: today,
            status,
            clock_in: time,
            latitude: coords ? coords.latitude : null,
            longitude: coords ? coords.longitude : null,
        }]);

        if (error) {
            return { success: false, reason: 'db-error', error };
        }

        return { success: true, time, status, source };
    };

    if (navigator.locks?.request) {
        return navigator.locks.request(`attendance-clock-in-${userProfile.id}`, runInsert);
    }
    return runInsert();
}
