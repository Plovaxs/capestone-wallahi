/**
 * Detects a dominant, long, straight edge (a "line") running through the
 * frame -- the signature of a phone/tablet bezel or a photo's paper edge
 * held up in front of the camera. A live face against ordinary background
 * clutter (wall texture, desk, hair, clothing) has luminance spread out
 * fairly evenly across the frame; a device or photo edge instead produces
 * one clear step-change in average brightness at a specific column (a
 * vertical bezel/paper edge) or row (a horizontal edge) that holds for
 * the edge's FULL length -- unlike any single texture edge in a natural
 * scene, which is comparatively short and local. Bucketing into column/
 * row strips and comparing STRIP AVERAGES (rather than single-pixel
 * gradients) makes this robust to exactly where within a strip the line
 * happens to fall, and is what a bare per-pixel Sobel gradient isn't --
 * a spike's center pixel has a ~zero two-tap gradient relative to its own
 * identical neighbors on both sides. No object-detection model needed --
 * a statistical shape check, same spirit as textureSharpnessHeuristic.js.
 * One more independent vote for livenessFusion.js, not a standalone hard
 * gate (a real doorframe, laptop edge, or picture frame visible in
 * someone's normal background could trip this on its own).
 */
const GRID_SIZE = 24;
const ALONG_STRIP_STRIDE = 3;
// 🟩 LOOSENED (2026-08-11, real-user report): the analyzed region is the
// face box plus a 15% margin (see callers), which reaches into the
// temple/ear area -- exactly where a headphone band or ear cup sits. That
// produces a long, fairly consistent luminance step not unlike a phone/
// photo bezel, tripping this heuristic for headphone-wearing users. Raised
// from 3 to reduce that false-positive rate; a genuine device/photo edge
// (see the test file) still lands far above this. Uncalibrated against
// real hardware -- if headphones still trip it, this needs to go higher
// still, or the analyzed region needs to exclude the ear/temple strip.
const PEAK_RATIO_THRESHOLD = 4.5;

function luminanceAt(imageData, width, x, y) {
    const idx = (y * width + x) * 4;
    return 0.299 * imageData[idx] + 0.587 * imageData[idx + 1] + 0.114 * imageData[idx + 2];
}

/** Average luminance of a vertical strip [x0,x1), sampled down the full height (every ALONG_STRIP_STRIDE-th row). */
function columnStripAverage(imageData, width, height, x0, x1) {
    const x = Math.min(x1 - 1, x0);
    let sum = 0;
    let count = 0;
    for (let y = 0; y < height; y += ALONG_STRIP_STRIDE) {
        sum += luminanceAt(imageData, width, x, y);
        count++;
    }
    return count > 0 ? sum / count : 0;
}

/** Average luminance of a horizontal strip [y0,y1), sampled across the full width (every ALONG_STRIP_STRIDE-th column). */
function rowStripAverage(imageData, width, height, y0, y1) {
    const y = Math.min(y1 - 1, y0);
    let sum = 0;
    let count = 0;
    for (let x = 0; x < width; x += ALONG_STRIP_STRIDE) {
        sum += luminanceAt(imageData, width, x, y);
        count++;
    }
    return count > 0 ? sum / count : 0;
}

function peakRatio(deltas) {
    if (deltas.length === 0) return 0;
    const max = Math.max(...deltas);
    // Mean, not median: a single dominant edge only touches 1-2 of many
    // strip boundaries, so the median of the whole array is often exactly
    // 0. Mean stays meaningfully above zero as long as any real signal
    // exists anywhere, so "how many times bigger than the average
    // boundary" stays a well-behaved ratio instead of blowing up or
    // never firing against a mostly-flat array.
    const mean = deltas.reduce((sum, v) => sum + v, 0) / deltas.length;
    return mean > 0 ? max / mean : 0;
}

export function checkDeviceEdges(imageData, width, height, gridSize = GRID_SIZE) {
    if (!imageData || !width || !height || width < gridSize || height < gridSize) {
        return { suspicious: false, verticalPeakRatio: 0, horizontalPeakRatio: 0 };
    }

    const colAvg = [];
    for (let gx = 0; gx < gridSize; gx++) {
        const x0 = Math.floor((gx / gridSize) * width);
        const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) / gridSize) * width));
        colAvg.push(columnStripAverage(imageData, width, height, x0, x1));
    }

    const rowAvg = [];
    for (let gy = 0; gy < gridSize; gy++) {
        const y0 = Math.floor((gy / gridSize) * height);
        const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) / gridSize) * height));
        rowAvg.push(rowStripAverage(imageData, width, height, y0, y1));
    }

    const colDeltas = colAvg.slice(1).map((v, i) => Math.abs(v - colAvg[i]));
    const rowDeltas = rowAvg.slice(1).map((v, i) => Math.abs(v - rowAvg[i]));

    const verticalPeakRatio = peakRatio(colDeltas);
    const horizontalPeakRatio = peakRatio(rowDeltas);

    return {
        suspicious: verticalPeakRatio >= PEAK_RATIO_THRESHOLD || horizontalPeakRatio >= PEAK_RATIO_THRESHOLD,
        verticalPeakRatio,
        horizontalPeakRatio,
    };
}
