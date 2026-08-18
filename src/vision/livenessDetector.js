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
 * Tight bounding box (in the video's own native pixel coordinates, same
 * space as a face-api detection box) around a single eye's 6 landmark
 * points, padded a bit so the drawn box doesn't hug the eyelid line
 * exactly. Shared by whichever view wants to render "boxes around the
 * eyes" -- feed the result through faceOverlayGeometry.js's
 * calculateFaceOverlayStyle (it already accepts any {x,y,width,height}
 * box, not just a face box) to get mirrored/scaled CSS position.
 */
function eyeBoundingBox(eyePoints) {
    const xs = eyePoints.map((p) => p.x);
    const ys = eyePoints.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = maxX - minX;
    const height = maxY - minY;
    // Eyes are wide and flat -- padding purely by their own height would
    // give a near-invisible sliver of a box, so pad vertically by a
    // fraction of the WIDTH instead, plus a smaller horizontal margin.
    const padX = width * 0.25;
    const padY = width * 0.35;
    return { x: minX - padX, y: minY - padY, width: width + padX * 2, height: height + padY * 2 };
}

/**
 * Both eyes' bounding boxes for a detection's landmarks, or null if the
 * landmarks object doesn't expose eye points (e.g. a stale/malformed read).
 */
export function calculateEyeBoxes(landmarks) {
    const leftEye = landmarks?.getLeftEye?.();
    const rightEye = landmarks?.getRightEye?.();
    if (!leftEye?.length || !rightEye?.length) return null;
    return { left: eyeBoundingBox(leftEye), right: eyeBoundingBox(rightEye) };
}

/** Whether a single eye's own landmark points currently read as closed -- same threshold RandomLivenessChallenge's blink step uses, so the visual feedback always agrees with what's actually being counted. */
export function isEyeClosed(eyePoints) {
    return calculateEAR(eyePoints) < EAR_CLOSED_THRESHOLD;
}

/**
 * Head-turn ratio: horizontal offset of the nose tip from the midpoint
 * between the two jaw-outline endpoints, normalized by face width. Near 0
 * when facing the camera; grows in magnitude (sign indicates direction)
 * as the head turns left/right. Kept exported/used for the multi-angle
 * enrollment wizard (AttendanceView.jsx) -- no longer part of the
 * liveness CHALLENGE itself (see the 2026-08-11 note below).
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
 * nose tip sits between the eyebrow line and the chin. Same "kept for the
 * enrollment wizard, not the challenge" status as calculateHeadTurnRatio above.
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

/**
 * Raw (un-normalized) vertical span of the face -- eyebrow line to chin, in
 * the same pixel units as the landmarks themselves. Unlike calculatePitchRatio
 * (which divides BY this same span, so it stays ~constant under a uniform
 * vertical squeeze/foreshorten and can't see one happening), this is exactly
 * the measurement a forward/backward photo tilt shrinks or grows -- see its
 * use in the BLINK step below.
 */
export function calculateFaceVerticalSpan(landmarks) {
    const jaw = landmarks?.getJawOutline?.();
    const leftBrow = landmarks?.getLeftEyeBrow?.();
    const rightBrow = landmarks?.getRightEyeBrow?.();
    if (!jaw?.length || !leftBrow?.length || !rightBrow?.length) return 0;

    const browY = (leftBrow[Math.floor(leftBrow.length / 2)].y + rightBrow[Math.floor(rightBrow.length / 2)].y) / 2;
    const chinY = jaw[Math.floor(jaw.length / 2)].y;
    return Math.abs(chinY - browY);
}

/**
 * Mouth-width ratio: distance between the outer mouth corners (face-api's
 * 20-point mouth, points 0 and 6 of getMouth() = dlib's classic 48/54),
 * normalized by face width. Smiling visibly widens the mouth relative to
 * a neutral baseline -- same landmarks-only approach as every other
 * signal here, no extra model.
 */
export function calculateMouthWidthRatio(landmarks) {
    const mouth = landmarks.getMouth?.();
    const jaw = landmarks.getJawOutline?.();
    if (!mouth?.length || !jaw?.length) return 0;

    const leftCorner = mouth[0];
    const rightCorner = mouth[6];
    const mouthWidth = distance(leftCorner, rightCorner);
    const leftJaw = jaw[0];
    const rightJaw = jaw[jaw.length - 1];
    const faceWidth = distance(leftJaw, rightJaw);
    if (faceWidth === 0) return 0;

    return mouthWidth / faceWidth;
}

