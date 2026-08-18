/**
 * Frame-to-frame face-box position tracking, used as a mandatory liveness
 * signal alongside the active blink challenge: a live person is never
 * perfectly, pixel-for-pixel frozen between ticks (breathing, postural
 * sway, involuntary micro-tremor) -- a photo/phone/tablet propped up on a
 * stand or otherwise held rock-steady would read as unnaturally frozen.
 *
 * 🟩 KNOWN LIMITATION (documented deliberately, not an oversight): a photo
 * held in a human hand also shifts slightly between frames -- hands
 * tremble too. This alone cannot distinguish "a live face" from "a photo
 * wobbled by a hand," which is exactly the attack that defeated an
 * earlier passive-motion-only design during this project's own capstone
 * defense (see vision/livenessDetector.js's SECURITY HARDENING comment).
 * This is why it's a SUPPLEMENTARY mandatory check alongside the active
 * blink challenge, never a replacement for it -- a static photo (wobbled
 * or not) still cannot blink on request, which is what actually closes
 * that gap. Box-shift alone only rules out a perfectly rigid mount
 * (propped photo, phone on a stand), not a hand-held one.
 */
const DEFAULT_WINDOW_SIZE = 5;
// Some minimum jitter must be present across the recent window -- a
// perfectly identical box position tick after tick (delta below this
// floor) is the signature of a rigidly mounted image, not a person.
const MIN_NATURAL_SHIFT_RATIO = 0.004;
// Above this, frame-to-frame movement looks like tracking noise, a
// completely different face, or someone waving the camera/device around
// rather than incidental live-person jitter.
const MAX_NATURAL_SHIFT_RATIO = 0.3;

/**
 * Normalized center-to-center displacement between two face boxes (same
 * pixel coordinate space), as a fraction of their average size -- keeps
 * this resolution/distance-independent (a face closer to the camera has a
 * bigger box and bigger raw pixel movement for the same real-world motion).
 */
export function calculateBoxShiftRatio(prevBox, currentBox) {
    if (!prevBox || !currentBox) return null;

    const prevCenterX = prevBox.x + prevBox.width / 2;
    const prevCenterY = prevBox.y + prevBox.height / 2;
    const currentCenterX = currentBox.x + currentBox.width / 2;
    const currentCenterY = currentBox.y + currentBox.height / 2;
    const shift = Math.hypot(currentCenterX - prevCenterX, currentCenterY - prevCenterY);

    const referenceSize = (prevBox.width + prevBox.height + currentBox.width + currentBox.height) / 4;
    if (referenceSize === 0) return null;

    return shift / referenceSize;
}

/**
 * Re-expresses a box's position/size relative to a reference box (e.g. the
 * detected face), instead of raw frame coordinates. A rigidly-held photo/
 * phone wobbling in front of the camera moves EVERY point on it together --
 * the face box, the mouth box, the nose box all shift in lockstep -- so
 * their ABSOLUTE frame-to-frame motion (calculateBoxShiftRatio fed raw
 * boxes) can't tell "the whole photo wobbled" from "the mouth actually
 * moved," exactly the documented limitation on the face-box check above.
 * Genuine lip/nostril movement changes the feature's position RELATIVE TO
 * THE REST OF THE FACE (the mouth moves, the nose and jaw don't); a rigid
 * wobble leaves that relative position essentially unchanged, since
 * numerator and denominator shift together. Feed the result through
 * calculateBoxShiftRatio/createBoxMotionTracker exactly like a normal box --
 * it's just expressed in face-relative, not frame-absolute, coordinates.
 */
export function toFaceRelativeBox(box, faceBox) {
    if (!box || !faceBox || !faceBox.width || !faceBox.height) return null;
    return {
        x: (box.x - faceBox.x) / faceBox.width,
        y: (box.y - faceBox.y) / faceBox.height,
        width: box.width / faceBox.width,
        height: box.height / faceBox.height,
    };
}

/**
 * Rolling-window version of the same check -- a single tick's shift
 * reading is noisy (a genuinely live person can easily hold still for one
 * 350ms-1.8s tick interval, especially while concentrating on blinking on
 * cue), so this requires the window's WORST case for each direction: at
 * least one recent sample with real movement (rules out "frozen"), and no
 * recent sample wildly erratic (rules out "tracking noise/garbage"),
 * rather than judging any single tick in isolation.
 */
export function createBoxMotionTracker({ windowSize = DEFAULT_WINDOW_SIZE } = {}) {
    const samples = [];

    return {
        addSample(shiftRatio) {
            if (shiftRatio === null || !Number.isFinite(shiftRatio)) return;
            samples.push(shiftRatio);
            if (samples.length > windowSize) samples.shift();
        },

        getStats() {
            if (samples.length < windowSize) {
                return { ready: false, hasNaturalMovement: false, isErratic: false };
            }
            const max = Math.max(...samples);
            return {
                ready: true,
                hasNaturalMovement: max >= MIN_NATURAL_SHIFT_RATIO,
                isErratic: max > MAX_NATURAL_SHIFT_RATIO,
            };
        },

        reset() {
            samples.length = 0;
        },
    };
}
