/**
 * Screen-color-reflection liveness check, inspired by the publicly
 * documented high-level approach behind iProov's "Flashmark" (a real,
 * ISO 30107-certified commercial product): flash a few randomized colors
 * on screen in sequence and check whether the face in front of the camera
 * shows a matching reflectance change. A live face genuinely reflects
 * whatever light is hitting it; a printed photo or a screen replay
 * doesn't respond to a NEW randomly-generated color pattern it wasn't
 * recorded under.
 *
 * Deliberately built as an ADVISORY signal (one more vote for
 * livenessFusion.js), not a hard blocking gate like the mandatory rPPG
 * pulse check -- its reliability depends on screen brightness, ambient
 * lighting, and face-to-screen distance in ways this project hasn't been
 * able to calibrate against real hardware yet. Treating an uncalibrated
 * signal as a hard gate risks exactly the false-positive lockout this
 * app already hit once with the virtual-camera detector.
 */
const FLASH_COLORS = [
    { name: 'red', rgb: [230, 40, 40] },
    { name: 'green', rgb: [40, 210, 90] },
    { name: 'blue', rgb: [50, 90, 230] },
];
const DEFAULT_FLASH_COUNT = 3;
// Cosine-similarity-like score threshold (range roughly [-1, 1]) -- how
// strongly the observed face-region color delta must lean toward the
// flashed color's own channel emphasis to count as a genuine reflection
// rather than coincidental ambient-lighting/motion noise. A starting
// point, not yet tuned against real hardware -- see the module comment.
const CORRELATION_PASS_THRESHOLD = 0.15;

export function pickRandomFlashSequence(count = DEFAULT_FLASH_COUNT) {
    const sequence = [];
    for (let i = 0; i < count; i++) {
        sequence.push(FLASH_COLORS[Math.floor(Math.random() * FLASH_COLORS.length)]);
    }
    return sequence;
}

/** Average [r,g,b] over an RGBA ImageData-style buffer. */
export function calculateAverageRGB(imageData) {
    if (!imageData || imageData.length === 0) return [0, 0, 0];
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let i = 0; i < imageData.length; i += 4) {
        r += imageData[i];
        g += imageData[i + 1];
        b += imageData[i + 2];
        count++;
    }
    if (count === 0) return [0, 0, 0];
    return [r / count, g / count, b / count];
}

/**
 * Cosine similarity between the flashed color's own RGB emphasis and the
 * OBSERVED color delta during that flash -- positive and large when the
 * delta genuinely leans toward the flashed color's dominant channel(s),
 * near-zero for unrelated/noisy deltas, negative if the face got LESS of
 * that color (the opposite of a real reflection).
 */
function reflectionScore(flashRgb, deltaRgb) {
    const dot = flashRgb[0] * deltaRgb[0] + flashRgb[1] * deltaRgb[1] + flashRgb[2] * deltaRgb[2];
    const flashMag = Math.hypot(...flashRgb) || 1;
    const deltaMag = Math.hypot(...deltaRgb) || 1;
    if (deltaMag === 0) return 0;
    return dot / (flashMag * deltaMag);
}

export class ScreenReflectionChallenge {
    constructor({ sequence = pickRandomFlashSequence() } = {}) {
        this._resetState(sequence);
    }

    _resetState(sequence) {
        this.sequence = sequence;
        this.stepIndex = 0;
        this.baselineRgb = null;
        this.scores = [];
        this.confirmed = false;
        this.failed = false;
    }

    /** The color the UI should currently be flashing, or null once every step is done. */
    get currentFlashColor() {
        return this.stepIndex < this.sequence.length ? this.sequence[this.stepIndex].rgb : null;
    }

    get isComplete() {
        return this.stepIndex >= this.sequence.length;
    }

    /** Call once, right before a flash starts, with the neutral/ambient face-region [r,g,b]. */
    recordBaseline(avgRgb) {
        this.baselineRgb = avgRgb;
    }

    /** Call once per flash step, with the average face-region [r,g,b] sampled DURING that flash. */
    recordFlashSample(avgRgbDuringFlash) {
        if (this.isComplete || !this.baselineRgb) return;

        const deltaRgb = avgRgbDuringFlash.map((v, i) => v - this.baselineRgb[i]);
        this.scores.push(reflectionScore(this.currentFlashColor, deltaRgb));
        this.stepIndex += 1;
        this.baselineRgb = null;

        if (this.isComplete) {
            const avgScore = this.scores.reduce((s, v) => s + v, 0) / this.scores.length;
            this.confirmed = avgScore >= CORRELATION_PASS_THRESHOLD;
            this.failed = !this.confirmed;
        }
    }

    reset(sequence = pickRandomFlashSequence()) {
        this._resetState(sequence);
    }
}
