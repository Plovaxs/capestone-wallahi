import { describe, it, expect } from 'vitest';
import { checkScreenGlare } from './screenGlareHeuristic';

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

const inFaceBox = (x, y) => x >= FACE_BOX.x && x < FACE_BOX.x + FACE_BOX.width && y >= FACE_BOX.y && y < FACE_BOX.y + FACE_BOX.height;

describe('checkScreenGlare', () => {
    it('is not suspicious when the face reads about as bright as its own surroundings (a real face under normal ambient light)', () => {
        const frame = makeFrame(() => [110, 100, 90]);
        const result = checkScreenGlare(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(false);
    });

    it('is suspicious when the face region is much brighter than its surroundings (a self-lit phone/tablet screen)', () => {
        const frame = makeFrame((x, y) => (inFaceBox(x, y) ? [235, 235, 235] : [60, 55, 50]));
        const result = checkScreenGlare(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(true);
        expect(result.faceLuminance).toBeGreaterThan(result.backgroundLuminance);
    });

    it('is not suspicious for a modest brightness difference (e.g. a desk lamp aimed at a real face)', () => {
        const frame = makeFrame((x, y) => (inFaceBox(x, y) ? [140, 130, 120] : [100, 95, 90]));
        const result = checkScreenGlare(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(false);
    });

    it('is not suspicious when the face is DARKER than its surroundings (backlit real face, still not emissive)', () => {
        const frame = makeFrame((x, y) => (inFaceBox(x, y) ? [60, 55, 50] : [200, 200, 200]));
        const result = checkScreenGlare(frame, WIDTH, HEIGHT, FACE_BOX);
        expect(result.suspicious).toBe(false);
    });

    it('returns not suspicious with zero samples when given invalid input', () => {
        expect(checkScreenGlare(null, WIDTH, HEIGHT, FACE_BOX)).toEqual({ suspicious: false, faceLuminance: 0, backgroundLuminance: 0, samples: 0 });
        expect(checkScreenGlare(new Uint8ClampedArray(4), WIDTH, HEIGHT, null)).toEqual({ suspicious: false, faceLuminance: 0, backgroundLuminance: 0, samples: 0 });
    });
});
