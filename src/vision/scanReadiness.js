/**
 * Pure 0-100 "how close to a good capture" scoring, framework-free so it's
 * testable in isolation. Drives the visual readiness bar shown during
 * enrollment/login/clock-in — purely a UX signal layered on top of the
 * existing pass/fail quality gates (faceQuality.js, enrollmentQuality.js),
 * never a replacement for them.
 */

/**
 * For a directional enrollment pose (left/right/up/down): 0% at dead
 * center or while moving the wrong way, 100% once `value` has moved
 * `sign` * `threshold` or further in the requested direction — matching
 * AttendanceView's isPoseAchieved exactly, so the bar hits green at the
 * same instant the pose actually registers. `sign` is +1 for right/down,
 * -1 for left/up (mirroring how yaw/pitch are signed elsewhere in this app).
 */
function calculateDirectionalReadiness(value, threshold, sign) {
    if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) return 0;
    const progress = (value * sign) / threshold; // > 0 only when moving the requested way
    return Math.max(0, Math.min(100, progress * 100));
}

/**
 * For the "center" pose: 100% at dead center, falling off linearly as yaw
 * or pitch (whichever is proportionally further off) approaches its own
 * threshold — the opposite shape from the directional poses above.
 */
function calculateCenterReadiness(yaw, pitch, yawThreshold, pitchThreshold) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return 0;
    const yawFraction = yawThreshold > 0 ? Math.abs(yaw) / yawThreshold : 0;
    const pitchFraction = pitchThreshold > 0 ? Math.abs(pitch) / pitchThreshold : 0;
    const worst = Math.max(yawFraction, pitchFraction);
    return Math.max(0, Math.min(100, (1 - worst) * 100));
}

export function calculatePoseReadiness(pose, yaw, pitch, yawThreshold, pitchThreshold) {
    switch (pose) {
        case 'center': return calculateCenterReadiness(yaw, pitch, yawThreshold, pitchThreshold);
        case 'left': return calculateDirectionalReadiness(yaw, yawThreshold, -1);
        case 'right': return calculateDirectionalReadiness(yaw, yawThreshold, 1);
        case 'up': return calculateDirectionalReadiness(pitch, pitchThreshold, -1);
        case 'down': return calculateDirectionalReadiness(pitch, pitchThreshold, 1);
        default: return 0;
    }
}

/**
 * For the live clock-in/login scan: turns the existing boolean quality
 * gates (framing, brightness, lens, occlusion — whichever the caller
 * actually has available) into one combined 0-100 score. Every failing
 * check costs an equal share; a frame that passes everything scores 100.
 */
export function calculateFrameReadiness(checks) {
    const entries = Object.values(checks || {});
    if (entries.length === 0) return 0;
    const passing = entries.filter(Boolean).length;
    return Math.round((passing / entries.length) * 100);
}

/** A bar is "ready" (green, per the product's own bar >= this is green) at 100 -- i.e. every signal fully satisfied. */
export const READINESS_READY_THRESHOLD = 100;
