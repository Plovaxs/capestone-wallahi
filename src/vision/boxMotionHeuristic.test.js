import { describe, it, expect } from 'vitest';
import { calculateBoxShiftRatio, createBoxMotionTracker, toFaceRelativeBox } from './boxMotionHeuristic';

describe('calculateBoxShiftRatio', () => {
    it('returns null when either box is missing', () => {
        expect(calculateBoxShiftRatio(null, { x: 0, y: 0, width: 10, height: 10 })).toBeNull();
        expect(calculateBoxShiftRatio({ x: 0, y: 0, width: 10, height: 10 }, null)).toBeNull();
    });

    it('returns 0 for two identical boxes', () => {
        const box = { x: 10, y: 10, width: 20, height: 20 };
        expect(calculateBoxShiftRatio(box, box)).toBe(0);
    });

    it('returns a larger ratio for a bigger center-to-center displacement', () => {
        const box = { x: 10, y: 10, width: 20, height: 20 };
        const smallShift = calculateBoxShiftRatio(box, { x: 11, y: 10, width: 20, height: 20 });
        const bigShift = calculateBoxShiftRatio(box, { x: 20, y: 10, width: 20, height: 20 });
        expect(bigShift).toBeGreaterThan(smallShift);
    });

    it('normalizes by box size -- the same raw pixel shift is a smaller ratio for a bigger (closer) face', () => {
        const smallFacePrev = { x: 100, y: 100, width: 100, height: 100 };
        const smallFaceNext = { x: 110, y: 100, width: 100, height: 100 };
        const bigFacePrev = { x: 100, y: 100, width: 400, height: 400 };
        const bigFaceNext = { x: 110, y: 100, width: 400, height: 400 };
        expect(calculateBoxShiftRatio(bigFacePrev, bigFaceNext)).toBeLessThan(calculateBoxShiftRatio(smallFacePrev, smallFaceNext));
    });
});

describe('createBoxMotionTracker', () => {
    it('is not ready until the window fills up', () => {
        const tracker = createBoxMotionTracker({ windowSize: 3 });
        expect(tracker.getStats().ready).toBe(false);
        tracker.addSample(0.01);
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

    it('reports hasNaturalMovement once a real (non-frozen) shift appears in the window', () => {
        const tracker = createBoxMotionTracker({ windowSize: 3 });
        tracker.addSample(0);
        tracker.addSample(0);
        tracker.addSample(0.05);
        expect(tracker.getStats().hasNaturalMovement).toBe(true);
    });

    it('reports isErratic when a shift is wildly larger than natural jitter', () => {
        const tracker = createBoxMotionTracker({ windowSize: 3 });
        tracker.addSample(0.01);
        tracker.addSample(0.01);
        tracker.addSample(0.9);
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

// 🟩 SECURITY: reported live -- an earlier "mouth/nose movement proves
// liveness" feature tracked the mouth/nose boxes' RAW frame position, the
// exact same measure the face-box motion check already uses -- and that
// check's own documented limitation is that a rigidly-held photo/phone
// wobbles too, moving every point on it (face box, mouth, nose) together.
// toFaceRelativeBox re-expresses a feature's position relative to the face
// box instead, so a whole-object wobble (numerator and denominator shift
// together) cancels out while genuine internal movement (the mouth moving
// relative to the rest of the face) does not.
describe('toFaceRelativeBox', () => {
    it('returns null when either box is missing or the face box has no size', () => {
        expect(toFaceRelativeBox(null, { x: 0, y: 0, width: 10, height: 10 })).toBeNull();
        expect(toFaceRelativeBox({ x: 0, y: 0, width: 5, height: 5 }, null)).toBeNull();
        expect(toFaceRelativeBox({ x: 0, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
    });

    it('stays essentially unchanged when a rigid whole-photo wobble shifts BOTH the face box and the feature box together', () => {
        const faceBoxA = { x: 100, y: 100, width: 200, height: 200 };
        const mouthBoxA = { x: 150, y: 250, width: 60, height: 30 };
        // Simulates a hand-held photo wobbling: the whole frame content
        // shifts by the same (dx, dy) -- face box and mouth box move
        // together, exactly like the documented face-box-motion limitation.
        const dx = 8;
        const dy = -5;
        const faceBoxB = { x: faceBoxA.x + dx, y: faceBoxA.y + dy, width: 200, height: 200 };
        const mouthBoxB = { x: mouthBoxA.x + dx, y: mouthBoxA.y + dy, width: 60, height: 30 };

        const relativeA = toFaceRelativeBox(mouthBoxA, faceBoxA);
        const relativeB = toFaceRelativeBox(mouthBoxB, faceBoxB);
        const shiftRatio = calculateBoxShiftRatio(relativeA, relativeB);

        expect(shiftRatio).toBeCloseTo(0, 5);
    });

    it('shows real motion when the feature moves relative to the face box (genuine mouth movement), even with the face box itself perfectly still', () => {
        const faceBox = { x: 100, y: 100, width: 200, height: 200 };
        const mouthBoxClosed = { x: 150, y: 250, width: 60, height: 20 };
        // Mouth opens: taller box, same face box -- a REAL relative change.
        const mouthBoxOpen = { x: 150, y: 245, width: 60, height: 35 };

        const relativeClosed = toFaceRelativeBox(mouthBoxClosed, faceBox);
        const relativeOpen = toFaceRelativeBox(mouthBoxOpen, faceBox);
        const shiftRatio = calculateBoxShiftRatio(relativeClosed, relativeOpen);

        expect(shiftRatio).toBeGreaterThan(0.01);
    });

    it('normalizes by the face box\'s own size, so the same real-world motion reads the same regardless of how close the face is to the camera', () => {
        const nearFaceBox = { x: 0, y: 0, width: 400, height: 400 };
        const farFaceBox = { x: 0, y: 0, width: 100, height: 100 };
        // Same PROPORTIONAL mouth position/shift in both, just scaled.
        const nearShift = calculateBoxShiftRatio(
            toFaceRelativeBox({ x: 150, y: 300, width: 80, height: 20 }, nearFaceBox),
            toFaceRelativeBox({ x: 150, y: 295, width: 80, height: 30 }, nearFaceBox),
        );
        const farShift = calculateBoxShiftRatio(
            toFaceRelativeBox({ x: 37.5, y: 75, width: 20, height: 5 }, farFaceBox),
            toFaceRelativeBox({ x: 37.5, y: 73.75, width: 20, height: 7.5 }, farFaceBox),
        );
        expect(nearShift).toBeCloseTo(farShift, 5);
    });
});
