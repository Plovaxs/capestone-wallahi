const STORAGE_KEY_PREFIX = 'face_enrollment_wizard_progress_';

/**
 * Persists in-progress multi-angle enrollment captures to localStorage
 * (per-user, not a server record — no schema change) so a closed tab,
 * accidental navigation, or dropped camera mid-wizard doesn't throw away
 * poses the user already captured. Only the pose descriptors + step index
 * are stored; the final `face_descriptor` write to the profile still only
 * happens once, after the last pose.
 */
export function saveEnrollmentProgress(userId, stepIndex, captures) {
    try {
        localStorage.setItem(STORAGE_KEY_PREFIX + userId, JSON.stringify({ stepIndex, captures }));
    } catch {
        // localStorage unavailable — progress just won't survive an interruption
    }
}

export function loadEnrollmentProgress(userId) {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_PREFIX + userId);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed?.captures) || typeof parsed?.stepIndex !== 'number') return null;
        if (parsed.stepIndex < 0 || parsed.stepIndex !== parsed.captures.length) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function clearEnrollmentProgress(userId) {
    try {
        localStorage.removeItem(STORAGE_KEY_PREFIX + userId);
    } catch {
        // ignore
    }
}
