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
 *
 * 🟩 SECURITY HARDENING (2026-08-10): treating pulse as just one vote
 * among up to five let a sharp, well-lit photo -- physically wobbled by
 * hand while held up (which paradoxically satisfies the pixel-motion
 * signal, since it isn't "suspiciously flat") -- clear the passive gate
 * having tripped only the pulse vote, since border/pixel/color/texture
 * could all plausibly read "not suspicious" for a decent print. rPPG
 * pulse (pulseDetector.js) is qualitatively different from every other
 * signal here: it measures actual periodic blood-flow-driven light
 * reflectance, which a flat photo or screen genuinely cannot produce, no
 * matter how sharp/well-lit/well-wobbled it is. Once the pulse detector
 * has gathered enough samples to have an opinion (`pulseSuspicious` is
 * not null), that opinion is now authoritative -- a confirmed absence of
 * a plausible pulse marks the frame suspicious regardless of how the
 * other four (comparatively fakeable) signals vote. Before pulse data is
 * ready (the first few seconds of any session), the majority vote over
 * the remaining signals is still used as a reasonable fallback.
 */
const REQUIRED_VOTES = 2;

/**
 * @param {Record<string, boolean | null | undefined>} signals - each key is
 *   one heuristic's verdict (true = looks suspicious); pass null/undefined
 *   for a signal that isn't available this tick (e.g. accelerometer motion
 *   on a desktop with no devicemotion support, or pulse before it has
 *   enough samples) so it isn't counted either way.
 */
export function evaluatePassiveLiveness({ pulseSuspicious, ...otherSignals } = {}) {
    const readings = Object.values(otherSignals).filter((s) => s === true || s === false);
    const votes = readings.filter((s) => s === true).length;
    const total = readings.length;

    if (pulseSuspicious === true) {
        // Authoritative: a confirmed absence of a plausible pulse overrides
        // however the other (individually fakeable) signals voted.
        return { suspicious: true, votes: votes + 1, total: total + 1 };
    }

    const pulseCounted = pulseSuspicious === false;
    return {
        suspicious: total >= REQUIRED_VOTES && votes >= REQUIRED_VOTES,
        votes,
        total: pulseCounted ? total + 1 : total,
    };
}
