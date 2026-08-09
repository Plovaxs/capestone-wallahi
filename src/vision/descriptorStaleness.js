const STORAGE_KEY_PREFIX = 'face_descriptor_staleness_';
const NEAR_THRESHOLD_MARGIN = 0.1;
const STALENESS_REMINDER_COUNT = 5;

const HISTORY_KEY_PREFIX = 'face_match_distance_history_';
const HISTORY_SIZE = 20;

/**
 * Tracks (per-user, in localStorage — not a server record) how many
 * recent successful matches came in close to the threshold rather than
 * confidently. A rising trend usually means the stored descriptor no
 * longer represents the person as well as it used to (haircut, new
 * glasses, aging) — the fix is re-enrolling, not loosening the threshold.
 */
export function recordMatchDistance(userId, distance, threshold, { marginBelowThreshold = NEAR_THRESHOLD_MARGIN, reminderCount = STALENESS_REMINDER_COUNT } = {}) {
    const key = STORAGE_KEY_PREFIX + userId;
    let count = 0;
    try {
        count = Number(localStorage.getItem(key)) || 0;
    } catch {
        return { count: 0, shouldSuggestReEnrollment: false };
    }

    const isNearThreshold = distance > threshold - marginBelowThreshold && distance <= threshold;
    count = isNearThreshold ? count + 1 : Math.max(0, count - 1);

    try {
        localStorage.setItem(key, String(count));
    } catch {
        // localStorage unavailable — the reminder just won't persist across sessions
    }

    appendDistanceHistory(userId, distance);

    return { count, shouldSuggestReEnrollment: count >= reminderCount };
}

export function clearStalenessCounter(userId) {
    try {
        localStorage.removeItem(STORAGE_KEY_PREFIX + userId);
        localStorage.removeItem(HISTORY_KEY_PREFIX + userId);
    } catch {
        // ignore
    }
}

function readDistanceHistory(userId) {
    try {
        const raw = localStorage.getItem(HISTORY_KEY_PREFIX + userId);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'number' && Number.isFinite(v)) : [];
    } catch {
        return [];
    }
}

function appendDistanceHistory(userId, distance) {
    try {
        const history = readDistanceHistory(userId);
        history.push(distance);
        while (history.length > HISTORY_SIZE) history.shift();
        localStorage.setItem(HISTORY_KEY_PREFIX + userId, JSON.stringify(history));
    } catch {
        // localStorage unavailable — adaptive threshold just falls back to the global default
    }
}

/**
 * Personalizes the face-match threshold per employee, based on their own
 * recent successful-match distances (rolling window, this device's
 * localStorage -- not a server record, matches the existing staleness
 * counter's scope/privacy posture above). Deliberately one-directional:
 * can only ever LOOSEN the threshold relative to the global default
 * (never tighten it), and only within a small, fixed margin -- this
 * closes the actual real-world friction this is meant to solve (someone
 * whose face naturally produces a slightly higher baseline distance --
 * lighting-prone equipment, more expressive features -- lands near the
 * threshold on every single scan and needs repeated attempts) without
 * ever being able to make matching *more* permissive than a small, capped
 * amount, or accidentally *stricter* (which would only ever cause new
 * false rejects, not fix anything).
 *
 * Caveat, stated plainly rather than overclaimed: this history is
 * necessarily left-censored -- every recorded distance already passed
 * the threshold in effect at the time (recordMatchDistance is only ever
 * called after a successful match), so it describes "how close do this
 * person's successful matches typically land", not their true full
 * distance distribution. Still a meaningful, safe signal for the narrow
 * one-directional adjustment this makes.
 *
 * @param {string} userId
 * @param {number} globalThreshold - the app's normal, fixed threshold (the floor -- this never returns less than this)
 * @param {object} [options]
 * @param {number} [options.minSamples] - how much history is required before personalizing at all; falls back to globalThreshold until then
 * @param {number} [options.maxLooseningMargin] - hard cap on how much looser than globalThreshold this can ever return
 * @param {number} [options.kStdDev] - how many standard deviations above this person's own mean distance to allow
 */
export function getAdaptiveThreshold(userId, globalThreshold, { minSamples = 8, maxLooseningMargin = 0.05, kStdDev = 1.5 } = {}) {
    const history = readDistanceHistory(userId);
    if (history.length < minSamples) return globalThreshold;

    const mean = history.reduce((sum, v) => sum + v, 0) / history.length;
    const variance = history.reduce((sum, v) => sum + (v - mean) ** 2, 0) / history.length;
    const stdDev = Math.sqrt(variance);
    const candidate = mean + kStdDev * stdDev;

    return Math.min(globalThreshold + maxLooseningMargin, Math.max(globalThreshold, candidate));
}
