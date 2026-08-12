import { SKIN_R_MIN, SKIN_R_MAX, SKIN_G_MIN, SKIN_G_MAX } from './colorLivenessHeuristic';

/**
 * Detects a large skin-toned region immediately around (but outside) the
 * detected face box -- the classic signature of fingers/a hand holding a
 * phone or a printed photo up in front of the camera. A live person
 * sitting normally in front of a webcam has mostly non-skin background
 * (wall, desk, clothing) surrounding their face; someone holding a device
 * or photo close to their face to spoof the scan typically has a
 * hand/fingers filling a meaningfully larger fraction of that immediate
 * surrounding band than incidental background skin (a shoulder, a neck)
 * would. One more independent vote for livenessFusion.js -- same
 * multi-signal design as every other heuristic here, not a standalone
 * hard gate on its own (skin-toned walls/furniture, someone resting a
 * hand near their own face, etc. are all real false-positive risks for
 * a single frame).
 */
// 🟩 LOOSENED (2026-08-12, real-user report): "detected hand while not being
// there" -- the sampled surround band extends 60% of the face box's own
// size outward (SURROUND_MARGIN_RATIO below), which for a typical laptop-
// webcam framing (face fills a good portion of the frame, tight face-only
// bounding box) reaches straight into ordinary neck/collar/shoulder skin
// for MOST people, not just someone holding something up. 0.45 meant that
// alone was often enough to flag "hand" with zero hand ever in frame.
// Raised so genuinely normal necklines stop tripping it; a real hand/
// fingers filling most of that band (holding a phone or photo close to the
// face) still comfortably clears this. Uncalibrated against a wide range
// of real camera framings/skin tones -- if it's still misfiring, this
// needs to go higher still, or SURROUND_MARGIN_RATIO needs to shrink so
// the sampled band doesn't reach as far into the neck.
const HAND_REGION_SKIN_FRACTION_THRESHOLD = 0.65;
const MIN_SAMPLES = 20;
const SAMPLE_STRIDE = 6;
const SURROUND_MARGIN_RATIO = 0.6;

/**
 * @param {Uint8ClampedArray} imageData - full-frame RGBA pixel data (e.g. from ctx.getImageData(0,0,width,height).data)
 * @param {number} width - full frame width
 * @param {number} height - full frame height
 * @param {{x:number,y:number,width:number,height:number}} faceBox - the detected face bounding box, same pixel coordinate space as imageData
 */
export function checkHandInFrame(imageData, width, height, faceBox) {
    if (!imageData || !width || !height || !faceBox || !faceBox.width || !faceBox.height) {
        return { suspicious: false, skinFraction: 0, samples: 0 };
    }

    const marginX = Math.round(faceBox.width * SURROUND_MARGIN_RATIO);
    const marginY = Math.round(faceBox.height * SURROUND_MARGIN_RATIO);
    const outerX0 = Math.max(0, Math.round(faceBox.x - marginX));
    const outerY0 = Math.max(0, Math.round(faceBox.y - marginY));
    const outerX1 = Math.min(width, Math.round(faceBox.x + faceBox.width + marginX));
    const outerY1 = Math.min(height, Math.round(faceBox.y + faceBox.height + marginY));
    const innerX0 = Math.round(faceBox.x);
    const innerY0 = Math.round(faceBox.y);
    const innerX1 = Math.round(faceBox.x + faceBox.width);
    const innerY1 = Math.round(faceBox.y + faceBox.height);

    let skinCount = 0;
    let sampled = 0;
    for (let y = outerY0; y < outerY1; y += SAMPLE_STRIDE) {
        const insideFaceRow = y >= innerY0 && y < innerY1;
        for (let x = outerX0; x < outerX1; x += SAMPLE_STRIDE) {
            if (insideFaceRow && x >= innerX0 && x < innerX1) continue; // skip the face box itself -- only the surrounding band matters
            const idx = (y * width + x) * 4;
            const r = imageData[idx];
            const g = imageData[idx + 1];
            const b = imageData[idx + 2];
            const sum = r + g + b;
            if (sum === 0) continue;
            sampled++;
            const rNorm = r / sum;
            const gNorm = g / sum;
            if (rNorm >= SKIN_R_MIN && rNorm <= SKIN_R_MAX && gNorm >= SKIN_G_MIN && gNorm <= SKIN_G_MAX) {
                skinCount++;
            }
        }
    }

    if (sampled < MIN_SAMPLES) return { suspicious: false, skinFraction: 0, samples: sampled };

    const skinFraction = skinCount / sampled;
    return { suspicious: skinFraction >= HAND_REGION_SKIN_FRACTION_THRESHOLD, skinFraction, samples: sampled };
}
