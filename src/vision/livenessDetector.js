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
// enough to confirm either challenge outright. Raising thresholds alone
// doesn't fix this (incidental jitter can be just as large as a real,
// deliberate movement); what a genuine blink/head-turn has that random
// jitter doesn't is SUSTAINED, CONSISTENT motion across multiple frames.
// Both challenges below now require the triggering condition to hold for
// several consecutive frames, not one, and a minimum number of frames
// must have been observed in total before ANY confirmation is possible --
// closing the "got lucky in the first frame or two" window a static photo
// exploited.
const HEAD_TURN_THRESHOLD = 0.09;
const MIN_CONSECUTIVE_FRAMES = 2; // consecutive frames the triggering condition must hold
const MIN_TOTAL_FRAMES_BEFORE_CONFIRM = 4; // frames observed overall before confirmation is even possible
const DEFAULT_CHALLENGE_TIMEOUT_MS = 15000;

export const CHALLENGE_TYPES = { BLINK: 'blink', HEAD_TURN: 'head_turn' };

// 🟩 SECURITY: randomized again after a printed photo defeated a
// passive-only liveness check during the capstone defense (see
// vision/livenessFusion.js). Blink-only was simpler to spoof-proof
// against than it looks -- anything with real footage of the enrolled
// person's face blinking (a video replay, not just a static photo)
// would satisfy a blink-only challenge every time. Alternating
// unpredictably between blink and head-turn means whatever an attacker
// prepared in advance has to satisfy BOTH possible challenges, not just
// the one they optimized for. Per explicit request, the occasional
// extra couple of seconds for a head-turn is an accepted trade-off for
// closing this gap.
const pickRandomChallengeType = () => (Math.random() < 0.5 ? CHALLENGE_TYPES.BLINK : CHALLENGE_TYPES.HEAD_TURN);

/**
 * Confirms the face in front of the camera is a live person, not a photo
 * or video replay, by requiring the user to blink or turn their head
 * (randomly chosen per challenge, see pickRandomChallengeType above)
 * within a time window, with SUSTAINED motion (see the security-hardening
 * comment above the thresholds) rather than a single-frame threshold
 * crossing. The time box means a static photo or a looped clip can't
 * just be held up indefinitely waiting for a lucky sequence of frames.
 */
export class RandomLivenessChallenge {
    constructor({ challengeType = null, timeoutMs = DEFAULT_CHALLENGE_TIMEOUT_MS } = {}) {
        this.timeoutMs = timeoutMs;
        this._resetState(challengeType);
    }

    _resetState(forcedType = null) {
        this.challengeType = forcedType || pickRandomChallengeType();
        this.startedAt = Date.now();
        this.hasBeenClosed = false;
        this.baselineTurnRatio = null;
        this.confirmed = false;
        this.framesObserved = 0;
        // Consecutive-frame run counters, reset whenever the run breaks.
        this._closedRun = 0;
        this._openRun = 0;
        this._turnDirection = 0; // sign of the first sustained deviation, so a turn has to keep going the same way, not oscillate
        this._turnRun = 0;
    }

    isExpired() {
        return !this.confirmed && Date.now() - this.startedAt > this.timeoutMs;
    }

    /** Feed one frame's landmarks in; returns true once the challenge is satisfied. */
    registerFrame(landmarks) {
        if (this.confirmed) return true;
        if (!landmarks || typeof landmarks.getLeftEye !== 'function') return false;
        if (this.isExpired()) return false;

        this.framesObserved += 1;
        const enoughFramesSeen = this.framesObserved >= MIN_TOTAL_FRAMES_BEFORE_CONFIRM;

        if (this.challengeType === CHALLENGE_TYPES.BLINK) {
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
                    if (this._openRun >= MIN_CONSECUTIVE_FRAMES && enoughFramesSeen) this.confirmed = true;
                }
            } else {
                // Ambiguous middle ground (neither clearly open nor closed) --
                // a single such frame doesn't reset progress (real blinks pass
                // through this band too), but it doesn't extend a run either.
            }
        } else {
            const ratio = calculateHeadTurnRatio(landmarks);
            if (this.baselineTurnRatio === null) {
                this.baselineTurnRatio = ratio;
            } else {
                const delta = ratio - this.baselineTurnRatio;
                const direction = Math.sign(delta);
                const pastThreshold = Math.abs(delta) > HEAD_TURN_THRESHOLD;

                if (pastThreshold && direction !== 0 && (this._turnDirection === 0 || direction === this._turnDirection)) {
                    this._turnDirection = direction;
                    this._turnRun += 1;
                    if (this._turnRun >= MIN_CONSECUTIVE_FRAMES && enoughFramesSeen) this.confirmed = true;
                } else if (!pastThreshold) {
                    // Dropped back below threshold -- not a sustained turn, reset the run (but keep the baseline).
                    this._turnRun = 0;
                    this._turnDirection = 0;
                } else {
                    // Past threshold but in the OPPOSITE direction from the run in progress -- oscillation, not a real turn. Reset.
                    this._turnRun = 0;
                    this._turnDirection = 0;
                }
            }
        }

        return this.confirmed;
    }

    /** Starts a fresh challenge (new random type unless one is forced). */
    reset(forcedType = null) {
        this._resetState(forcedType);
    }
}

/**
 * @deprecated kept for backward compatibility — prefer RandomLivenessChallenge,
 * which adds a head-turn alternative, sustained-motion requirements, and a
 * time box on top of this blink-only check.
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