/**
 * Mouth-open ratio (Mouth Aspect Ratio, MAR) -- the mouth equivalent of
 * EAR above: inner-lip vertical gap (points 14/18) normalized by inner-lip
 * horizontal span (points 12/16). Near-constant for a closed mouth,
 * jumps noticeably when the jaw drops open.
 */
export function calculateMouthOpenRatio(landmarks) {
    const mouth = landmarks.getMouth?.();
    if (!mouth?.length) return 0;

    const top = mouth[14];
    const bottom = mouth[18];
    const left = mouth[12];
    const right = mouth[16];
    const vertical = distance(top, bottom);
    const horizontal = distance(left, right);
    if (horizontal === 0) return 0;

    return vertical / horizontal;
}

const EAR_CLOSED_THRESHOLD = 0.26;
const EAR_OPEN_THRESHOLD = 0.28;
// 🟩 SECURITY HARDENING (2026-08-10): a real photo, physically wobbled by
// hand while being held up to the camera, was reported to satisfy a
// single-frame-threshold-crossing challenge -- one bad landmark read or a
// moment of hand tremor was previously enough to confirm it outright.
// What a genuine, deliberate expression has that random jitter doesn't is
// SUSTAINED, CONSISTENT change across multiple frames -- every challenge
// type below requires that, not a single-frame crossing.
//
// 🟩 REDESIGN (2026-08-11a): the previous version of this file used 4
// head-turn/pitch directional challenges (look left/right/up/down)
// alongside blink. Real-user feedback: the yaw/pitch sensor felt
// "finicky" (device/webcam-angle-dependent, harder to satisfy reliably
// than a blink). Replaced with two more mouth/eye-landmark-shape
// challenges -- smile and mouth-open -- which use the exact same kind of
// 2D landmark-ratio math as blink (not head-pose estimation), so they
// should be just as reliable while still giving 3 distinct,
// unpredictable challenge types instead of 1.
//
// 🟩 REDESIGN (2026-08-11b): the app's face-detection tick only runs every
// 350ms-1.8s (Login/Attendance) -- a genuine human blink is typically
// 100-400ms, well under that. Requiring the closed/open state to hold for
// TWO separate ticks in a row meant a real blink was routinely too fast to
// ever land two consecutive samples inside it, so real users kept getting
// "skipped" past before the challenge registered anything. Lowered to a
// single-frame threshold crossing -- the anti-spoof property this relies
// on isn't frame-count, it's that the EAR must actually TRANSITION across
// both thresholds (closed then open): a static photo's eyes never move at
// all, so it can never trigger this regardless of how many frames are
// sampled, while a real blink now registers on whichever single tick
// happens to land during it.
const SMILE_THRESHOLD = 0.05;
const MOUTH_OPEN_THRESHOLD = 0.15;
// 🟩 SECURITY FIX (reported live): tilting a printed/screen photo forward
// toward the camera foreshortens the eyes in the 2D projection, shrinking
// EAR exactly like a real blink closing -- then tilting it back pushes EAR
// back above the open threshold, faking the whole closed->open transition
// with zero actual blink. A real blink is a ~100-400ms eyelid motion with
// no meaningful head rotation; a tilt attack always moves the WHOLE face's
// pitch along with it. See the pitch-stability check in _evaluateStep's
// BLINK branch below. Not calibrated against real hardware/lighting --
// tighten if a tilt attack still gets through, loosen if genuine blinks
// (naturally paired with a little incidental head motion a tick or two
// apart) start getting rejected.
const BLINK_PITCH_STABILITY_THRESHOLD = 0.12;
// 🟩 SECURITY FIX (reported live, follow-up): a steep enough forward tilt
// ("squinting" the photo hard) still got through the pitch check above --
// calculatePitchRatio divides by the face's own vertical span, so it's
// blind to a UNIFORM vertical squeeze (exactly what foreshortening is);
// only a lopsided nose-position shift within that span tripped it. This
// tracks the raw, un-normalized vertical span itself (calculateFaceVerticalSpan)
// between the closed and open samples instead -- a tilt severe enough to
// swing EAR across both thresholds necessarily shrinks/grows that raw span
// by a lot too, which a real blink (the eyelid moving, not the whole face
// changing size) never does. Ratio-based (not a fixed delta) since it's a
// physical-scale measurement. Not calibrated against real hardware --
// tighten if this specific tilt shape still gets through, loosen if
// genuine blinks (naturally paired with the user leaning slightly toward/
// away from the camera between ticks) start getting rejected.
const BLINK_FACE_SPAN_MIN_RATIO = 0.82;
const BLINK_FACE_SPAN_MAX_RATIO = 1.22;
const MIN_CONSECUTIVE_FRAMES = 1; // frames the triggering condition must hold (see 2026-08-11b above)
const MIN_TOTAL_FRAMES_BEFORE_CONFIRM = 4; // frames observed (this step) before confirmation is even possible
// 🟩 Two independent, unpredictable steps instead of one -- a static
// photo or a short looped/prerecorded clip prepared in advance for
// "blink" won't also satisfy a follow-up "smile" prompt it wasn't built
// for. Time box comfortably fits two sequential sustained-change steps
// even at AttendanceView's slower (1.8s) detection interval.
const DEFAULT_CHALLENGE_TIMEOUT_MS = 25000;
const DEFAULT_STEP_COUNT = 2;

