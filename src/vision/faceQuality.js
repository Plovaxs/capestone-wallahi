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
