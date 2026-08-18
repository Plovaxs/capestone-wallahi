import { luminanceAtIndex } from './colorMath';

/**
 * Detects a self-illuminating screen (a phone/tablet displaying a photo)
 * held up in front of the camera, by comparing the detected FACE region's
 * average brightness against the surrounding background's. A real face
 * only ever REFLECTS whatever light is already in the room, so under
 * normal, roughly-even ambient lighting it reads about as bright as its
 * own surroundings (a wall, a desk, a shoulder). A phone/tablet screen
 * displaying a photo EMITS its own backlight on top of that -- it reads
 * meaningfully brighter than the same room's ambient background, which
 * printed photos, real skin, and every other non-emissive surface simply
 * can't do. One more independent vote for livenessFusion.js, same
 * non-hard-gate treatment as every other heuristic here (someone sitting
 * directly under a desk lamp pointed at their own face is a real, if
 * uncommon, false-positive risk for a single frame).
 *
 * Deliberately does NOT try to catch a printed/physical photo (a "pas
 * foto") this way -- paper doesn't emit light either, so brightness alone
 * can't tell it apart from a real face. That case is already covered by
 * the pixel/device-motion "static" checks (a printed photo held even
 * slightly wobbly still shows almost none of a live face's natural
 * micro-motion) and the color/texture-plausibility checks elsewhere in
 * this pipeline -- this heuristic is specifically the screen-glare gap
 * those don't cover.
 */
const SAMPLE_STRIDE = 6;
const MIN_SAMPLES = 20;
// 🟩 Not calibrated against real hardware/lighting -- a typical phone
// screen at normal brightness in an indoor room reads well past this over
// its own reflective surroundings; genuine face-lit-brighter-than-
// background scenarios (a desk lamp aimed at the user) are usually a more
// modest difference. Loosen if that keeps getting flagged, tighten if a
// screen-replay still slips through at a dimmed brightness setting.
const SCREEN_GLARE_LUMINANCE_DELTA = 45;

export function checkScreenGlare(imageData, width, height, faceBox) {
    if (!imageData || !width || !height || !faceBox || !faceBox.width || !faceBox.height) {
        return { suspicious: false, faceLuminance: 0, backgroundLuminance: 0, samples: 0 };
    }

    const innerX0 = Math.round(faceBox.x);
    const innerY0 = Math.round(faceBox.y);
    const innerX1 = Math.round(faceBox.x + faceBox.width);
    const innerY1 = Math.round(faceBox.y + faceBox.height);

    let faceSum = 0;
    let faceCount = 0;
    let backgroundSum = 0;
    let backgroundCount = 0;

    for (let y = 0; y < height; y += SAMPLE_STRIDE) {
        const inFaceRow = y >= innerY0 && y < innerY1;
        for (let x = 0; x < width; x += SAMPLE_STRIDE) {
            const idx = (y * width + x) * 4;
            const luminance = luminanceAtIndex(imageData, idx);
            if (inFaceRow && x >= innerX0 && x < innerX1) {
                faceSum += luminance;
                faceCount++;
            } else {
                backgroundSum += luminance;
                backgroundCount++;
            }
        }
    }

    if (faceCount < MIN_SAMPLES || backgroundCount < MIN_SAMPLES) {
        return { suspicious: false, faceLuminance: 0, backgroundLuminance: 0, samples: faceCount + backgroundCount };
    }

    const faceLuminance = faceSum / faceCount;
    const backgroundLuminance = backgroundSum / backgroundCount;
    return {
        suspicious: faceLuminance - backgroundLuminance >= SCREEN_GLARE_LUMINANCE_DELTA,
        faceLuminance,
        backgroundLuminance,
        samples: faceCount + backgroundCount,
    };
}
