const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Eye Aspect Ratio (EAR): a standard liveness-detection metric computed
 * from 6 landmark points around one eye. Open eyes give a roughly
 * constant ratio (~0.25-0.35); a blink collapses it toward 0 as the
 * vertical eyelid distance shrinks while the horizontal eye-corner
 * distance stays put. Doesn't require any model beyond the 68-point face
 * landmarks face-api.js already returns.
 */
export function calculateEAR(eyePoints) {
    const [p1, p2, p3, p4, p5, p6] = eyePoints;
    const vertical = distance(p2, p6) + distance(p3, p5);
    const horizontal = distance(p1, p4);
    if (horizontal === 0) return 0;
    return vertical / (2 * horizontal);
}

/**
 * Head-turn ratio: horizontal offset of the nose tip from the midpoint
 * between the two jaw-outline endpoints, normalized by face width. Near 0
 * when facing the camera; grows in magnitude (sign indicates direction)
 * as the head turns left/right. Also uses only the existing 68-point
 * landmarks — no extra model.
 */
export function calculateHeadTurnRatio(landmarks) {
    const nose = landmarks.getNose?.();
    const jaw = landmarks.getJawOutline?.();
    if (!nose?.length || !jaw?.length) return 0;

    const noseTip = nose[Math.floor(nose.length / 2)];
    const leftJaw = jaw[0];
    const rightJaw = jaw[jaw.length - 1];
    const faceWidth = rightJaw.x - leftJaw.x;
    if (faceWidth === 0) return 0;

    return (noseTip.x - (leftJaw.x + rightJaw.x) / 2) / faceWidth;
}

/**
 * Pitch ratio: a 2D approximation of up/down head tilt. Compares where the
 * nose tip sits between the eyebrow line and the chin — tilting the head
 * down shifts the nose tip proportionally toward the chin; tilting up
 * shifts it toward the brows. Same landmarks-only approach as the other
 * two signals, no 3D head-pose model needed.
 */
export function calculatePitchRatio(landmarks) {
    const nose = landmarks.getNose?.();
    const jaw = landmarks.getJawOutline?.();
    const leftBrow = landmarks.getLeftEyeBrow?.();
    const rightBrow = landmarks.getRightEyeBrow?.();
    if (!nose?.length || !jaw?.length || !leftBrow?.length || !rightBrow?.length) return 0;

    const noseTip = nose[nose.length - 1];
    const browY = (leftBrow[Math.floor(leftBrow.length / 2)].y + rightBrow[Math.floor(rightBrow.length / 2)].y) / 2;
    const chinY = jaw[Math.floor(jaw.length / 2)].y;
    const faceHeight = chinY - browY;
    if (faceHeight === 0) return 0;

    return (noseTip.y - (browY + chinY) / 2) / faceHeight;
}

const EAR_CLOSED_THRESHOLD = 0.26;
const EAR_OPEN_THRESHOLD = 0.28;
// 🟩 SECURITY HARDENING (2026-08-10): a real photo, physically wobbled by
// hand while being held up to the camera, was reported to satisfy the
// blink/head-turn challenge -- a single noisy frame crossing a threshold
// (one bad landmark read, one moment of hand tremor) was previously
// enough to confirm either challenge outright. What a genuine directed
// movement has that random jitter doesn't is SUSTAINED, CONSISTENT
// motion across multiple frames, in the SPECIFIC direction asked for
// (not just "any" direction) -- see the 4-directional redesign below.
const YAW_THRESHOLD = 0.09;
// Pitch ratio is normalized by face HEIGHT rather than width, and the
// synthetic-but-representative fixture in livenessDetector.test.js shows
// it swings roughly 1.3-1.5x further than the yaw ratio for a comparable
// head movement -- scaled up proportionally as a starting point, same as
// every other threshold in this file, tunable from real-user feedback.
const PITCH_THRESHOLD = 0.12;
const MIN_CONSECUTIVE_FRAMES = 2; // consecutive frames the triggering condition must hold, in the SAME direction
const MIN_TOTAL_FRAMES_BEFORE_CONFIRM = 4; // frames observed (this step) before confirmation is even possible
// 🟩 SECURITY HARDENING (2026-08-10): two independent, unpredictable steps
// instead of one -- a static photo or a short looped/prerecorded clip
// prepared in advance for "blink" won't also satisfy a follow-up "look
// down" prompt it wasn't built for. Bumped the time box up from the old
// single-step default to comfortably fit two sequential sustained-motion
// steps even at AttendanceView's slower (1.8s) detection interval.
const DEFAULT_CHALLENGE_TIMEOUT_MS = 25000;
const DEFAULT_STEP_COUNT = 2;

export const CHALLENGE_TYPES = {
    BLINK: 'blink',
    LOOK_LEFT: 'look_left',
    LOOK_RIGHT: 'look_right',
    LOOK_UP: 'look_up',
    LOOK_DOWN: 'look_down',
};

