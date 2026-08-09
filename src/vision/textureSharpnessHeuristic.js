/**
 * Local edge-energy (gradient magnitude) texture check — complementary to
 * the color-domain texture check in colorLivenessHeuristic.js. Real skin
 * viewed up close on a webcam shows fine involuntary detail (pores,
 * individual hair strands, subtle creases) that survives even modest
 * JPEG/video compression. A printed photo re-photographed by a webcam, or
 * a phone/tablet screen showing a photo, loses most of that fine
 * luminance-gradient detail to print halftoning or screen subpixel/
 * anti-aliasing filtering respectively. This samples a small grid of local
 * gradient magnitudes and flags suspicious only when they're unnaturally,
 * uniformly flat — one more independent vote for livenessFusion.js, never
 * a standalone hard gate (same design as every other heuristic here).
 */
const GRID_SIZE = 8;
const EDGE_ENERGY_FLAT_THRESHOLD = 6;

/** Simple 2-tap gradient magnitude sampled at an evenly-spaced grid across the region. */
export function calculateEdgeEnergyGrid(imageData, width, height, gridSize = GRID_SIZE) {
    if (!imageData || !width || !height) return [];

    const luminanceAt = (x, y) => {
        const cx = Math.min(width - 1, Math.max(0, x));
        const cy = Math.min(height - 1, Math.max(0, y));
        const idx = (cy * width + cx) * 4;
        return 0.299 * imageData[idx] + 0.587 * imageData[idx + 1] + 0.114 * imageData[idx + 2];
    };

    const energies = [];
    for (let gy = 0; gy < gridSize; gy++) {
        for (let gx = 0; gx < gridSize; gx++) {
            const x = Math.floor(((gx + 0.5) / gridSize) * width);
            const y = Math.floor(((gy + 0.5) / gridSize) * height);
            const gxGrad = luminanceAt(x + 1, y) - luminanceAt(x - 1, y);
            const gyGrad = luminanceAt(x, y + 1) - luminanceAt(x, y - 1);
            energies.push(Math.sqrt(gxGrad * gxGrad + gyGrad * gyGrad));
        }
    }
    return energies;
}

export function checkTextureSharpness(imageData, width, height) {
    const energies = calculateEdgeEnergyGrid(imageData, width, height);
    if (energies.length === 0) return { suspicious: false, avgEdgeEnergy: 0 };
    const avgEdgeEnergy = energies.reduce((sum, v) => sum + v, 0) / energies.length;
    return { suspicious: avgEdgeEnergy < EDGE_ENERGY_FLAT_THRESHOLD, avgEdgeEnergy };
}
