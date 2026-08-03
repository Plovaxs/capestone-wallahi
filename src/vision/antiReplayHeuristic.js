/**
 * Best-effort, heuristic-only signal for "this might be a phone/tablet
 * screen held up to the camera instead of a real face" — NOT a reliable
 * anti-spoofing guarantee. A screen replay often shows an unnaturally
 * uniform border (bezel, black letterboxing) around the face, whereas a
 * real in-person background (a wall, a room) tends to have more texture
 * noise. This computes luminance standard deviation across a sampled
 * region; low variance is treated as merely SUSPICIOUS, not blocked
 * outright, since a person standing against a plain wall would trigger
 * a false positive on this signal alone.
 */
export function calculateLuminanceStdDev(imageData) {
    if (!imageData || imageData.length === 0) return 0;

    const luminances = [];
    for (let i = 0; i < imageData.length; i += 4) {
        luminances.push(0.299 * imageData[i] + 0.587 * imageData[i + 1] + 0.114 * imageData[i + 2]);
    }
    const mean = luminances.reduce((sum, v) => sum + v, 0) / luminances.length;
    const variance = luminances.reduce((sum, v) => sum + (v - mean) ** 2, 0) / luminances.length;
    return Math.sqrt(variance);
}

const SUSPICIOUSLY_UNIFORM_STDDEV = 8;

export function checkReplaySuspicion(borderRegionImageData) {
    const stdDev = calculateLuminanceStdDev(borderRegionImageData);
    return {
        suspicious: stdDev < SUSPICIOUSLY_UNIFORM_STDDEV,
        reason: stdDev < SUSPICIOUSLY_UNIFORM_STDDEV ? 'uniform-border' : null,
        stdDev,
    };
}
