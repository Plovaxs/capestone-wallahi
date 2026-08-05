/**
 * Maps a detected face box (in the video's own native pixel coordinates)
 * onto CSS left/top/width/height for an absolutely-positioned overlay div
 * sitting on top of a `<video>` element rendered with `object-cover` and
 * mirrored via `transform: scaleX(-1)`.
 *
 * `object-cover` scales the video to fill its box while preserving aspect
 * ratio, cropping whichever dimension overflows -- so the box has to be
 * scaled by the same factor and offset by however much got cropped, then
 * horizontally flipped to land under the mirrored video image instead of
 * the raw (un-mirrored) detection coordinates.
 *
 * Was duplicated near-verbatim across AttendanceView.jsx and LoginPage.jsx
 * (both render a mirrored, object-cover video with a face box overlay);
 * extracted here so both share one implementation and one set of tests.
 */
export function calculateFaceOverlayStyle({ box, videoEl }) {
    if (!box || !videoEl) return null;

    const naturalWidth = videoEl.videoWidth || box.imageWidth;
    const naturalHeight = videoEl.videoHeight || box.imageHeight;
    const viewportWidth = videoEl.clientWidth || 0;
    const viewportHeight = videoEl.clientHeight || 0;

    if (!naturalWidth || !naturalHeight || !viewportWidth || !viewportHeight) return null;

    const naturalRatio = naturalWidth / naturalHeight;
    const viewportRatio = viewportWidth / viewportHeight;

    let displayedWidth = viewportWidth;
    let displayedHeight = viewportHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (viewportRatio > naturalRatio) {
        displayedHeight = viewportHeight;
        displayedWidth = viewportHeight * naturalRatio;
        offsetX = (viewportWidth - displayedWidth) / 2;
    } else {
        displayedWidth = viewportWidth;
        displayedHeight = viewportWidth / naturalRatio;
        offsetY = (viewportHeight - displayedHeight) / 2;
    }

    const scaleX = displayedWidth / naturalWidth;
    const scaleY = displayedHeight / naturalHeight;

    const boxWidth = box.width * scaleX;
    const boxHeight = box.height * scaleY;

    // Mirror correction: computes position relative to the flipped canvas.
    const standardLeft = offsetX + (box.x * scaleX);
    const mirroredLeft = viewportWidth - standardLeft - boxWidth;

    return {
        left: `${mirroredLeft}px`,
        top: `${offsetY + (box.y * scaleY)}px`,
        width: `${boxWidth}px`,
        height: `${boxHeight}px`,
    };
}
