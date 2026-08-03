import { describe, it, expect } from 'vitest';
import { calculateLuminanceStdDev, checkReplaySuspicion } from './antiReplayHeuristic';

const makeUniformImageData = (value, pixels = 200) => {
    const data = new Uint8ClampedArray(pixels * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
    }
    return data;
};

const makeNoisyImageData = (pixels = 200) => {
    const data = new Uint8ClampedArray(pixels * 4);
    for (let i = 0; i < data.length; i += 4) {
        const value = (i * 37) % 256; // deterministic but highly varied
        data[i] = value; data[i + 1] = (value + 60) % 256; data[i + 2] = (value + 120) % 256; data[i + 3] = 255;
    }
    return data;
};

describe('calculateLuminanceStdDev', () => {
    it('is 0 for a perfectly uniform region', () => {
        expect(calculateLuminanceStdDev(makeUniformImageData(128))).toBe(0);
    });

    it('is greater than 0 for a textured/noisy region', () => {
        expect(calculateLuminanceStdDev(makeNoisyImageData())).toBeGreaterThan(0);
    });

    it('returns 0 for empty input', () => {
        expect(calculateLuminanceStdDev(new Uint8ClampedArray(0))).toBe(0);
    });
});

describe('checkReplaySuspicion', () => {
    it('flags a suspiciously uniform border region', () => {
        const result = checkReplaySuspicion(makeUniformImageData(50));
        expect(result.suspicious).toBe(true);
        expect(result.reason).toBe('uniform-border');
    });

    it('does not flag a naturally textured border region', () => {
        const result = checkReplaySuspicion(makeNoisyImageData());
        expect(result.suspicious).toBe(false);
        expect(result.reason).toBeNull();
    });
});
