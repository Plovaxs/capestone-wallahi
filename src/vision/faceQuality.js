import { luminanceAtIndex } from './colorMath';

/**
 * Pure, framework-free quality gates run on each scan frame before a match
 * attempt is trusted. All of them return { ok, reason } instead of
 * throwing, so a caller can show a specific hint ("too far", "too dark",
 * "more than one face") instead of a generic failure.
 */

/** Face too small/large or off-center relative to the frame. */
export function checkFraming(box, imageWidth, imageHeight) {
    if (!box || !imageWidth || !imageHeight) return { ok: false, reason: 'no-face' };

    const areaRatio = (box.width * box.height) / (imageWidth * imageHeight);
    if (areaRatio < 0.015) return { ok: false, reason: 'too-far' };
    if (areaRatio > 0.95) return { ok: false, reason: 'too-close' };

    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const offsetX = Math.abs(centerX - imageWidth / 2) / imageWidth;
    const offsetY = Math.abs(centerY - imageHeight / 2) / imageHeight;
    if (offsetX > 0.42 || offsetY > 0.42) return { ok: false, reason: 'off-center' };

    return { ok: true, reason: null };
}

/** Scene too dark or blown out for a reliable descriptor, from a canvas ImageData's RGBA buffer. */
export function checkBrightness(imageData) {
    if (!imageData || imageData.length === 0) return { ok: true, reason: null };

    let total = 0;
    const pixelCount = imageData.length / 4;
    for (let i = 0; i < imageData.length; i += 4) {
        total += luminanceAtIndex(imageData, i);
    }
    const avg = total / pixelCount;

    if (avg < 25) return { ok: false, reason: 'too-dark' };
    if (avg > 240) return { ok: false, reason: 'too-bright' };
    return { ok: true, reason: null };
}

/** Low detector confidence is a proxy for partial occlusion (mask, hand, extreme angle). */
export function checkOcclusion(detectionScore, minScore = 0.25) {
    if (typeof detectionScore !== 'number') return { ok: true, reason: null };
    if (detectionScore < minScore) return { ok: false, reason: 'low-confidence' };
    return { ok: true, reason: null };
}

/**
 * Detects a fogged, smudged, or otherwise physically obstructed lens by
 * measuring high-frequency detail (a cheap pixel-gradient proxy for
 * sharpness) across the *whole* captured frame, not just the face region.
 * A dirty/fogged lens blurs everything uniformly — background included —
 * which is what separates it from "face is just a bit soft" (which the
 * per-face occlusion/confidence check above already covers) or "scene is
 * dark" (a dim-but-clear image still has sharp edges, just faint ones).
 *
 * Samples on a stride instead of every pixel — this runs once per scan
 * tick and only needs to be a rough signal, not a precise metric.
 *
 * 🟩 BUG FIX: averaging the gradient across every sampled pixel false-
 * flagged perfectly clean webcams pointed at a real (mostly plain-colored:
 * a wall, a desk, a monitor) room — most of a real frame has little
 * texture even with a razor-sharp lens, which drags the *average* down
 * near the "obstructed" threshold regardless of focus. A checkerboard
 * test pattern (100% high-frequency) never exposed this because it has
 * no flat regions to dilute the average. A genuinely fogged/smudged lens
 * blurs EVERYTHING uniformly, including whatever sharp edges the scene
 * does have (a face outline, a monitor bezel) — so the top percentile of
 * sampled gradients (the sharpest edges actually present) separates the
 * two cases correctly where the average cannot: real fog drags even the
 * sharpest edges down, while a clear lens keeps them sharp no matter how
 * plain the rest of the room is.
 */
export function checkLensObstruction(imageData, width, height, { minSharpness = 40, sampleStride = 4, sharpPercentile = 0.9 } = {}) {
    if (!imageData || !width || !height) return { ok: true, reason: null };

    const luminance = (i) => luminanceAtIndex(imageData, i);

    const gradients = [];
    for (let y = 0; y < height - 1; y += sampleStride) {
        for (let x = 0; x < width - 1; x += sampleStride) {
            const idx = (y * width + x) * 4;
            const idxRight = (y * width + (x + 1)) * 4;
            const idxDown = ((y + 1) * width + x) * 4;
            gradients.push(Math.abs(luminance(idx) - luminance(idxRight)) + Math.abs(luminance(idx) - luminance(idxDown)));
        }
    }

    if (gradients.length === 0) return { ok: true, reason: null };
    gradients.sort((a, b) => a - b);
    const sharpEdgeGradient = gradients[Math.floor(gradients.length * sharpPercentile)];
    if (sharpEdgeGradient < minSharpness) return { ok: false, reason: 'lens-obstructed' };
    return { ok: true, reason: null };
}

/**
 * Only rejects on `isAmbiguous` (a second face similarly-sized AND adjacent
 * to the primary one — the actual "hold up someone else's photo" attack
 * shape), not merely on faceCount > 1. Extra faces from bystanders in a
 * busy background are common in real deployments and shouldn't block a
 * legitimate scan; see vision/primaryFaceSelector.js for the selection logic.
 */
export function checkSingleFace(faceCount, isAmbiguous = false) {
    if (faceCount === 0) return { ok: false, reason: 'no-face' };
    if (isAmbiguous) return { ok: false, reason: 'multiple-faces' };
    return { ok: true, reason: null };
}
