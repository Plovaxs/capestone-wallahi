import { describe, it, expect } from 'vitest';
import { toGrayscale, calculateSharpness, checkEnrollmentQuality } from './enrollmentQuality';

const makeFlatImageData = (value, width, height) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
    }
    return data;
};

const makeCheckerboardImageData = (width, height) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const value = (x + y) % 2 === 0 ? 20 : 235;
            data[idx] = value; data[idx + 1] = value; data[idx + 2] = value; data[idx + 3] = 255;
        }
    }
    return data;
};

describe('toGrayscale', () => {
    it('converts an RGBA buffer to one grayscale value per pixel', () => {
        const data = makeFlatImageData(100, 4, 4);
        const gray = toGrayscale(data);
        expect(gray.length).toBe(16);
        expect(gray[0]).toBeCloseTo(100, 0);
    });
});

describe('calculateSharpness', () => {
    it('is near zero for a perfectly flat (blurry) image', () => {
        const gray = toGrayscale(makeFlatImageData(128, 20, 20));
        expect(calculateSharpness(gray, 20, 20)).toBeCloseTo(0, 5);
    });

    it('is high for a high-contrast checkerboard (sharp edges)', () => {
        const gray = toGrayscale(makeCheckerboardImageData(20, 20));
        expect(calculateSharpness(gray, 20, 20)).toBeGreaterThan(1000);
    });
});

describe('checkEnrollmentQuality', () => {
    it('rejects a flat, blurry-looking capture', () => {
        const result = checkEnrollmentQuality(makeFlatImageData(128, 20, 20), 20, 20);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('too-blurry');
    });

    it('rejects a too-dark capture before even checking sharpness', () => {
        const result = checkEnrollmentQuality(makeFlatImageData(5, 20, 20), 20, 20);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('too-dark');
    });

    it('accepts a well-lit, sharp capture', () => {
        const result = checkEnrollmentQuality(makeCheckerboardImageData(20, 20), 20, 20);
        expect(result.ok).toBe(true);
    });
});
