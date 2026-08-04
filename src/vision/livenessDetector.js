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

const EAR_CLOSED_THRESHOLD = 0.23;
const EAR_OPEN_THRESHOLD = 0.24;
const HEAD_TURN_THRESHOLD = 0.07;
const DEFAULT_CHALLENGE_TIMEOUT_MS = 15000;

export const CHALLENGE_TYPES = { BLINK: 'blink', HEAD_TURN: 'head_turn' };

const pickRandomChallengeType = () => (Math.random() < 0.5 ? CHALLENGE_TYPES.BLINK : CHALLENGE_TYPES.HEAD_TURN);

/**
 * Confirms the face in front of the camera is a live person, not a photo
 * or video replay, by requiring the user to complete ONE randomly-chosen
 * challenge — blink, or a small head turn — within a time window. Random
 * selection means a pre-recorded clip prepared for one challenge type
 * won't satisfy the other; the time box means a clip can't just be looped
 * until it happens to line up.
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
    }

    isExpired() {
        return !this.confirmed && Date.now() - this.startedAt > this.timeoutMs;
    }

    /** Feed one frame's landmarks in; returns true once the challenge is satisfied. */
    registerFrame(landmarks) {
        if (this.confirmed) return true;
        if (!landmarks || typeof landmarks.getLeftEye !== 'function') return false;
        if (this.isExpired()) return false;

        if (this.challengeType === CHALLENGE_TYPES.BLINK) {
            const leftEAR = calculateEAR(landmarks.getLeftEye());
            const rightEAR = calculateEAR(landmarks.getRightEye());
            const avgEAR = (leftEAR + rightEAR) / 2;

            if (avgEAR < EAR_CLOSED_THRESHOLD) {
                this.hasBeenClosed = true;
            } else if (avgEAR > EAR_OPEN_THRESHOLD && this.hasBeenClosed) {
                this.confirmed = true;
            }
        } else {
            const ratio = calculateHeadTurnRatio(landmarks);
            if (this.baselineTurnRatio === null) {
                this.baselineTurnRatio = ratio;
            } else if (Math.abs(ratio - this.baselineTurnRatio) > HEAD_TURN_THRESHOLD) {
                this.confirmed = true;
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
 * which adds a head-turn alternative and a time box on top of this blink-only check.
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
