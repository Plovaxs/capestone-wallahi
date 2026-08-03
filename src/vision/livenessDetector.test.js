import { describe, it, expect, vi } from 'vitest';
import { calculateEAR, calculateHeadTurnRatio, LivenessDetector, RandomLivenessChallenge, CHALLENGE_TYPES } from './livenessDetector';

// A synthetic "open eye" shape: roughly rectangular, taller than a closed slit.
const openEye = [
    { x: 0, y: 5 },
    { x: 2, y: 2 },
    { x: 4, y: 2 },
    { x: 6, y: 5 },
    { x: 4, y: 8 },
    { x: 2, y: 8 },
];

// Same horizontal span, eyelids collapsed together (a blink).
const closedEye = [
    { x: 0, y: 5 },
    { x: 2, y: 5 },
    { x: 4, y: 5 },
    { x: 6, y: 5 },
    { x: 4, y: 5 },
    { x: 2, y: 5 },
];

const makeLandmarks = (eye, headTurnRatio = 0) => ({
    getLeftEye: () => eye,
    getRightEye: () => eye,
    getNose: () => [{ x: 50 + headTurnRatio * 100, y: 50 }],
    getJawOutline: () => [{ x: 0, y: 100 }, { x: 100, y: 100 }],
});

describe('calculateEAR', () => {
    it('returns a higher ratio for an open eye than a closed one', () => {
        expect(calculateEAR(openEye)).toBeGreaterThan(calculateEAR(closedEye));
    });

    it('returns 0 for a degenerate (zero-width) eye shape', () => {
        const degenerate = [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }];
        expect(calculateEAR(degenerate)).toBe(0);
    });
});

describe('calculateHeadTurnRatio', () => {
    it('returns ~0 when facing forward (nose centered between jaw endpoints)', () => {
        const landmarks = makeLandmarks(openEye, 0);
        expect(calculateHeadTurnRatio(landmarks)).toBeCloseTo(0, 1);
    });

    it('returns a non-zero ratio when the nose is offset from center', () => {
        const landmarks = makeLandmarks(openEye, 0.3);
        expect(Math.abs(calculateHeadTurnRatio(landmarks))).toBeGreaterThan(0.1);
    });

    it('returns 0 when landmarks are missing nose/jaw accessors', () => {
        expect(calculateHeadTurnRatio({})).toBe(0);
    });
});

describe('LivenessDetector (legacy blink-only)', () => {
    it('confirms a blink after an open -> closed -> open sequence', () => {
        const detector = new LivenessDetector();
        expect(detector.registerFrame(makeLandmarks(openEye))).toBe(false);
        expect(detector.registerFrame(makeLandmarks(closedEye))).toBe(false);
        expect(detector.registerFrame(makeLandmarks(openEye))).toBe(true);
    });

    it('gracefully returns false when landmarks are missing getLeftEye', () => {
        const detector = new LivenessDetector();
        expect(detector.registerFrame({})).toBe(false);
        expect(detector.registerFrame(null)).toBe(false);
    });
});

describe('RandomLivenessChallenge', () => {
    it('confirms a blink challenge via an open -> closed -> open sequence', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK });
        expect(challenge.registerFrame(makeLandmarks(openEye))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(closedEye))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(openEye))).toBe(true);
    });

    it('confirms a head-turn challenge via a large enough offset from baseline', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.HEAD_TURN });
        expect(challenge.registerFrame(makeLandmarks(openEye, 0))).toBe(false); // establishes baseline
        expect(challenge.registerFrame(makeLandmarks(openEye, 0.3))).toBe(true);
    });

    it('does not confirm a head-turn challenge for a negligible movement', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.HEAD_TURN });
        challenge.registerFrame(makeLandmarks(openEye, 0));
        expect(challenge.registerFrame(makeLandmarks(openEye, 0.01))).toBe(false);
    });

    it('expires after the time box elapses without confirmation', () => {
        vi.useFakeTimers();
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, timeoutMs: 1000 });
        expect(challenge.isExpired()).toBe(false);

        vi.advanceTimersByTime(1001);
        expect(challenge.isExpired()).toBe(true);
        expect(challenge.registerFrame(makeLandmarks(openEye))).toBe(false);
        vi.useRealTimers();
    });

    it('reset() starts a fresh challenge and clears expiry/confirmation', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK });
        challenge.registerFrame(makeLandmarks(openEye));
        challenge.registerFrame(makeLandmarks(closedEye));
        challenge.registerFrame(makeLandmarks(openEye));
        expect(challenge.confirmed).toBe(true);

        challenge.reset(CHALLENGE_TYPES.BLINK);
        expect(challenge.confirmed).toBe(false);
    });

    it('picks a random challenge type when none is forced', () => {
        const seen = new Set();
        for (let i = 0; i < 20; i++) {
            seen.add(new RandomLivenessChallenge().challengeType);
        }
        expect([...seen].every((t) => t === CHALLENGE_TYPES.BLINK || t === CHALLENGE_TYPES.HEAD_TURN)).toBe(true);
    });
});
