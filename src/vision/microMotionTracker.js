import { luminanceAtIndex } from './colorMath';

/**
 * Cheap, model-free "is this actually a live face" signal that works on
 * ANY device — including a plain desktop webcam, unlike the accelerometer-
 * based tracker in sensors/motionStability.js, which only has a signal to
 * read on phones/tablets that expose `devicemotion`. A live person always
 * has tiny involuntary motion (breathing, blood flow, micro-tremor, subtle
 * lighting flicker off skin); a printed photo or a screen replay held
 * rock-steady in front of the camera reads as near-zero pixel variance.
 *
 * Deliberately cheap: samples a small fixed grid of points (default 25)
 * instead of processing the whole region, and the caller feeds it the same
 * face-region ImageData already captured each tick for the brightness
 * check — no extra getImageData call, no extra canvas work, just a handful
 * of array reads and a rolling-window variance calculation.
 */
const DEFAULT_GRID_SIZE = 5; // 5x5 = 25 sample points
const DEFAULT_BUFFER_SIZE = 6; // ~a few ticks of the scan loop's cadence

/** Samples luminance at an evenly-spaced gridSize x gridSize grid across the region. */
export function sampleLuminanceGrid(imageData, width, height, gridSize = DEFAULT_GRID_SIZE) {
    if (!imageData || !width || !height) return [];
    const samples = [];
    for (let gy = 0; gy < gridSize; gy++) {
        for (let gx = 0; gx < gridSize; gx++) {
            const x = Math.min(width - 1, Math.floor(((gx + 0.5) / gridSize) * width));
            const y = Math.min(height - 1, Math.floor(((gy + 0.5) / gridSize) * height));
            samples.push(luminanceAtIndex(imageData, (y * width + x) * 4));
        }
    }
    return samples;
}

export function createMicroMotionTracker({ gridSize = DEFAULT_GRID_SIZE, bufferSize = DEFAULT_BUFFER_SIZE, varianceFlatThreshold = 0.15 } = {}) {
    const buffer = []; // each entry: this frame's per-grid-point luminance samples

    function addFrame(imageData, width, height) {
        const samples = sampleLuminanceGrid(imageData, width, height, gridSize);
        if (samples.length === 0) return;
        buffer.push(samples);
        if (buffer.length > bufferSize) buffer.shift();
    }

    function getStats() {
        if (buffer.length < bufferSize) return { ready: false, avgVariance: 0, isSuspiciouslyFlat: false };

        const pointCount = buffer[0].length;
        let totalVariance = 0;
        for (let p = 0; p < pointCount; p++) {
            const values = buffer.map((frame) => frame[p]);
            const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
            const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
            totalVariance += variance;
        }
        const avgVariance = totalVariance / pointCount;
        return { ready: true, avgVariance, isSuspiciouslyFlat: avgVariance < varianceFlatThreshold };
    }

    function reset() {
        buffer.length = 0;
    }

    return { addFrame, getStats, reset };
}
