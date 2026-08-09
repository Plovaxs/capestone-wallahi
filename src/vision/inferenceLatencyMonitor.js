/**
 * Real-time, observed-performance edge-inference monitor -- complements
 * (doesn't replace) AttendanceView's static device-capability guess
 * (determineYoloVersion, based on navigator.hardwareConcurrency/
 * deviceMemory at mount time). A static guess can be wrong: a device
 * reported as "medium" tier might still struggle once other tabs/apps are
 * competing for CPU, or thermal throttling kicks in mid-session -- static
 * hints alone can't see that. This instead tracks the ACTUAL wall-clock
 * time each detection tick takes and flags when the device is measurably,
 * sustainedly falling behind its budget, so the caller can downgrade
 * detection quality (e.g. drop YOLO) based on real observed behavior
 * instead of a one-time prediction made before the session even started.
 */
const DEFAULT_BUFFER_SIZE = 8;
const DEFAULT_LATENCY_BUDGET_MS = 900;

export function createLatencyMonitor({ bufferSize = DEFAULT_BUFFER_SIZE, latencyBudgetMs = DEFAULT_LATENCY_BUDGET_MS } = {}) {
    const samples = [];

    function record(durationMs) {
        if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return;
        samples.push(durationMs);
        if (samples.length > bufferSize) samples.shift();
    }

    function getStats() {
        if (samples.length < bufferSize) {
            return { ready: false, avgMs: 0, isOverBudget: false };
        }
        const avgMs = samples.reduce((sum, v) => sum + v, 0) / samples.length;
        return { ready: true, avgMs, isOverBudget: avgMs > latencyBudgetMs };
    }

    function reset() {
        samples.length = 0;
    }

    return { record, getStats, reset };
}
