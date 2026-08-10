import { describe, it, expect, vi } from 'vitest';
import {
    calculateEAR, calculateHeadTurnRatio, calculatePitchRatio,
    calculateMouthWidthRatio, calculateMouthOpenRatio,
    LivenessDetector, RandomLivenessChallenge, CHALLENGE_TYPES,
} from './livenessDetector';

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

// A "soft" partial blink (EAR ≈ 0.25) — not fully collapsed like closedEye,
// but well within the real-world range some users' blinks land in. This is
// exactly the shape of the regression this session found: it satisfied
// LoginPage.jsx's own 0.26 threshold but not livenessDetector's old,
// stricter 0.23 one, so the same person could log in but never pass the
// Attendance liveness challenge.
const softBlinkEye = [
    { x: 0, y: 5 },
    { x: 2, y: 4.25 },
    { x: 4, y: 4.25 },
    { x: 6, y: 5 },
    { x: 4, y: 5.75 },
    { x: 2, y: 5.75 },
];

// face-api's 20-point mouth (indices 0-11 outer, 12-19 inner); only the
// points calculateMouthWidthRatio/calculateMouthOpenRatio actually read
// (0, 6, 12, 14, 16, 18) are meaningfully positioned -- the rest are
// filler so getMouth() always returns a full 20-point array.
const buildMouth = (width = 20, openHeight = 2) => {
    const cx = 50;
    const cy = 80;
    const points = new Array(20).fill(null).map(() => ({ x: cx, y: cy }));
    points[0] = { x: cx - width / 2, y: cy }; // outer left corner
    points[6] = { x: cx + width / 2, y: cy }; // outer right corner
    points[12] = { x: cx - width / 2 + 2, y: cy }; // inner left corner
    points[16] = { x: cx + width / 2 - 2, y: cy }; // inner right corner
    points[14] = { x: cx, y: cy - openHeight / 2 }; // inner top center
    points[18] = { x: cx, y: cy + openHeight / 2 }; // inner bottom center
    return points;
};
const neutralMouth = buildMouth(20, 2);
const smilingMouth = buildMouth(32, 2); // wider, same openness
const openMouth = buildMouth(20, 16); // same width, much taller gap

const makeLandmarks = (eye, headTurnRatio = 0, noseY = 50, mouth = neutralMouth) => ({
    getLeftEye: () => eye,
    getRightEye: () => eye,
    getNose: () => [{ x: 50 + headTurnRatio * 100, y: noseY }],
    getJawOutline: () => [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 100, y: 100 }],
    getLeftEyeBrow: () => [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 20 }],
    getRightEyeBrow: () => [{ x: 60, y: 20 }, { x: 70, y: 20 }, { x: 80, y: 20 }],
    getMouth: () => mouth,
});

describe('calculateEAR', () => {
    it('returns a higher ratio for an open eye than a closed one', () => {
        expect(calculateEAR(openEye)).toBeGreaterThan(calculateEAR(closedEye));
    });

    it('returns 0 for a degenerate (zero-width) eye shape', () => {
        const degenerate = [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }];
        expect(calculateEAR(degenerate)).toBe(0);
    });

    it('a soft/partial blink lands around 0.25 EAR', () => {
        expect(calculateEAR(softBlinkEye)).toBeCloseTo(0.25, 2);
    });
});

describe('calculateHeadTurnRatio / calculatePitchRatio (still used by the enrollment wizard, no longer part of the challenge)', () => {
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
        expect(calculatePitchRatio({})).toBe(0);
    });
});

describe('calculateMouthWidthRatio', () => {
    it('is larger for a smiling (wider) mouth than a neutral one, relative to face width', () => {
        const neutral = calculateMouthWidthRatio(makeLandmarks(openEye, 0, 50, neutralMouth));
        const smiling = calculateMouthWidthRatio(makeLandmarks(openEye, 0, 50, smilingMouth));
        expect(smiling).toBeGreaterThan(neutral);
    });

    it('returns 0 when landmarks are missing mouth/jaw accessors', () => {
        expect(calculateMouthWidthRatio({})).toBe(0);
    });
});

