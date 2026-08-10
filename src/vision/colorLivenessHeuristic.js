/**
 * Color-domain liveness heuristics, complementary to the existing
 * luminance-only signals (antiReplayHeuristic.js's border uniformity,
 * microMotionTracker.js's frame-to-frame luminance variance). Both of
 * those can be beaten by physically moving a printed photo or a phone
 * showing a photo/video in front of the camera — motion alone isn't proof
 * of a live face. These checks instead look at whether the COLOR content
 * of a single frame plausibly comes from real skin lit directly, rather
 * than reproduced via print ink or a screen's RGB subpixels — meant to be
 * combined with the motion-based signals as one more vote, never a
 * standalone hard gate (same multi-signal design as the rest of this app's
 * anti-spoofing — no single heuristic here is reliable enough alone).
 */

// Chromaticity (r,g) = (R/(R+G+B), G/(R+G+B)) describes hue+saturation
// independent of brightness — real human skin across essentially all skin
// tones and lighting clusters in a fairly narrow band of this space (a
// long-established result in skin-detection literature, not tuned against
// this app's own data). Deliberately a loose band: this is a weak signal
// that only counts alongside the texture check below, not a precise
// segmentation.
// Exported so handRegionHeuristic.js can reuse the exact same
// skin-plausibility band when sampling a DIFFERENT region of the frame
// (around/below the face, not inside it) without duplicating the tuning.
export const SKIN_R_MIN = 0.34;
export const SKIN_R_MAX = 0.49;
export const SKIN_G_MIN = 0.26;
export const SKIN_G_MAX = 0.39;
const MIN_SKIN_PIXEL_FRACTION = 0.3;

/** Fraction of sampled pixels whose chromaticity falls in the skin-plausible band. */
export function calculateSkinPixelFraction(imageData) {
    if (!imageData || imageData.length === 0) return 0;
    let skinCount = 0;
    let sampleCount = 0;
    // Stride-sampled (every 4th pixel) — only needs to be a rough
    // proportion, not a precise segmentation mask.
    for (let i = 0; i < imageData.length; i += 16) {
        const r = imageData[i];
        const g = imageData[i + 1];
        const b = imageData[i + 2];
        const sum = r + g + b;
        if (sum === 0) continue;
        sampleCount++;
        const rNorm = r / sum;
        const gNorm = g / sum;
        if (rNorm >= SKIN_R_MIN && rNorm <= SKIN_R_MAX && gNorm >= SKIN_G_MIN && gNorm <= SKIN_G_MAX) {
            skinCount++;
        }
    }
    if (sampleCount === 0) return 0;
    return skinCount / sampleCount;
}

// Spatial color texture: real skin has natural micro-variation in redness
// (blood flow, pores, subtle blush) even within a tight face crop. A
// printed photo or a phone/tablet screen showing a photo tends to smooth
// this out — print halftoning, screen anti-aliasing, and photo/video
// compression all reduce fine chrominance detail relative to a real face
// lit directly, especially at typical low-res webcam capture sizes.
const CHROMA_VARIANCE_FLAT_THRESHOLD = 4;

/** Variance of R-G ("redness") across a small grid sampled from one frame — a spatial (not temporal) texture signal. */
export function calculateChromaTextureVariance(imageData, width, height, gridSize = 6) {
    if (!imageData || !width || !height) return 0;
    const redness = [];
    for (let gy = 0; gy < gridSize; gy++) {
        for (let gx = 0; gx < gridSize; gx++) {
            const x = Math.min(width - 1, Math.floor(((gx + 0.5) / gridSize) * width));
            const y = Math.min(height - 1, Math.floor(((gy + 0.5) / gridSize) * height));
            const idx = (y * width + x) * 4;
            redness.push(imageData[idx] - imageData[idx + 1]);
        }
    }
    const mean = redness.reduce((sum, v) => sum + v, 0) / redness.length;
    return redness.reduce((sum, v) => sum + (v - mean) ** 2, 0) / redness.length;
}

/**
 * Combines both signals: only flags suspicious when the sampled color
 * DOESN'T look like plausible skin AND the frame's color texture is
 * unnaturally flat — requiring both cuts down false positives from things
 * like unusual (but real) lighting color casts, which shift skin
 * chromaticity but don't flatten its natural micro-texture.
 */
export function checkColorLiveness(imageData, width, height) {
    const skinFraction = calculateSkinPixelFraction(imageData);
    const chromaVariance = calculateChromaTextureVariance(imageData, width, height);
    const lowSkinPlausibility = skinFraction < MIN_SKIN_PIXEL_FRACTION;
    const flatColorTexture = chromaVariance < CHROMA_VARIANCE_FLAT_THRESHOLD;

    return {
        suspicious: lowSkinPlausibility && flatColorTexture,
        skinFraction,
        chromaVariance,
        lowSkinPlausibility,
        flatColorTexture,
    };
}
