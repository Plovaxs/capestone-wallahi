import { describe, it, expect } from 'vitest';
import { calculateBoxShiftRatio, createBoxMotionTracker } from './boxMotionHeuristic';

describe('calculateBoxShiftRatio', () => {
    it('returns 0 when the box hasn\'t moved at all', () => {
        const box = { x: 100, y: 100, width: 200, height: 200 };
        expect(calculateBoxShiftRatio(box, box)).toBe(0);
    });

    it('returns a larger ratio for a larger shift', () => {
        const prev = { x: 100, y: 100, width: 200, height: 200 };
        const small = { x: 101, y: 100, width: 200, height: 200 };
        const large = { x: 150, y: 100, width: 200, height: 200 };
        expect(calculateBoxShiftRatio(prev, small)).toBeLessThan(calculateBoxShiftRatio(prev, large));
    });

    it('normalizes by box size -- the same raw pixel shift is a smaller ratio for a bigger (closer) face', () => {
        const smallFacePrev = { x: 100, y: 100, width: 100, height: 100 };
        const smallFaceNext = { x: 110, y: 100, width: 100, height: 100 };
        const bigFacePrev = { x: 100, y: 100, width: 400, height: 400 };
        const bigFaceNext = { x: 110, y: 100, width: 400, height: 400 };
        expect(calculateBoxShiftRatio(bigFacePrev, bigFaceNext)).toBeLessThan(calculateBoxShiftRatio(smallFacePrev, smallFaceNext));
    });

    it('returns null when either box is missing', () => {
        const box = { x: 0, y: 0, width: 100, height: 100 };
        expect(calculateBoxShiftRatio(null, box)).toBeNull();
        expect(calculateBoxShiftRatio(box, null)).toBeNull();
    });
});

describe('createBoxMotionTracker', () => {
    it('is not ready until the window fills up', () => {
        const tracker = createBoxMotionTracker({ windowSize: 3 });
        tracker.addSample(0.01);
        expect(tracker.getStats().ready).toBe(false);
        tracker.addSample(0.01);
        expect(tracker.getStats().ready).toBe(false);
        tracker.addSample(0.01);
        expect(tracker.getStats().ready).toBe(true);
    });

    it('flags no natural movement when every recent sample is near-zero (a rigidly mounted image)', () => {
        const tracker = createBoxMotionTracker({ windowSize: 3 });
        [0, 0.0001, 0.0002].forEach((s) => tracker.addSample(s));
        const stats = tracker.getStats();
        expect(stats.hasNaturalMovement).toBe(false);
        expect(stats.isErratic).toBe(false);
    });

    it('confirms natural movement when at least one recent sample shows real, non-erratic motion', () => {
        const tracker = createBoxMotionTracker({ windowSize: 3 });
        [0, 0.02, 0.001].forEach((s) => tracker.addSample(s));
        const stats = tracker.getStats();
        expect(stats.hasNaturalMovement).toBe(true);
        expect(stats.isErratic).toBe(false);
    });

    it('flags erratic movement when a recent sample is wildly large (tracking noise/a different face)', () => {
        const tracker = createBoxMotionTracker({ windowSize: 3 });
        [0.01, 0.02, 0.9].forEach((s) => tracker.addSample(s));
        expect(tracker.getStats().isErratic).toBe(true);
    });

    it('reset() clears the window back to not-ready', () => {
        const tracker = createBoxMotionTracker({ windowSize: 2 });
        tracker.addSample(0.01);
        tracker.addSample(0.01);
        expect(tracker.getStats().ready).toBe(true);
        tracker.reset();
        expect(tracker.getStats().ready).toBe(false);
    });

    it('ignores null/non-finite samples instead of polluting the window', () => {
        const tracker = createBoxMotionTracker({ windowSize: 2 });
        tracker.addSample(null);
        tracker.addSample(NaN);
        tracker.addSample(0.01);
        tracker.addSample(0.01);
        expect(tracker.getStats().ready).toBe(true);
    });
});