export const CHALLENGE_TYPES = {
    BLINK: 'blink',
    SMILE: 'smile',
    MOUTH_OPEN: 'mouth_open',
};

// Maps each challenge type to a PascalCase suffix callers use to build
// their own namespaced i18n keys, e.g. `t('login.statusAwaiting' + suffix)`.
export const CHALLENGE_INSTRUCTION_SUFFIX = {
    [CHALLENGE_TYPES.BLINK]: 'Blink',
    [CHALLENGE_TYPES.SMILE]: 'Smile',
    [CHALLENGE_TYPES.MOUTH_OPEN]: 'MouthOpen',
};

// Glyph shown alongside the instruction -- live progress feedback
// (getStepProgress()) is the real signal a user follows moment to
// moment, same "numeric readout is the real feedback loop" pattern
// already established elsewhere in this app; the glyph is just a
// starting hint.
export const CHALLENGE_DIRECTION_GLYPH = {
    [CHALLENGE_TYPES.BLINK]: '👁️',
    [CHALLENGE_TYPES.SMILE]: '😊',
    [CHALLENGE_TYPES.MOUTH_OPEN]: '😮',
};

const ALL_CHALLENGE_TYPES = Object.values(CHALLENGE_TYPES);

// Which ratio function and threshold each non-blink challenge type checks
// -- both are "sustained increase past a threshold relative to this
// step's own baseline" checks, unlike blink's close-then-open pattern.
const EXPRESSION_CHECKS = {
    [CHALLENGE_TYPES.SMILE]: { getRatio: calculateMouthWidthRatio, threshold: SMILE_THRESHOLD },
    [CHALLENGE_TYPES.MOUTH_OPEN]: { getRatio: calculateMouthOpenRatio, threshold: MOUTH_OPEN_THRESHOLD },
};

const pickRandomChallengeType = (exclude = null) => {
    const pool = exclude ? ALL_CHALLENGE_TYPES.filter((t) => t !== exclude) : ALL_CHALLENGE_TYPES;
    return pool[Math.floor(Math.random() * pool.length)];
};

/**
 * Confirms the face in front of the camera is a live person, not a photo
 * or video replay, by requiring TWO sequential, unpredictable expressions
 * within one time window: blink, smile, or open your mouth (see
 * EXPRESSION_CHECKS). Each step requires SUSTAINED change (multiple
 * consecutive frames past threshold) rather than a single-frame crossing,
 * so incidental hand tremor from holding up a photo can't satisfy it.
 * Whatever an attacker prepared in advance (a photo, a short loop of the
 * enrolled person blinking) has to also happen to satisfy a second,
 * independently-randomized prompt it wasn't built for.
 */
export class RandomLivenessChallenge {
    constructor({ challengeType = null, secondChallengeType = null, timeoutMs = DEFAULT_CHALLENGE_TIMEOUT_MS, steps = DEFAULT_STEP_COUNT } = {}) {
        this.timeoutMs = timeoutMs;
        this.totalSteps = Math.max(1, steps);
        // 🟩 BUG FIX (2026-08-11): remembered so a parameterless reset() --
        // the common case, since every call site resets on expiry/passive-
        // suspicion/face-mismatch without re-specifying types -- reuses
        // whatever was forced here instead of silently falling back to a
        // random type. This app previously had to patch 12 separate
        // `.reset()` call sites across two views to force blink-only after
        // every reset; that was fixing the symptom at every call site
        // instead of the class's own footgun default.
        this._defaultFirstType = challengeType;
        this._defaultSecondType = secondChallengeType;
        this._resetState(challengeType, secondChallengeType);
    }

