/**
 * Detects a virtual/software camera driver (OBS Virtual Camera, ManyCam,
 * Snap Camera, DroidCam, etc.) supplying the video stream instead of a
 * real physical webcam -- the actual dominant real-world technique for
 * beating browser-based liveness checks today (per Mitek/Regula/doubango's
 * published write-ups on "video injection attacks"): rather than holding
 * a photo up to a real camera (which the other heuristics in this app --
 * livenessFusion.js, handRegionHeuristic.js, deviceEdgeHeuristic.js --
 * are built to catch), an attacker feeds a pre-rendered or synthetic
 * video stream through a virtual-camera driver so this app's JS never
 * observes a genuine optical capture of anything at all.
 *
 * `MediaDeviceInfo.label` for camera devices only becomes populated once
 * the page holds an active camera permission grant (a browser privacy
 * measure) -- callers must invoke this AFTER getUserMedia has already
 * resolved, not before.
 *
 * A real user's actual webcam driver name essentially never coincidentally
 * matches one of these -- unlike this app's other, individually-noisier
 * heuristics, a name match here is treated as a hard, blocking signal
 * (same treatment as automationDetector.js's navigator.webdriver check),
 * not one more vote in the passive fusion. The one real limitation: this
 * is a name-string check, so a deliberately relabeled virtual device (or
 * a brand-new driver not in this list) isn't caught -- raises the cost of
 * this specific attack technique for anyone using off-the-shelf tooling
 * without bothering to rename it, not a guarantee against a determined,
 * knowledgeable attacker.
 */
const VIRTUAL_CAMERA_NAME_PATTERNS = [
    /obs\b/i,
    /virtual\s*cam/i,
    /manycam/i,
    /snap\s*camera/i,
    /xsplit/i,
    /camtwist/i,
    /splitcam/i,
    /chromacam/i,
    /iriun/i,
    /droidcam/i,
    /epoccam/i,
    /\bndi\b/i,
    /streamlabs/i,
    /e2esoft/i,
    /wondershare/i,
    /youcam/i,
    /\bvcam\b/i,
    /logitech capture/i,
    /nvidia broadcast/i,
    /elgato\s*camera\s*hub/i,
];

export async function checkVirtualCamera() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
        return { suspicious: false, matchedLabel: null };
    }
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const match = devices.find(
            (d) => d.kind === 'videoinput' && d.label && VIRTUAL_CAMERA_NAME_PATTERNS.some((pattern) => pattern.test(d.label))
        );
        return { suspicious: !!match, matchedLabel: match?.label ?? null };
    } catch {
        // enumerateDevices failing outright is a browser/environment quirk,
        // not evidence of anything -- fail open (non-suspicious) rather
        // than blocking a real user over an unrelated API error.
        return { suspicious: false, matchedLabel: null };
    }
}
