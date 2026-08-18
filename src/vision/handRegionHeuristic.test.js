import { describe, it, expect } from 'vitest';
import { checkHandInFrame, checkHandNearFrameEdges } from './handRegionHeuristic';

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
// Real skin (or a real hand) has natural micro-texture -- blood flow, pores
// -- even within a tight crop; a coarse (18px, several times wider than the
// sampler's own 6px stride -- a pixel-level checkerboard would alias to a
// single constant tone under even-stride sampling) alternation between two
// nearby skin-plausible tones (varying R-G "redness" specifically, since
// that's what the texture check measures) gives a synthetic fixture that
// same "not perfectly flat" property.
const SKIN_TONE_TEXTURED = (x, y) => ((Math.floor(x / 18) + Math.floor(y / 18)) % 2 === 0 ? [180, 130, 100] : [175, 135, 95]);

describe('checkHandInFrame', () => {
    it('is not suspicious when the area around the face is a neutral (non-skin) background', () => {
        const frame = makeFrame(() => NEUTRAL);
        const result = checkHandInFrame(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(false);
    });

    it('is suspicious when the area around the face is mostly skin-toned WITH natural texture (hand/fingers holding something up)', () => {
        const frame = makeFrame(SKIN_TONE_TEXTURED);
        const result = checkHandInFrame(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(true);
        expect(result.skinFraction).toBeGreaterThan(0.4);
    });

    // 🟩 REGRESSION TEST: reported live -- unusual (but real) lighting
    // shifted an ordinary background's chromaticity into the skin-plausible
    // band, with nothing skin-colored anywhere near the face, falsely
    // flagging "hand detected." A flat, uniformly-colored surface (unlike
    // real skin, which always has SOME natural tonal micro-variation) is
    // exactly what this is meant to filter out.
    it('is NOT suspicious for a perfectly flat, uniformly-colored surface that merely happens to match skin chromaticity (a lighting-color-cast false positive)', () => {
        const frame = makeFrame(() => SKIN_TONE);
        const result = checkHandInFrame(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(false);
    });

    it('excludes the face box itself from the sample -- only the surrounding band counts', () => {
        // Skin everywhere INSIDE the face box (expected, it's a face), neutral everywhere else.
        const frame = makeFrame((x, y) => {
            const inFace = x >= FACE_BOX.x && x < FACE_BOX.x + FACE_BOX.width && y >= FACE_BOX.y && y < FACE_BOX.y + FACE_BOX.height;
            return inFace ? SKIN_TONE_TEXTURED(x, y) : NEUTRAL;
        });
        const result = checkHandInFrame(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(false);
    });

    it('returns not suspicious with zero samples when given invalid input', () => {
        expect(checkHandInFrame(null, WIDTH, HEIGHT, FACE_BOX)).toEqual({ suspicious: false, skinFraction: 0, samples: 0 });
        expect(checkHandInFrame(new Uint8ClampedArray(4), WIDTH, HEIGHT, null)).toEqual({ suspicious: false, skinFraction: 0, samples: 0 });
    });
});

// 🟩 REGRESSION: reported live -- checkHandInFrame's close-in surround band
// missed fingers gripping a phone/photo near the OUTER EDGES of the whole
// camera frame (a normal holding distance, well past its own band). This
// samples a deliberately DIFFERENT region -- just the frame's own outer
// border strip -- to catch exactly that shape.
describe('checkHandNearFrameEdges', () => {
    it('is not suspicious when the frame border is a neutral (non-skin) background', () => {
        const frame = makeFrame(() => NEUTRAL);
        const result = checkHandNearFrameEdges(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(false);
    });

    it('is suspicious when skin-toned pixels WITH natural texture dominate the outer border strip even though the face/surround area stays clean', () => {
        // The edge band is ~16% of each dimension in from every side; the
        // FACE_BOX (40-80 in a 160x160 frame) sits well inside it and never
        // gets sampled by this check either way.
        const bandX = Math.round(WIDTH * 0.16);
        const bandY = Math.round(HEIGHT * 0.16);
        const frame = makeFrame((x, y) => {
            const inEdgeBand = x < bandX || x >= WIDTH - bandX || y < bandY || y >= HEIGHT - bandY;
            return inEdgeBand ? SKIN_TONE_TEXTURED(x, y) : NEUTRAL;
        });
        const result = checkHandNearFrameEdges(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(true);
    });

    it('a normal, tightly-framed selfie (skin only near the center, not at the outer edges) is not suspicious', () => {
        // A real person's face/neck/shoulders sit centered in frame -- the
        // outer border strip this checks stays background (wall/desk), not
        // skin, unlike someone gripping a device out toward the frame edges.
        const frame = makeFrame((x, y) => {
            const nearCenter = x > 50 && x < 110 && y > 50 && y < 110;
            return nearCenter ? SKIN_TONE_TEXTURED(x, y) : NEUTRAL;
        });
        const result = checkHandNearFrameEdges(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(false);
    });

    // 🟩 REGRESSION TEST: same lighting-color-cast false positive as
    // checkHandInFrame's own regression test above.
    it('is NOT suspicious for a perfectly flat, uniformly-colored border that merely happens to match skin chromaticity', () => {
        const bandX = Math.round(WIDTH * 0.16);
        const bandY = Math.round(HEIGHT * 0.16);
        const frame = makeFrame((x, y) => {
            const inEdgeBand = x < bandX || x >= WIDTH - bandX || y < bandY || y >= HEIGHT - bandY;
            return inEdgeBand ? SKIN_TONE : NEUTRAL;
        });
        const result = checkHandNearFrameEdges(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(false);
    });

    it('returns not suspicious with zero samples when given invalid input', () => {
        expect(checkHandNearFrameEdges(null, WIDTH, HEIGHT, FACE_BOX)).toEqual({ suspicious: false, skinFraction: 0, samples: 0 });
    });
});
