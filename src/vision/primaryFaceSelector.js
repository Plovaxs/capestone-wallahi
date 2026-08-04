/**
 * Picks the "primary" face out of every face detected in a frame instead
 * of treating any second face as an automatic reject. Real deployment
 * environments (a customs office lobby, a busy hallway) routinely put
 * bystanders in frame; blocking the scan every time someone walks past is
 * a real usability failure, not a security win.
 *
 * The primary face is the largest + most centered detection (i.e. the
 * person actually standing in front of the camera). A second face only
 * flags as `isAmbiguous` when it's both close in size to the primary AND
 * physically adjacent/overlapping it — that specific shape ("photo held
 * up right next to the real face") is the actual spoofing pattern worth
 * rejecting; a small, distant, or far-off-center face is just background.
 */
export function selectPrimaryFace(detections, imageWidth, imageHeight) {
    if (!detections || detections.length === 0) return { primary: null, isAmbiguous: false };
    if (detections.length === 1) return { primary: detections[0], isAmbiguous: false };

    const maxCenterDist = Math.hypot(imageWidth / 2, imageHeight / 2) || 1;

    const scored = detections
        .filter((d) => d.box)
        .map((d) => {
            const { box } = d;
            const area = box.width * box.height;
            const centerX = box.x + box.width / 2;
            const centerY = box.y + box.height / 2;
            const centerDist = Math.hypot(centerX - imageWidth / 2, centerY - imageHeight / 2);
            const centrality = 1 - centerDist / maxCenterDist;
            return { detection: d, area, centerX, centerY, score: area * (0.5 + 0.5 * centrality) };
        })
        .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return { primary: null, isAmbiguous: false };

    const [primary, runnerUp] = scored;
    let isAmbiguous = false;

    if (runnerUp) {
        const sizeRatio = runnerUp.area / primary.area;
        const gap = Math.hypot(primary.centerX - runnerUp.centerX, primary.centerY - runnerUp.centerY);
        const proximityThreshold = primary.detection.box.width * 1.5;
        isAmbiguous = sizeRatio > 0.6 && gap < proximityThreshold;
    }

    return { primary: primary.detection, isAmbiguous };
}