describe('calculateMouthOpenRatio', () => {
    it('is larger for an open mouth than a closed/neutral one', () => {
        const neutral = calculateMouthOpenRatio(makeLandmarks(openEye, 0, 50, neutralMouth));
        const open = calculateMouthOpenRatio(makeLandmarks(openEye, 0, 50, openMouth));
        expect(open).toBeGreaterThan(neutral);
    });

    it('returns 0 when landmarks are missing the mouth accessor', () => {
        expect(calculateMouthOpenRatio({})).toBe(0);
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

describe('RandomLivenessChallenge (single step, steps: 1 -- isolates the per-step logic)', () => {
    it('confirms a blink challenge as soon as a single tick catches the closed->open transition', () => {
        // 2026-08-11b: a single-frame crossing is now enough (see
        // livenessDetector.js's rationale) -- the app's detection tick is
        // slower than a real blink, so requiring 2 consecutive ticks inside
        // one blink routinely missed genuine users.
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        expect(challenge.registerFrame(makeLandmarks(openEye))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(openEye))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(closedEye))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(openEye))).toBe(true);
    });

    it('never confirms a blink for a face that never actually transitions (a static photo)', () => {
        // The anti-spoof property now rests on the TRANSITION, not frame
        // count: a photo's eyes are permanently open (or permanently
        // closed) and never cross both thresholds, however many frames are sampled.
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        for (let i = 0; i < 10; i++) {
            expect(challenge.registerFrame(makeLandmarks(openEye))).toBe(false);
        }
    });

    it('confirms a blink challenge from a soft/partial blink, matching LoginPage.jsx\'s leniency', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        challenge.registerFrame(makeLandmarks(openEye));
        challenge.registerFrame(makeLandmarks(openEye));
        challenge.registerFrame(makeLandmarks(softBlinkEye));
        expect(challenge.registerFrame(makeLandmarks(openEye))).toBe(true);
    });

    it('confirms a SMILE challenge as soon as the mouth widens past the baseline threshold', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.SMILE, steps: 1 });
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, neutralMouth))).toBe(false); // establishes baseline
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, neutralMouth))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, neutralMouth))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, smilingMouth))).toBe(true);
    });

    it('does NOT confirm SMILE from a negligible mouth-width change', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.SMILE, steps: 1 });
        challenge.registerFrame(makeLandmarks(openEye, 0, 50, neutralMouth));
        const barelyWider = buildMouth(20.5, 2);
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, barelyWider))).toBe(false);
    });

    it('confirms a MOUTH_OPEN challenge via a large, SUSTAINED jaw drop', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.MOUTH_OPEN, steps: 1 });
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, neutralMouth))).toBe(false); // baseline
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, openMouth))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, openMouth))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, openMouth))).toBe(true);
    });

    it('does not confirm SMILE/MOUTH_OPEN unless the matching frame lands once enough frames have been observed', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.SMILE, steps: 1 });
        challenge.registerFrame(makeLandmarks(openEye, 0, 50, neutralMouth)); // baseline (frame 1)
        challenge.registerFrame(makeLandmarks(openEye, 0, 50, smilingMouth)); // matches, but not enough frames yet (frame 2)
        challenge.registerFrame(makeLandmarks(openEye, 0, 50, neutralMouth)); // drops back (frame 3)
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, neutralMouth))).toBe(false); // frame 4 (enough frames now), but not smiling right now
    });

    it('expires after the time box elapses without confirmation', () => {
        vi.useFakeTimers();
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, timeoutMs: 1000, steps: 1 });
        expect(challenge.isExpired()).toBe(false);

        vi.advanceTimersByTime(1001);
        expect(challenge.isExpired()).toBe(true);
        expect(challenge.registerFrame(makeLandmarks(openEye))).toBe(false);
        vi.useRealTimers();
    });

    it('reset() starts a fresh challenge and clears expiry/confirmation', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        challenge.registerFrame(makeLandmarks(openEye));
        challenge.registerFrame(makeLandmarks(closedEye));
        challenge.registerFrame(makeLandmarks(closedEye));
        challenge.registerFrame(makeLandmarks(openEye));
        challenge.registerFrame(makeLandmarks(openEye));
        expect(challenge.confirmed).toBe(true);

        challenge.reset(CHALLENGE_TYPES.BLINK);
        expect(challenge.confirmed).toBe(false);
    });

    it('picks a random challenge type from all 3 when none is forced', () => {
        const seen = new Set();
        for (let i = 0; i < 40; i++) {
            seen.add(new RandomLivenessChallenge().challengeType);
        }
        const validTypes = Object.values(CHALLENGE_TYPES);
        expect([...seen].every((t) => validTypes.includes(t))).toBe(true);
    });
});

