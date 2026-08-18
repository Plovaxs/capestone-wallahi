import { describe, it, expect, vi } from 'vitest';
import {
    calculateEAR, calculateHeadTurnRatio, calculatePitchRatio,
    calculateMouthWidthRatio, calculateMouthOpenRatio,
    calculateEyeBoxes, calculateMouthBox, calculateNoseBox, isEyeClosed,
    RandomLivenessChallenge, CHALLENGE_TYPES,
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

// Same open-eye vertical shape as openEye, but a much narrower horizontal
// span (eye corners closer together) -- simulates the eye region itself
// scaling/shifting between samples (camera distance change, a different
// crop/zoom) rather than a real blink, which never moves the eye corners.
const narrowOpenEye = [
    { x: 2, y: 2 },
    { x: 2.7, y: 0.5 },
    { x: 3.3, y: 0.5 },
    { x: 4, y: 2 },
    { x: 3.3, y: 3.5 },
    { x: 2.7, y: 3.5 },
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

// Same shape as makeLandmarks but with independently-controllable left/right
// eyes -- needed to simulate a tilt that foreshortens each eye's projection
// differently (e.g. tilting a phone/photo down doesn't shift both eyes'
// apparent vertical extent by the same amount, since they sit at different
// positions relative to the tilt axis), unlike a real blink which always
// closes both eyes together.
const makeAsymmetricLandmarks = (leftEye, rightEye, noseY = 50) => ({
    getLeftEye: () => leftEye,
    getRightEye: () => rightEye,
    getNose: () => [{ x: 50, y: noseY }],
    getJawOutline: () => [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 100, y: 100 }],
    getLeftEyeBrow: () => [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 20 }],
    getRightEyeBrow: () => [{ x: 60, y: 20 }, { x: 70, y: 20 }, { x: 80, y: 20 }],
    getMouth: () => neutralMouth,
});

// A moderately-open eye (EAR = 0.5) -- well clear of EAR_OPEN_THRESHOLD
// (0.28) on its own, but low enough that AVERAGING it with a fully-closed
// eye (EAR = 0) lands the average (0.25) below EAR_CLOSED_THRESHOLD (0.26)
// -- exactly the asymmetric-tilt shape this regression targets.
const halfOpenEye = [
    { x: 0, y: 5 },
    { x: 2, y: 3.5 },
    { x: 4, y: 3.5 },
    { x: 6, y: 5 },
    { x: 4, y: 6.5 },
    { x: 2, y: 6.5 },
];

