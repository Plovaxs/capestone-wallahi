import { describe, it, expect } from 'vitest';
import { calculateSkinPixelFraction, calculateChromaTextureVariance, checkColorLiveness } from './colorLivenessHeuristic';

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

describe('calculateSkinPixelFraction', () => {
    it('returns a high fraction for a plausible mid-tone skin color', () => {
        // r≈0.40, g≈0.32 -- inside the skin band regardless of exact skin tone.
        const data = makeImageData(20, 20, () => [190, 150, 120]);
        expect(calculateSkinPixelFraction(data)).toBeGreaterThan(0.9);
    });

    it('returns ~0 for a saturated non-skin color (pure blue)', () => {
        const data = makeImageData(20, 20, () => [10, 10, 220]);
        expect(calculateSkinPixelFraction(data)).toBeCloseTo(0, 1);
    });

    it('returns 0 for missing/empty input', () => {
        expect(calculateSkinPixelFraction(null)).toBe(0);
        expect(calculateSkinPixelFraction(new Uint8ClampedArray(0))).toBe(0);
    });
});

describe('calculateChromaTextureVariance', () => {
    it('is 0 for a perfectly flat solid color (no spatial texture)', () => {
        const data = makeImageData(20, 20, () => [180, 140, 110]);
        expect(calculateChromaTextureVariance(data, 20, 20)).toBe(0);
    });

    it('is > 0 for a frame with real spatial redness variation', () => {
        const data = makeImageData(20, 20, (x, y) => [150 + ((x + y) % 7) * 5, 120, 100]);
        expect(calculateChromaTextureVariance(data, 20, 20)).toBeGreaterThan(0);
    });

    it('returns 0 for missing/invalid input', () => {
        expect(calculateChromaTextureVariance(null, 20, 20)).toBe(0);
        expect(calculateChromaTextureVariance(new Uint8ClampedArray(4), 0, 0)).toBe(0);
    });
});

describe('checkColorLiveness', () => {
    it('is not suspicious for a plausible, textured skin-like frame', () => {
        const data = makeImageData(20, 20, (x, y) => [180 + ((x * y) % 11), 140, 110]);
        const result = checkColorLiveness(data, 20, 20);
        expect(result.suspicious).toBe(false);
    });

    it('is suspicious only when BOTH low skin plausibility AND flat texture hold', () => {
        // Saturated blue, perfectly flat -- fails skin plausibility AND has zero texture.
        const flatNonSkin = makeImageData(20, 20, () => [10, 10, 220]);
        expect(checkColorLiveness(flatNonSkin, 20, 20).suspicious).toBe(true);
    });

    it('is not suspicious when non-skin color still has real spatial texture', () => {
        // Not skin-plausible, but has genuine per-pixel variation in redness (R-G) -- only one signal fires.
        const texturedNonSkin = makeImageData(20, 20, (x, y) => [10 + ((x + y) % 9) * 6, 10, 220]);
        expect(checkColorLiveness(texturedNonSkin, 20, 20).suspicious).toBe(false);
    });

    it('is not suspicious when skin-plausible but flat (real still face under even lighting)', () => {
        const flatSkin = makeImageData(20, 20, () => [190, 150, 120]);
        expect(checkColorLiveness(flatSkin, 20, 20).suspicious).toBe(false);
    });
});
