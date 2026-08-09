/**
 * Combines independent passive liveness signals via majority voting
 * instead of a single mandatory "gatekeeper" signal.
 *
 * 🟩 SECURITY FIX: the previous design required border-uniformity
 * (antiReplayHeuristic.js) to fire before ANY other signal counted at all
 * — `borderSuspicious && (otherSignal || ...)`. A printed photo or a phone
 * held up in a normal room (a textured wall/desk visible around it, not a
 * screen bezel filling the whole frame) essentially never trips the
 * border check, so the entire gate silently passed regardless of what the
 * motion/color/texture signals showed. This is exactly how a plain photo
 * defeated both the Login and Attendance liveness checks during the
 * capstone defense. Voting instead treats every available signal as one
 * independent vote and flags suspicious once enough of them agree — no
 * single signal is a required precondition for the others to matter.
 */
const REQUIRED_VOTES = 2;

/**
 * @param {Record<string, boolean | null | undefined>} signals - each key is
 *   one heuristic's verdict (true = looks suspicious); pass null/undefined
 *   for a signal that isn't available this tick (e.g. accelerometer motion
 *   on a desktop with no devicemotion support) so it isn't counted either way.
 */
export function evaluatePassiveLiveness(signals) {
    const readings = Object.values(signals).filter((s) => s === true || s === false);
    const votes = readings.filter((s) => s === true).length;
    const total = readings.length;
    return {
        suspicious: total >= REQUIRED_VOTES && votes >= REQUIRED_VOTES,
        votes,
        total,
    };
}
