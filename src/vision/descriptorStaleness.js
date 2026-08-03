const STORAGE_KEY_PREFIX = 'face_descriptor_staleness_';
const NEAR_THRESHOLD_MARGIN = 0.1;
const STALENESS_REMINDER_COUNT = 5;

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

    return { count, shouldSuggestReEnrollment: count >= reminderCount };
}

export function clearStalenessCounter(userId) {
    try {
        localStorage.removeItem(STORAGE_KEY_PREFIX + userId);
    } catch {
        // ignore
    }
}