    _resetState(forcedFirstType, forcedSecondType) {
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
        this._expressionRun = 0;
        // Pitch reading / raw face vertical span captured at the moment eyes
        // last read as closed -- see the tilt-vs-blink checks in
        // _evaluateStep's BLINK branch.
        this._closedPitch = null;
        this._closedFaceSpan = null;
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
            const pitch = calculatePitchRatio(landmarks);
            const faceSpan = calculateFaceVerticalSpan(landmarks);

            if (avgEAR < EAR_CLOSED_THRESHOLD) {
                this._closedRun += 1;
                this._openRun = 0;
                if (this._closedRun >= MIN_CONSECUTIVE_FRAMES) {
                    this.hasBeenClosed = true;
                    this._closedPitch = pitch;
                    this._closedFaceSpan = faceSpan;
                }
            } else if (avgEAR > EAR_OPEN_THRESHOLD) {
                this._closedRun = 0;
                if (this.hasBeenClosed) {
                    // 🟩 SECURITY FIX: reject the open reading if the head's
                    // pitch swung too far from where it was at the closed
                    // reading -- see BLINK_PITCH_STABILITY_THRESHOLD's
                    // comment. A genuine blink leaves this near 0; a tilted-
                    // photo spoof is exactly what this catches.
                    const pitchDrift = Math.abs(pitch - this._closedPitch);
                    // 🟩 SECURITY FIX (follow-up): pitch alone missed a
                    // steep, purely-foreshortening tilt (it's normalized BY
                    // the face's own vertical span, so a uniform squeeze
                    // doesn't move it) -- catch that shape by requiring the
                    // RAW vertical span to have stayed roughly the same
                    // physical size too. See BLINK_FACE_SPAN_*_RATIO's comment.
                    const spanRatio = this._closedFaceSpan > 0 ? faceSpan / this._closedFaceSpan : 1;
                    if (
                        pitchDrift > BLINK_PITCH_STABILITY_THRESHOLD
                        || spanRatio < BLINK_FACE_SPAN_MIN_RATIO
                        || spanRatio > BLINK_FACE_SPAN_MAX_RATIO
                    ) {
                        return false;
                    }
                    this._openRun += 1;
                    if (this._openRun >= MIN_CONSECUTIVE_FRAMES && enoughFramesSeen) return true;
                }
            }
            // Ambiguous middle ground (neither clearly open nor closed) -- a
            // single such frame doesn't reset progress (real blinks pass
            // through this band too), but doesn't extend a run either.
            return false;
        }

        // SMILE / MOUTH_OPEN: sustained increase past this step's own baseline.
        const check = EXPRESSION_CHECKS[type];
        const ratio = check.getRatio(landmarks);
        if (this.baselineRatio === null) {
            this.baselineRatio = ratio;
            return false;
        }

        const delta = ratio - this.baselineRatio;
        if (delta > check.threshold) {
            this._expressionRun += 1;
            if (this._expressionRun >= MIN_CONSECUTIVE_FRAMES && enoughFramesSeen) return true;
        } else {
            // Dropped back toward baseline (or never really moved) -- not a
            // sustained expression change, reset the run.
            this._expressionRun = 0;
        }
        return false;
    }

    /** 0-1 progress indicator for the CURRENT step, for live UI feedback (same "numeric readout is the real feedback loop" pattern used elsewhere in this app). */
    getStepProgress() {
        if (this.challengeType === CHALLENGE_TYPES.BLINK) {
            return this.hasBeenClosed ? Math.min(this._openRun / MIN_CONSECUTIVE_FRAMES, 1) : 0;
        }
        return Math.min(this._expressionRun / MIN_CONSECUTIVE_FRAMES, 1);
    }

    /**
     * Starts a fresh challenge. With no arguments, reuses whatever type(s)
     * were forced at construction (or picks randomly again if none were);
     * pass explicit type(s) to override for this reset only.
     */
    reset(forcedType = this._defaultFirstType, forcedSecondType = this._defaultSecondType) {
        this._resetState(forcedType, forcedSecondType);
    }
}
