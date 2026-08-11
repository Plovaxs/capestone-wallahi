import { checkBrightness } from './faceQuality';
import { luminanceAtIndex } from './colorMath';

/** RGBA canvas pixel buffer -> single-channel grayscale values (perceptual luminance). */
export function toGrayscale(imageDataRGBA) {
    const pixelCount = imageDataRGBA.length / 4;
    const gray = new Float64Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        gray[i] = luminanceAtIndex(imageDataRGBA, i * 4);
    }
    return gray;
}

/**
 * Blur/sharpness estimate via variance of a Laplacian edge response: a
 * sharp image has strong, varied edge responses; a blurry one flattens
 * them out. Classic, cheap, no ML model needed.
 */
export function calculateSharpness(grayscale, width, height) {
    if (!grayscale || width < 3 || height < 3) return 0;

    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = y * width + x;
            const laplacian =
                -4 * grayscale[idx] +
                grayscale[idx - 1] + grayscale[idx + 1] +
                grayscale[idx - width] + grayscale[idx + width];
            sum += laplacian;
            sumSq += laplacian * laplacian;
            count++;
        }
    }
    if (count === 0) return 0;
    const mean = sum / count;
    return sumSq / count - mean * mean;
}

// 🟩 LOOSENED: real users reported enrollment being frustratingly hard to
// pass — a profile-ish angle (left/right/up/down poses) naturally has less
// crisp edge detail than a straight-on shot even on decent hardware/
// lighting, and this was rejecting good-enough captures as "too blurry".
const MIN_SHARPNESS = 12;

/**
 * Gate run once, at enrollment time — rejecting a blurry or badly-lit
 * capture up front is far cheaper than discovering the stored reference
 * descriptor is unreliable every day afterward at clock-in.
 */
export function checkEnrollmentQuality(imageDataRGBA, width, height) {
    const brightness = checkBrightness(imageDataRGBA);
    if (!brightness.ok) return { ok: false, reason: brightness.reason };

    const gray = toGrayscale(imageDataRGBA);
    const sharpness = calculateSharpness(gray, width, height);
    if (sharpness < MIN_SHARPNESS) return { ok: false, reason: 'too-blurry', sharpness };

    return { ok: true, reason: null, sharpness };
}