describe('RandomLivenessChallenge (default 2-step sequence)', () => {
    it('requires BOTH steps -- confirmed stays false after only the first step is satisfied', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, secondChallengeType: CHALLENGE_TYPES.SMILE });
        challenge.registerFrame(makeLandmarks(openEye));
        challenge.registerFrame(makeLandmarks(closedEye));
        challenge.registerFrame(makeLandmarks(closedEye));
        challenge.registerFrame(makeLandmarks(openEye));
        const afterStepOne = challenge.registerFrame(makeLandmarks(openEye));
        expect(afterStepOne).toBe(false); // step 1 (blink) done, but step 2 (smile) hasn't started
        expect(challenge.challengeType).toBe(CHALLENGE_TYPES.SMILE); // now prompting for step 2
    });

    it('confirms only once both sequential steps are satisfied, in order', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, secondChallengeType: CHALLENGE_TYPES.SMILE });
        // Step 1: blink
        challenge.registerFrame(makeLandmarks(openEye));
        challenge.registerFrame(makeLandmarks(closedEye));
        challenge.registerFrame(makeLandmarks(closedEye));
        challenge.registerFrame(makeLandmarks(openEye));
        challenge.registerFrame(makeLandmarks(openEye));
        expect(challenge.confirmed).toBe(false);

        // Step 2: smile -- baseline re-established fresh for this step
        challenge.registerFrame(makeLandmarks(openEye, 0, 50, neutralMouth));
        challenge.registerFrame(makeLandmarks(openEye, 0, 50, smilingMouth));
        challenge.registerFrame(makeLandmarks(openEye, 0, 50, smilingMouth));
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, smilingMouth))).toBe(true);
        expect(challenge.confirmed).toBe(true);
    });

    it('a video/photo prepared only for step 1\'s challenge type cannot also satisfy an unrelated step 2 prompt', () => {
        // Simulates an attacker who only prepared to blink -- repeating the
        // same blink motion does not satisfy a MOUTH_OPEN second step.
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, secondChallengeType: CHALLENGE_TYPES.MOUTH_OPEN });
        challenge.registerFrame(makeLandmarks(openEye));
        challenge.registerFrame(makeLandmarks(closedEye));
        challenge.registerFrame(makeLandmarks(closedEye));
        challenge.registerFrame(makeLandmarks(openEye));
        challenge.registerFrame(makeLandmarks(openEye));
        expect(challenge.challengeType).toBe(CHALLENGE_TYPES.MOUTH_OPEN);

        // Keeps blinking instead of opening its mouth -- never confirms.
        challenge.registerFrame(makeLandmarks(closedEye, 0, 50, neutralMouth));
        challenge.registerFrame(makeLandmarks(closedEye, 0, 50, neutralMouth));
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50, neutralMouth))).toBe(false);
    });

    it('getStepProgress reflects live progress toward the CURRENT step (0-1)', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.SMILE, steps: 1 });
        expect(challenge.getStepProgress()).toBe(0);
        challenge.registerFrame(makeLandmarks(openEye, 0, 50, neutralMouth));
        challenge.registerFrame(makeLandmarks(openEye, 0, 50, smilingMouth));
        expect(challenge.getStepProgress()).toBeGreaterThan(0);
        expect(challenge.getStepProgress()).toBeLessThanOrEqual(1);
    });
});
