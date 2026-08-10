import { describe, it, expect } from 'vitest';
import { checkDeviceEdges } from './deviceEdgeHeuristic';

const WIDTH = 30;
const HEIGHT = 30;

function makeFrame(fillFn) {
    const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const idx = (y * WIDTH + x) * 4;
            const v = fillFn(x, y);
            data[idx] = v;
            data[idx + 1] = v;
            data[idx + 2] = v;
            data[idx + 3] = 255;
        }
    }
    return data;
}

describe('checkDeviceEdges', () => {
    it('is not suspicious for a flat, uniform frame (no edges at all)', () => {
        const frame = makeFrame(() => 128);
        expect(checkDeviceEdges(frame, WIDTH, HEIGHT).suspicious).toBe(false);
    });

    it('is not suspicious for organic, spread-out texture (random-ish noise)', () => {
        // Deterministic pseudo-noise so the test is stable, but distributed across many columns/rows rather than one dominant line.
        const frame = makeFrame((x, y) => 100 + ((x * 37 + y * 17) % 40));
        expect(checkDeviceEdges(frame, WIDTH, HEIGHT).suspicious).toBe(false);
    });

    it('is suspicious when one dominant vertical line runs through the frame (a phone/photo edge)', () => {
        const frame = makeFrame((x) => (x === 15 ? 255 : 100));
        const result = checkDeviceEdges(frame, WIDTH, HEIGHT);
        expect(result.suspicious).toBe(true);
        expect(result.verticalPeakRatio).toBeGreaterThan(4);
    });

    it('is suspicious when one dominant horizontal line runs through the frame', () => {
        const frame = makeFrame((_, y) => (y === 15 ? 255 : 100));
        const result = checkDeviceEdges(frame, WIDTH, HEIGHT);
        expect(result.suspicious).toBe(true);
        expect(result.horizontalPeakRatio).toBeGreaterThan(4);
    });

    it('handles invalid input without throwing', () => {
        expect(checkDeviceEdges(null, WIDTH, HEIGHT)).toEqual({ suspicious: false, verticalPeakRatio: 0, horizontalPeakRatio: 0 });
        expect(checkDeviceEdges(new Uint8ClampedArray(4), 1, 1)).toEqual({ suspicious: false, verticalPeakRatio: 0, horizontalPeakRatio: 0 });
    });
});
