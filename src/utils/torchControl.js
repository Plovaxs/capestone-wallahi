/**
 * Wraps the (Chromium-only, non-standard) MediaStreamTrack torch
 * constraint used to switch a device's camera flash into "flashlight"
 * mode. Front-facing laptop/desktop webcams never expose this capability
 * — every call here is a no-op there, which is the correct behavior, not
 * an error: this is a best-effort assist for mobile devices in a dim
 * room, not something the attendance flow can depend on.
 */
export function isTorchSupported(stream) {
    const track = stream?.getVideoTracks?.()[0];
    if (!track?.getCapabilities) return false;
    try {
        return Boolean(track.getCapabilities().torch);
    } catch {
        return false;
    }
}

export async function setTorch(stream, on) {
    const track = stream?.getVideoTracks?.()[0];
    if (!track || !isTorchSupported(stream)) return false;
    try {
        await track.applyConstraints({ advanced: [{ torch: on }] });
        return true;
    } catch {
        return false;
    }
}
