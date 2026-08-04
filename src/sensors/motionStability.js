/**
 * Sensor-fusion motion stability tracker: fuses the x/y/z accelerometer
 * axes from `devicemotion` into a single magnitude signal and watches its
 * variance over a rolling window. A real handheld device is never
 * perfectly still — natural hand tremor keeps the variance above roughly
 * zero. A device that reads *exactly* motionless for a sustained window
 * (a phone taped to a wall, a tablet propped on a stand displaying a
 * replay video) is a soft, best-effort anti-spoofing signal — the same
 * non-blocking pattern already used for the border-uniformity anti-replay
 * check, not a new hard gate.
 *
 * Pure and framework-free so it's testable without any real sensor API.
 */
export function createMotionStabilityTracker({ bufferSize = 20, varianceFlatThreshold = 0.02 } = {}) {
    const buffer = [];

    function addReading({ x = 0, y = 0, z = 0 } = {}) {
        const magnitude = Math.sqrt(x * x + y * y + z * z);
        buffer.push(magnitude);
        if (buffer.length > bufferSize) buffer.shift();
    }

    function getStats() {
        if (buffer.length < bufferSize) return { ready: false, variance: 0, isSuspiciouslyFlat: false };
        const mean = buffer.reduce((sum, v) => sum + v, 0) / buffer.length;
        const variance = buffer.reduce((sum, v) => sum + (v - mean) ** 2, 0) / buffer.length;
        return { ready: true, variance, isSuspiciouslyFlat: variance < varianceFlatThreshold };
    }

    function reset() {
        buffer.length = 0;
    }

    return { addReading, getStats, reset };
}
