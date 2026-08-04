import { describe, it, expect } from 'vitest';
import { createMotionStabilityTracker } from './motionStability';

describe('createMotionStabilityTracker', () => {
    it('is not ready until the buffer fills up', () => {
        const tracker = createMotionStabilityTracker({ bufferSize: 5 });
        tracker.addReading({ x: 0.1, y: 9.8, z: 0.2 });
        expect(tracker.getStats()).toEqual({ ready: false, variance: 0, isSuspiciouslyFlat: false });
    });

    it('flags a perfectly motionless device (identical readings) as suspiciously flat', () => {
        const tracker = createMotionStabilityTracker({ bufferSize: 5, varianceFlatThreshold: 0.02 });
        for (let i = 0; i < 5; i++) tracker.addReading({ x: 0, y: 9.81, z: 0 });
        const stats = tracker.getStats();
        expect(stats.ready).toBe(true);
        expect(stats.variance).toBe(0);
        expect(stats.isSuspiciouslyFlat).toBe(true);
    });

    it('does not flag normal hand-tremor-level readings as flat', () => {
        const tracker = createMotionStabilityTracker({ bufferSize: 5, varianceFlatThreshold: 0.02 });
        const jitter = [9.5, 10.1, 9.6, 10.0, 9.7];
        for (const y of jitter) tracker.addReading({ x: 0, y, z: 0 });
        const stats = tracker.getStats();
        expect(stats.ready).toBe(true);
        expect(stats.isSuspiciouslyFlat).toBe(false);
    });

    it('reset() clears the buffer back to not-ready', () => {
        const tracker = createMotionStabilityTracker({ bufferSize: 3 });
        for (let i = 0; i < 3; i++) tracker.addReading({ x: 1, y: 1, z: 1 });
        expect(tracker.getStats().ready).toBe(true);
        tracker.reset();
        expect(tracker.getStats().ready).toBe(false);
    });

    it('treats a missing/malformed reading as all-zero rather than throwing', () => {
        const tracker = createMotionStabilityTracker({ bufferSize: 2 });
        expect(() => tracker.addReading(undefined)).not.toThrow();
        expect(() => tracker.addReading({})).not.toThrow();
        expect(tracker.getStats().ready).toBe(true);
    });
});
