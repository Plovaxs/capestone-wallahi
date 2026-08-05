import { describe, it, expect } from 'vitest';
import { sampleLuminanceGrid, createMicroMotionTracker } from './microMotionTracker';

function makeSolidImageData(width, height, value) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
        data[i + 3] = 255;
    }
    return data;
}

describe('sampleLuminanceGrid', () => {
    it('returns gridSize*gridSize samples for a valid region', () => {
        const data = makeSolidImageData(20, 20, 100);
        expect(sampleLuminanceGrid(data, 20, 20, 5)).toHaveLength(25);
    });

    it('returns the uniform luminance value for a solid-color image', () => {
        const data = makeSolidImageData(20, 20, 100);
        const samples = sampleLuminanceGrid(data, 20, 20, 5);
        samples.forEach((s) => expect(s).toBeCloseTo(100, 0));
    });

    it('returns an empty array for missing/invalid input', () => {
        expect(sampleLuminanceGrid(null, 20, 20)).toEqual([]);
        expect(sampleLuminanceGrid(new Uint8ClampedArray(4), 0, 0)).toEqual([]);
    });
});

describe('createMicroMotionTracker', () => {
    it('is not ready until bufferSize frames have been added', () => {
        const tracker = createMicroMotionTracker({ bufferSize: 3 });
        tracker.addFrame(makeSolidImageData(10, 10, 100), 10, 10);
        tracker.addFrame(makeSolidImageData(10, 10, 100), 10, 10);
        expect(tracker.getStats().ready).toBe(false);
    });

    it('flags a perfectly static feed (identical frames) as suspiciously flat once ready', () => {
        const tracker = createMicroMotionTracker({ bufferSize: 3 });
        for (let i = 0; i < 3; i++) {
            tracker.addFrame(makeSolidImageData(10, 10, 100), 10, 10);
        }
        const stats = tracker.getStats();
        expect(stats.ready).toBe(true);
        expect(stats.avgVariance).toBe(0);
        expect(stats.isSuspiciouslyFlat).toBe(true);
    });

    it('does not flag a feed with real frame-to-frame luminance variation', () => {
        const tracker = createMicroMotionTracker({ bufferSize: 3, varianceFlatThreshold: 0.15 });
        tracker.addFrame(makeSolidImageData(10, 10, 90), 10, 10);
        tracker.addFrame(makeSolidImageData(10, 10, 100), 10, 10);
        tracker.addFrame(makeSolidImageData(10, 10, 110), 10, 10);
        const stats = tracker.getStats();
        expect(stats.ready).toBe(true);
        expect(stats.isSuspiciouslyFlat).toBe(false);
    });

    it('reset() clears the buffer back to not-ready', () => {
        const tracker = createMicroMotionTracker({ bufferSize: 2 });
        tracker.addFrame(makeSolidImageData(10, 10, 100), 10, 10);
        tracker.addFrame(makeSolidImageData(10, 10, 100), 10, 10);
        expect(tracker.getStats().ready).toBe(true);
        tracker.reset();
        expect(tracker.getStats().ready).toBe(false);
    });

    it('only keeps the most recent bufferSize frames (sliding window)', () => {
        const tracker = createMicroMotionTracker({ bufferSize: 2 });
        tracker.addFrame(makeSolidImageData(10, 10, 0), 10, 10);
        tracker.addFrame(makeSolidImageData(10, 10, 100), 10, 10);
        tracker.addFrame(makeSolidImageData(10, 10, 100), 10, 10);
        // If the oldest (0-luminance) frame were still in the window, variance would be huge.
        const stats = tracker.getStats();
        expect(stats.avgVariance).toBe(0);
    });
});