// Same shape as makeLandmarks but with a fully custom eyebrow-y/chin-y --
// lets a test independently control the RAW vertical face span (chinY -
// browY) versus where the nose sits WITHIN that span (pitch ratio), which
// makeLandmarks can't do (it hardcodes browY=20/chinY=100). Needed to
// simulate a photo tilted steeply enough to foreshorten (squeeze) the whole
// face vertically while the nose stays at the same PROPORTIONAL position --
// i.e. pitch ratio unchanged, only the physical span shrinks.
const makeLandmarksWithSpan = (eye, browY, chinY, noseY) => ({
    getLeftEye: () => eye,
    getRightEye: () => eye,
    getNose: () => [{ x: 50, y: noseY }],
    getJawOutline: () => [{ x: 0, y: chinY }, { x: 50, y: chinY }, { x: 100, y: chinY }],
    getLeftEyeBrow: () => [{ x: 20, y: browY }, { x: 30, y: browY }, { x: 40, y: browY }],
    getRightEyeBrow: () => [{ x: 60, y: browY }, { x: 70, y: browY }, { x: 80, y: browY }],
    getMouth: () => neutralMouth,
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

describe('isEyeClosed', () => {
    it('reads an open eye as not closed', () => {
        expect(isEyeClosed(openEye)).toBe(false);
    });

    it('reads a closed eye as closed', () => {
        expect(isEyeClosed(closedEye)).toBe(true);
    });

    it('agrees with the same EAR_CLOSED_THRESHOLD RandomLivenessChallenge uses', () => {
        // Not a hardcoded duplicate of the threshold -- this just asserts
        // isEyeClosed and the challenge's own blink-step logic reach the
        // same verdict on the same landmarks, so the eye-box visual
        // feedback can never show "open" while the challenge itself is
        // silently counting it as "closed" (or vice versa).
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        challenge.registerFrame(makeLandmarks(openEye));
        expect(isEyeClosed(openEye)).toBe(challenge.hasBeenClosed);
        challenge.registerFrame(makeLandmarks(closedEye));
        expect(isEyeClosed(closedEye)).toBe(challenge.hasBeenClosed);
    });
});

describe('calculateEyeBoxes', () => {
    it('returns a left and right box that both contain their own eye points', () => {
        const landmarks = makeLandmarks(openEye);
        const boxes = calculateEyeBoxes(landmarks);
        expect(boxes).not.toBeNull();
        for (const box of [boxes.left, boxes.right]) {
            for (const p of openEye) {
                expect(p.x).toBeGreaterThanOrEqual(box.x);
                expect(p.x).toBeLessThanOrEqual(box.x + box.width);
                expect(p.y).toBeGreaterThanOrEqual(box.y);
                expect(p.y).toBeLessThanOrEqual(box.y + box.height);
            }
        }
    });

    it('returns null when landmarks are missing eye accessors', () => {
        expect(calculateEyeBoxes({})).toBeNull();
        expect(calculateEyeBoxes(null)).toBeNull();
    });
});

// 🟩 NEW: mouth/nose motion boxes -- a photo/screen literally cannot move
// its lips or nostrils, so real frame-to-frame movement in EITHER region is
// strong, independent evidence of a live face, drawn on screen the same way
// the eye boxes already are. See their use as an AttendanceView.jsx/
// LoginPage.jsx passive-suspicion override.
describe('calculateMouthBox / calculateNoseBox', () => {
    it('calculateMouthBox returns a box that contains every mouth landmark point', () => {
        const box = calculateMouthBox(makeLandmarks(openEye, 0, 50, neutralMouth));
        expect(box).not.toBeNull();
        for (const p of neutralMouth) {
            expect(p.x).toBeGreaterThanOrEqual(box.x);
            expect(p.x).toBeLessThanOrEqual(box.x + box.width);
            expect(p.y).toBeGreaterThanOrEqual(box.y);
            expect(p.y).toBeLessThanOrEqual(box.y + box.height);
        }
    });

    it('calculateMouthBox returns null when landmarks are missing the mouth accessor', () => {
        expect(calculateMouthBox({})).toBeNull();
        expect(calculateMouthBox(null)).toBeNull();
    });

    it('calculateNoseBox returns a box that contains every nose landmark point', () => {
        const landmarks = makeLandmarks(openEye, 0, 50);
        const box = calculateNoseBox(landmarks);
        expect(box).not.toBeNull();
        for (const p of landmarks.getNose()) {
            expect(p.x).toBeGreaterThanOrEqual(box.x);
            expect(p.x).toBeLessThanOrEqual(box.x + box.width);
            expect(p.y).toBeGreaterThanOrEqual(box.y);
            expect(p.y).toBeLessThanOrEqual(box.y + box.height);
        }
    });

    it('calculateNoseBox returns null when landmarks are missing the nose accessor', () => {
        expect(calculateNoseBox({})).toBeNull();
        expect(calculateNoseBox(null)).toBeNull();
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

    // 🟩 REGRESSION TEST: reported live -- tilting a printed/screen photo
    // forward toward the camera foreshortens the eyes, shrinking EAR
    // exactly like a real blink; tilting it back restores EAR above the
    // open threshold, faking the whole closed->open transition with the
    // photo never actually blinking. The tilt necessarily moves the whole
    // face's pitch reading along with it (unlike a real blink, a ~100-
    // 400ms eyelid motion with no head rotation) -- simulates that exact
    // attack shape via a large noseY shift between the "closed" and "open"
    // samples and confirms it's rejected.
    it('does NOT confirm a blink when the closed->open transition comes with a large pitch swing (tilted-photo spoof)', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50))).toBe(false);
        // Photo tilted forward: EAR reads closed AND pitch (noseY) shifts hard.
        expect(challenge.registerFrame(makeLandmarks(closedEye, 0, 30))).toBe(false);
        // Photo tilted back: EAR reads open again, but pitch swung right back too.
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50))).toBe(false);
        expect(challenge.confirmed).toBe(false);
    });

    // 🟩 REGRESSION TEST: reported live -- a STEEP tilt (photo "squinted"
    // hard) still got through the pitch-only check above. calculatePitchRatio
    // divides by the face's own vertical span, so a uniform vertical squeeze
    // (exactly what a steep forward tilt produces) barely moves it as long
    // as the nose stays at the same PROPORTIONAL position within the now-
    // shrunken span -- which is exactly this scenario: browY/chinY squeeze
    // from a span of 80 down to 40 (half), nose repositioned to keep the
    // same relative offset (pitch ratio identical, -0.125, in both frames).
    // Only the raw vertical-span check (calculateFaceVerticalSpan) can see
    // this shrink; asserts it's now rejected.
    it('does NOT confirm a blink from a steep foreshortening tilt even when pitch ratio itself stays unchanged', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        // Baseline: browY=20, chinY=100 (span 80), nose=50 -> pitch -0.125.
        expect(challenge.registerFrame(makeLandmarksWithSpan(openEye, 20, 100, 50))).toBe(false);
        expect(challenge.registerFrame(makeLandmarksWithSpan(openEye, 20, 100, 50))).toBe(false);
        // Steep tilt: span squeezed to 40 (half), nose repositioned to the
        // SAME proportional offset -- pitch ratio comes out identical.
        expect(challenge.registerFrame(makeLandmarksWithSpan(closedEye, 40, 80, 55))).toBe(false);
        // Tilted back toward baseline -- EAR reads open again.
        expect(challenge.registerFrame(makeLandmarksWithSpan(openEye, 20, 100, 50))).toBe(false);
        expect(challenge.confirmed).toBe(false);
    });

    // 🟩 REGRESSION TEST: reported live -- with the checks above only
    // comparing the OPEN reading against the immediately-preceding CLOSED
    // snapshot, a patient attacker doing several small tilt-and-hold cycles
    // could still eventually reach a closed+open pair that looked
    // consistent with EACH OTHER (small delta) while both were already far
    // from where the step genuinely started -- each individual "closed"
    // update just silently overwrote the comparison point, so nothing ever
    // anchored the check to the TRUE starting geometry. Now the CLOSED
    // reading itself is checked against a baseline captured once at the
    // very start of the step (not just the open reading against the
    // closed one), so hasBeenClosed never even gets set true from a
    // drifted state in the first place -- confirmed via the class's own
    // internal flag, not just the final outcome, to prove rejection now
    // happens at the EARLIER (closed) point, not only the later (open) one.
    it('rejects a closed reading whose geometry has already drifted from the step\'s own baseline -- catches it before the open side even matters', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        // Baseline: span 80, nose=50.
        challenge.registerFrame(makeLandmarksWithSpan(openEye, 20, 100, 50));
        challenge.registerFrame(makeLandmarksWithSpan(openEye, 20, 100, 50));
        expect(challenge.hasBeenClosed).toBe(false);

        // A closed reading with a halved span -- well outside tolerance of
        // the ORIGINAL baseline, even though it's the very first "closed"
        // reading this step has seen (nothing stale to compare against).
        challenge.registerFrame(makeLandmarksWithSpan(closedEye, 40, 80, 55));
        expect(challenge.hasBeenClosed).toBe(false); // rejected at the closed step itself

        // An open reading at that SAME drifted geometry (zero delta from
        // the rejected closed sample -- would look perfectly consistent
        // under a hypothetical closed-vs-immediate-open-only check) still
        // can't confirm, because hasBeenClosed was never actually set.
        expect(challenge.registerFrame(makeLandmarksWithSpan(openEye, 40, 80, 55))).toBe(false);
        expect(challenge.confirmed).toBe(false);
    });

    // 🟩 REGRESSION TEST: further hardening -- a third, independent check
    // (eye width, EAR's own horizontal denominator) catches a closed->open
    // transition where the eye region itself scaled/shifted between the two
    // samples (camera-distance change, a different crop) even when pitch
    // and face-span BOTH happen to read as stable (same browY/chinY/noseY
    // throughout here, isolating eye width as the only signal that fires).
    // A real blink never moves the eye corners at all.
    it('does NOT confirm a blink when eye width itself shifts between the closed and open samples, even with pitch/span stable', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 50))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(closedEye, 0, 50))).toBe(false);
        expect(challenge.registerFrame(makeLandmarks(narrowOpenEye, 0, 50))).toBe(false);
        expect(challenge.confirmed).toBe(false);
    });

    // 🟩 REGRESSION TEST: reported live -- tilting a photo DOWN foreshortens
    // each eye's projection differently (they sit at different positions
    // relative to the tilt axis), so only ONE eye's EAR actually dropped
    // while the other stayed clearly open. Averaging the two eyes let that
    // single-eye dip drag the AVERAGE below EAR_CLOSED_THRESHOLD even
    // though neither eye was independently below it on its own AND above
    // it -- misread as a real blink, which always closes BOTH eyes
    // together. Now requires each eye to independently clear both
    // thresholds.
    it('does NOT confirm a blink when only ONE eye\'s ratio actually drops (asymmetric tilt), even though the AVERAGE would cross the threshold', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        expect(challenge.registerFrame(makeAsymmetricLandmarks(openEye, openEye))).toBe(false);
        expect(challenge.registerFrame(makeAsymmetricLandmarks(openEye, openEye))).toBe(false);
        // Left eye reads fully closed (EAR 0), right eye stays moderately
        // open (EAR 0.5) -- average is 0.25, below EAR_CLOSED_THRESHOLD
        // (0.26), but the right eye alone never actually closed.
        expect(challenge.registerFrame(makeAsymmetricLandmarks(closedEye, halfOpenEye))).toBe(false);
        expect(challenge.registerFrame(makeAsymmetricLandmarks(openEye, openEye))).toBe(false);
        expect(challenge.confirmed).toBe(false);
    });

    it('still confirms a real blink through the pitch-stability check when pitch only jitters a little (natural incidental head motion)', () => {
        const challenge = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        challenge.registerFrame(makeLandmarks(openEye, 0, 50));
        challenge.registerFrame(makeLandmarks(openEye, 0, 50));
        challenge.registerFrame(makeLandmarks(closedEye, 0, 48)); // tiny incidental drift
        expect(challenge.registerFrame(makeLandmarks(openEye, 0, 45))).toBe(true); // still within tolerance
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

    it('a bare reset() (no arguments) reuses the type(s) forced at construction, not a random pick', () => {
        // Regression test: every real call site in the app calls .reset()
        // with no arguments (on expiry/passive-suspicion/face-mismatch),
        // so a constructor-forced type MUST survive a parameterless reset
        // -- this used to silently fall back to picking randomly again.
        for (let i = 0; i < 20; i++) {
            const challenge = new RandomLivenessChallenge({
                challengeType: CHALLENGE_TYPES.BLINK,
                secondChallengeType: CHALLENGE_TYPES.BLINK,
            });
            challenge.reset();
            expect(challenge.challengeType).toBe(CHALLENGE_TYPES.BLINK);
        }
    });

    it('a bare reset() still picks randomly again when no type was forced at construction', () => {
        const challenge = new RandomLivenessChallenge();
        const seen = new Set();
        for (let i = 0; i < 40; i++) {
            challenge.reset();
            seen.add(challenge.challengeType);
        }
        const validTypes = Object.values(CHALLENGE_TYPES);
        expect([...seen].every((t) => validTypes.includes(t))).toBe(true);
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
