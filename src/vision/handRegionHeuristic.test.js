import { describe, it, expect } from 'vitest';
import { checkHandInFrame } from './handRegionHeuristic';

// Sized so the sampled surround band clears MIN_SAMPLES even with the
// stride -- a rough proxy for a real camera crop (e.g. 640x480) rather
// than a tiny grid that starves the sampler regardless of pixel content.
const WIDTH = 160;
const HEIGHT = 160;
const FACE_BOX = { x: 40, y: 40, width: 40, height: 40 };

function makeFrame(fillFn) {
    const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const idx = (y * WIDTH + x) * 4;
            const [r, g, b] = fillFn(x, y);
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255;
        }
    }
    return data;
}

// A neutral gray background -- not skin-plausible chromaticity.
const NEUTRAL = [120, 120, 120];
// A color inside the skin-plausible chromaticity band (see colorLivenessHeuristic.js).
const SKIN_TONE = [180, 130, 100];

describe('checkHandInFrame', () => {
    it('is not suspicious when the area around the face is a neutral (non-skin) background', () => {
        const frame = makeFrame(() => NEUTRAL);
        const result = checkHandInFrame(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(false);
    });

    it('is suspicious when the area around the face is mostly skin-toned (hand/fingers holding something up)', () => {
        const frame = makeFrame(() => SKIN_TONE);
        const result = checkHandInFrame(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(true);
        expect(result.skinFraction).toBeGreaterThan(0.4);
    });

    it('excludes the face box itself from the sample -- only the surrounding band counts', () => {
        // Skin everywhere INSIDE the face box (expected, it's a face), neutral everywhere else.
        const frame = makeFrame((x, y) => {
            const inFace = x >= FACE_BOX.x && x < FACE_BOX.x + FACE_BOX.width && y >= FACE_BOX.y && y < FACE_BOX.y + FACE_BOX.height;
            return inFace ? SKIN_TONE : NEUTRAL;
        });
        const result = checkHandInFrame(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(false);
    });

    it('returns not suspicious with zero samples when given invalid input', () => {
        expect(checkHandInFrame(null, WIDTH, HEIGHT, FACE_BOX)).toEqual({ suspicious: false, skinFraction: 0, samples: 0 });
        expect(checkHandInFrame(new Uint8ClampedArray(4), WIDTH, HEIGHT, null)).toEqual({ suspicious: false, skinFraction: 0, samples: 0 });
    });
});