// Maps each challenge type to a PascalCase suffix callers use to build
// their own namespaced i18n keys, e.g. `t('login.statusAwaiting' + suffix)`
// -- avoids a duplicated switch/ternary in both LoginPage.jsx and
// AttendanceView.jsx (which used to just special-case HEAD_TURN vs
// everything-else, back when there were only 2 challenge types).
export const CHALLENGE_INSTRUCTION_SUFFIX = {
    [CHALLENGE_TYPES.BLINK]: 'Blink',
    [CHALLENGE_TYPES.LOOK_LEFT]: 'LookLeft',
    [CHALLENGE_TYPES.LOOK_RIGHT]: 'LookRight',
    [CHALLENGE_TYPES.LOOK_UP]: 'LookUp',
    [CHALLENGE_TYPES.LOOK_DOWN]: 'LookDown',
};

// Arrow glyph shown alongside the instruction for directional steps --
// live progress feedback (getStepProgress()) is the real signal a user
// follows moment to moment, same "numeric readout is the real feedback
// loop" pattern already established elsewhere in this app; the glyph is
// just a starting hint, deliberately screen-relative (an arrow pointing
// left on a mirrored selfie preview) rather than a word like "left"/
// "right" that real users found confusing during face-enrollment testing.
export const CHALLENGE_DIRECTION_GLYPH = {
    [CHALLENGE_TYPES.BLINK]: '👁️',
    [CHALLENGE_TYPES.LOOK_LEFT]: '⬅️',
    [CHALLENGE_TYPES.LOOK_RIGHT]: '➡️',
    [CHALLENGE_TYPES.LOOK_UP]: '⬆️',
    [CHALLENGE_TYPES.LOOK_DOWN]: '⬇️',
};

const ALL_CHALLENGE_TYPES = Object.values(CHALLENGE_TYPES);

// Which pose-ratio function and required sign of movement each directional
// challenge type checks -- BLINK is handled separately (EAR-based, not a
// directional ratio).
const DIRECTION_CHECKS = {
    [CHALLENGE_TYPES.LOOK_LEFT]: { getRatio: calculateHeadTurnRatio, sign: -1, threshold: YAW_THRESHOLD },
    [CHALLENGE_TYPES.LOOK_RIGHT]: { getRatio: calculateHeadTurnRatio, sign: 1, threshold: YAW_THRESHOLD },
    [CHALLENGE_TYPES.LOOK_UP]: { getRatio: calculatePitchRatio, sign: -1, threshold: PITCH_THRESHOLD },
    [CHALLENGE_TYPES.LOOK_DOWN]: { getRatio: calculatePitchRatio, sign: 1, threshold: PITCH_THRESHOLD },
};

const pickRandomChallengeType = (exclude = null) => {
    const pool = exclude ? ALL_CHALLENGE_TYPES.filter((t) => t !== exclude) : ALL_CHALLENGE_TYPES;
    return pool[Math.floor(Math.random() * pool.length)];
};

/**
 * Confirms the face in front of the camera is a live person, not a photo
 * or video replay, by requiring TWO sequential, unpredictable actions
 * within one time window: blink, or look in one of 4 specific directions
 * (left/right/up/down -- see DIRECTION_CHECKS). Each step requires
 * SUSTAINED motion (multiple consecutive frames, in the specific
 * direction asked for) rather than a single-frame threshold crossing, so
 * incidental hand tremor from holding up a photo -- which moves
 * erratically, not in one sustained direction on demand -- can no longer
 * satisfy it. Whatever an attacker prepared in advance (a photo, a short
 * loop of the enrolled person blinking) has to also happen to satisfy
 * a second, independently-randomized prompt it wasn't built for.
 */
export class RandomLivenessChallenge {
    constructor({ challengeType = null, secondChallengeType = null, timeoutMs = DEFAULT_CHALLENGE_TIMEOUT_MS, steps = DEFAULT_STEP_COUNT } = {}) {
        this.timeoutMs = timeoutMs;
        this.totalSteps = Math.max(1, steps);
        this._resetState(challengeType, secondChallengeType);
    }

    _resetState(forcedFirstType = null, forcedSecondType = null) {
        this.startedAt = Date.now();
        this.stepIndex = 0;
        this.confirmed = false;

        this._sequence = [forcedFirstType || pickRandomChallengeType()];
        for (let i = 1; i < this.totalSteps; i++) {
            this._sequence.push(forcedSecondType && i === 1 ? forcedSecondType : pickRandomChallengeType(this._sequence[i - 1]));
        }

        this._initStepState();
    }

    _initStepState() {
        this.hasBeenClosed = false;
        this.baselineRatio = null;
        this.framesObserved = 0;
        this._closedRun = 0;
        this._openRun = 0;
        this._directionRun = 0;
    }

