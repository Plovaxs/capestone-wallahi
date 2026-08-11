/**
 * Shared relative-luminance (grayscale) weighting, used across most of the
 * vision/* anti-spoofing heuristics (texture sharpness, device-edge
 * detection, replay/border checks, micro-motion, face quality, enrollment
 * quality). Was independently copy-pasted into 6 different files with no
 * shared helper -- if this weighting is ever revisited (e.g. tuned for a
 * reported false positive, as has happened for several other constants in
 * this pipeline), every copy would need to be found and updated by hand or
 * the heuristics would silently disagree on what "brightness" means.
 */
export function luminanceAtIndex(imageData, idx) {
    return 0.299 * imageData[idx] + 0.587 * imageData[idx + 1] + 0.114 * imageData[idx + 2];
}
