import { describe, it, expect } from 'vitest';
import { calculateEdgeEnergyGrid, checkTextureSharpness } from './textureSharpnessHeuristic';

function makeImageData(width, height, pixelFn) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const [r, g, b] = pixelFn(x, y);
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255;
        }
    }
    return data;
}

describe('calculateEdgeEnergyGrid', () => {
    it('returns near-zero energy for a perfectly flat solid color', () => {
        const data = makeImageData(24, 24, () => [150, 120, 100]);
        const energies = calculateEdgeEnergyGrid(data, 24, 24);
        expect(energies.every((e) => e === 0)).toBe(true);
    });

    it('returns non-zero energy for a frame with real local detail', () => {
        const data = makeImageData(24, 24, (x, y) => [((x * 37 + y * 17) % 255), 120, 100]);
        const energies = calculateEdgeEnergyGrid(data, 24, 24);
        expect(energies.some((e) => e > 0)).toBe(true);
    });

    it('returns an empty array for missing/invalid input', () => {
        expect(calculateEdgeEnergyGrid(null, 24, 24)).toEqual([]);
        expect(calculateEdgeEnergyGrid(new Uint8ClampedArray(4), 0, 0)).toEqual([]);
    });
});

describe('checkTextureSharpness', () => {
    it('flags a perfectly flat frame as suspicious (print/screen smoothing)', () => {
        const data = makeImageData(24, 24, () => [150, 120, 100]);
        expect(checkTextureSharpness(data, 24, 24).suspicious).toBe(true);
    });

    it('does not flag a frame with real fine-grained detail', () => {
        const data = makeImageData(24, 24, (x, y) => [((x * 53 + y * 29) % 255), 120, 100]);
        expect(checkTextureSharpness(data, 24, 24).suspicious).toBe(false);
    });

    it('is not suspicious for missing input (no false positive on a bad read)', () => {
        expect(checkTextureSharpness(null, 24, 24).suspicious).toBe(false);
    });
});