    /** The challenge type for the CURRENT step -- what the UI should prompt for right now. */
    get challengeType() {
        return this._sequence[this.stepIndex];
    }

    isExpired() {
        return !this.confirmed && Date.now() - this.startedAt > this.timeoutMs;
    }

    /** Feed one frame's landmarks in; returns true once every step is satisfied. */
    registerFrame(landmarks) {
        if (this.confirmed) return true;
        if (!landmarks || typeof landmarks.getLeftEye !== 'function') return false;
        if (this.isExpired()) return false;

        const stepConfirmed = this._evaluateStep(landmarks);
        if (stepConfirmed) {
            if (this.stepIndex + 1 >= this.totalSteps) {
                this.confirmed = true;
            } else {
                this.stepIndex += 1;
                this._initStepState();
            }
        }

        return this.confirmed;
    }

    _evaluateStep(landmarks) {
        this.framesObserved += 1;
        const enoughFramesSeen = this.framesObserved >= MIN_TOTAL_FRAMES_BEFORE_CONFIRM;
        const type = this.challengeType;

        if (type === CHALLENGE_TYPES.BLINK) {
            const leftEAR = calculateEAR(landmarks.getLeftEye());
            const rightEAR = calculateEAR(landmarks.getRightEye());
            const avgEAR = (leftEAR + rightEAR) / 2;

            if (avgEAR < EAR_CLOSED_THRESHOLD) {
                this._closedRun += 1;
                this._openRun = 0;
                if (this._closedRun >= MIN_CONSECUTIVE_FRAMES) this.hasBeenClosed = true;
            } else if (avgEAR > EAR_OPEN_THRESHOLD) {
                this._closedRun = 0;
                if (this.hasBeenClosed) {
                    this._openRun += 1;
                    if (this._openRun >= MIN_CONSECUTIVE_FRAMES && enoughFramesSeen) return true;
                }
            }
            // Ambiguous middle ground (neither clearly open nor closed) -- a
            // single such frame doesn't reset progress (real blinks pass
            // through this band too), but doesn't extend a run either.
            return false;
        }

        const check = DIRECTION_CHECKS[type];
        const ratio = check.getRatio(landmarks);
        if (this.baselineRatio === null) {
            this.baselineRatio = ratio;
            return false;
        }

        const delta = ratio - this.baselineRatio;
        const matchesRequiredDirection = check.sign > 0 ? delta > check.threshold : delta < -check.threshold;

        if (matchesRequiredDirection) {
            this._directionRun += 1;
            if (this._directionRun >= MIN_CONSECUTIVE_FRAMES && enoughFramesSeen) return true;
        } else {
            // Any frame that doesn't match the SPECIFIC required direction --
            // wrong direction, oscillation, or back below threshold -- breaks
            // the run. This is what actually blocks incidental hand tremor:
            // real jitter from holding a photo up doesn't move consistently
            // one particular way on demand.
            this._directionRun = 0;
        }
        return false;
    }

    /** 0-1 progress indicator for the CURRENT step, for live UI feedback (same "numeric readout is the real feedback loop" pattern used elsewhere in this app). */
    getStepProgress() {
        if (this.challengeType === CHALLENGE_TYPES.BLINK) {
            return this.hasBeenClosed ? Math.min(this._openRun / MIN_CONSECUTIVE_FRAMES, 1) : 0;
        }
        return Math.min(this._directionRun / MIN_CONSECUTIVE_FRAMES, 1);
    }

    /** Starts a fresh challenge (new random sequence unless types are forced). */
    reset(forcedType = null, forcedSecondType = null) {
        this._resetState(forcedType, forcedSecondType);
    }
}

/**
 * @deprecated kept for backward compatibility — prefer RandomLivenessChallenge,
 * which adds 4 directional alternatives, a two-step sequence, sustained-motion
 * requirements, and a time box on top of this blink-only check.
 */
export class LivenessDetector {
    constructor() {
        this.hasBeenClosed = false;
        this.blinkConfirmed = false;
    }

    registerFrame(landmarks) {
        if (this.blinkConfirmed) return true;
        if (!landmarks || typeof landmarks.getLeftEye !== 'function') return false;

        const leftEAR = calculateEAR(landmarks.getLeftEye());
        const rightEAR = calculateEAR(landmarks.getRightEye());
        const avgEAR = (leftEAR + rightEAR) / 2;

        if (avgEAR < EAR_CLOSED_THRESHOLD) {
            this.hasBeenClosed = true;
        } else if (avgEAR > EAR_OPEN_THRESHOLD && this.hasBeenClosed) {
            this.blinkConfirmed = true;
        }

        return this.blinkConfirmed;
    }

    reset() {
        this.hasBeenClosed = false;
        this.blinkConfirmed = false;
    }
}
