/**
 * A raw `distance <= radius` geofence check flickers right at the
 * boundary — normal GPS jitter (a few meters of noise on every reading)
 * flips an employee standing near the edge in and out of range every few
 * seconds, which both looks broken in the UI and would let the clock-in
 * button rapidly enable/disable. This applies the same two mitigations
 * real GPS trackers use:
 *
 *  1. Hysteresis: entering requires being clearly inside
 *     (radius - hysteresisMeters), leaving requires being clearly outside
 *     (radius + hysteresisMeters) — the band in between just keeps
 *     whatever state was last confirmed instead of deciding anything.
 *  2. Debounce: a candidate state change only commits after it's been
 *     seen on `requiredConsecutiveReads` readings in a row, so a single
 *     noisy GPS sample can't flip the state on its own.
 */
export function createGeofenceStateMachine({ radiusMeters, hysteresisMeters = 15, requiredConsecutiveReads = 2 }) {
    let state = 'UNKNOWN'; // 'UNKNOWN' | 'INSIDE' | 'OUTSIDE'
    let pendingState = null;
    let pendingCount = 0;

    function update(distanceMeters) {
        const enterThreshold = radiusMeters - hysteresisMeters;
        const exitThreshold = radiusMeters + hysteresisMeters;

        let candidate;
        if (distanceMeters <= enterThreshold) {
            candidate = 'INSIDE';
        } else if (distanceMeters >= exitThreshold) {
            candidate = 'OUTSIDE';
        } else if (state !== 'UNKNOWN') {
            candidate = state; // inside the hysteresis band — hold last confirmed state
        } else {
            candidate = distanceMeters <= radiusMeters ? 'INSIDE' : 'OUTSIDE'; // no prior reading yet — fall back to the plain radius check
        }

        if (candidate === state) {
            pendingState = null;
            pendingCount = 0;
            return { state, changed: false };
        }

        if (state === 'UNKNOWN') {
            // First real reading ever — commit immediately, there's no prior
            // confirmed state to protect against flapping away from yet.
            state = candidate;
            pendingState = null;
            pendingCount = 0;
            return { state, changed: true };
        }

        if (pendingState === candidate) {
            pendingCount += 1;
        } else {
            pendingState = candidate;
            pendingCount = 1;
        }

        if (pendingCount >= requiredConsecutiveReads) {
            state = candidate;
            pendingState = null;
            pendingCount = 0;
            return { state, changed: true };
        }

        return { state, changed: false };
    }

    function getState() {
        return state;
    }

    return { update, getState };
}
