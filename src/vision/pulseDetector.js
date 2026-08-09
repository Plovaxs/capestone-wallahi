/**
 * Remote photoplethysmography (rPPG) pulse-liveness detector.
 *
 * A live human face shows a genuine, tiny periodic oscillation in
 * reflected light off skin caused by blood volume changes with every
 * heartbeat -- invisible to the eye but detectable in the average
 * green-channel intensity of a face region sampled fast enough (green is
 * the most blood-volume-sensitive channel of the three; this is the same
 * principle a smartwatch's optical heart-rate sensor uses, applied to a
 * webcam instead of a dedicated LED/photodiode pair). A printed photo or a
 * screen replay carries no true periodic blood-flow signal in the human
 * heart-rate band -- this is a genuinely different biometric channel than
 * every shape/motion/color-texture check elsewhere in this app, closer in
 * spirit to what a dedicated retinal/iris scanner would add than any of
 * them, and unlike retina/iris scanning it's actually achievable with a
 * consumer webcam (those need dedicated infrared hardware no browser can
 * access).
 *
 * Deliberately decoupled from the much slower (~1-1.8s interval) face
 * detection/matching tick elsewhere in AttendanceView/LoginPage --
 * resolving a 0.7-3.5Hz (42-210 BPM) signal needs sampling well above that
 * rate (Nyquist), so callers feed this samples from a separate, fast
 * (~15-20Hz) interval instead that just reads average green-channel
 * intensity over the already-known face box -- cheap, no re-running face
 * detection.
 *
 * Uses autocorrelation (not FFT) to estimate periodicity: simpler, cheap
 * enough to run on the main thread at that rate, and copes fine with the
 * short (a few seconds), irregularly-timed sample windows a browser
 * `setInterval` actually produces (see resample()).
 */
const MIN_BPM = 42;
const MAX_BPM = 210;
const MIN_SAMPLES_FOR_ESTIMATE = 40; // ~2s at 20Hz -- short but usable
// A real pulse signal is a small AC fluctuation riding on a much larger DC
// average -- normalizing correlation strength against the signal's own
// variance keeps this threshold comparable across different lighting
// levels instead of needing per-scene tuning.
const MIN_PERIODICITY_STRENGTH = 0.35;

export function createPulseDetector({ bufferSeconds = 6, sampleRateHz = 20 } = {}) {
    const maxSamples = Math.round(bufferSeconds * sampleRateHz);
    const samples = []; // { value, t }

    function addSample(value, timestampMs = Date.now()) {
        samples.push({ value, t: timestampMs });
        while (samples.length > maxSamples) samples.shift();
    }

    function reset() {
        samples.length = 0;
    }

    /** Resamples the (possibly irregularly-timed) buffer onto an evenly spaced grid via linear interpolation -- autocorrelation assumes uniform spacing. */
    function resample() {
        if (samples.length < 2) return [];
        const t0 = samples[0].t;
        const tEnd = samples[samples.length - 1].t;
        const durationMs = tEnd - t0;
        if (durationMs <= 0) return [];

        const stepMs = 1000 / sampleRateHz;
        const grid = [];
        let sIdx = 0;
        for (let t = t0; t <= tEnd; t += stepMs) {
            while (sIdx < samples.length - 2 && samples[sIdx + 1].t < t) sIdx++;
            const a = samples[sIdx];
            const b = samples[Math.min(sIdx + 1, samples.length - 1)];
            const span = b.t - a.t;
            const ratio = span > 0 ? (t - a.t) / span : 0;
            grid.push(a.value + (b.value - a.value) * ratio);
        }
        return grid;
    }

    function getStats() {
        if (samples.length < MIN_SAMPLES_FOR_ESTIMATE) {
            return { ready: false, hasPlausiblePulse: false, estimatedBpm: null, strength: 0 };
        }

        const signal = resample();
        if (signal.length < MIN_SAMPLES_FOR_ESTIMATE) {
            return { ready: false, hasPlausiblePulse: false, estimatedBpm: null, strength: 0 };
        }

        // 🟩 LINEAR DETRENDING (not just mean removal): a slow monotonic
        // drift -- ambient lighting easing up/down, auto white balance
        // adjusting -- is smooth enough that its autocorrelation stays high
        // across every lag, which reads as a false "periodic" signal if
        // only the mean is subtracted. Fitting and removing the best-fit
        // line first (standard practice in real rPPG pipelines, typically
        // as a high-pass filter) leaves only genuine higher-frequency
        // oscillation for the autocorrelation step below to find.
        const n = signal.length;
        const xMean = (n - 1) / 2;
        const yMean = signal.reduce((s, v) => s + v, 0) / n;
        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i++) {
            num += (i - xMean) * (signal[i] - yMean);
            den += (i - xMean) ** 2;
        }
        const slope = den > 0 ? num / den : 0;
        const intercept = yMean - slope * xMean;
        const detrended = signal.map((v, i) => v - (slope * i + intercept));
        const variance = detrended.reduce((s, v) => s + v * v, 0) / detrended.length;

        if (variance < 1e-6) {
            // Perfectly flat signal -- can't have a pulse riding on nothing.
            return { ready: true, hasPlausiblePulse: false, estimatedBpm: null, strength: 0 };
        }

        const minLag = Math.max(1, Math.round((60 / MAX_BPM) * sampleRateHz));
        const maxLag = Math.min(Math.round((60 / MIN_BPM) * sampleRateHz), detrended.length - 1);

        let bestLag = -1;
        let bestCorrelation = -Infinity;
        for (let lag = minLag; lag <= maxLag; lag++) {
            let sum = 0;
            for (let i = 0; i < detrended.length - lag; i++) {
                sum += detrended[i] * detrended[i + lag];
            }
            const normalized = sum / ((detrended.length - lag) * variance);
            if (normalized > bestCorrelation) {
                bestCorrelation = normalized;
                bestLag = lag;
            }
        }

        const hasPlausiblePulse = bestLag > 0 && bestCorrelation >= MIN_PERIODICITY_STRENGTH;
        const estimatedBpm = bestLag > 0 ? Math.round((60 * sampleRateHz) / bestLag) : null;

        return { ready: true, hasPlausiblePulse, estimatedBpm, strength: Math.max(0, bestCorrelation) };
    }

    return { addSample, getStats, reset };
}

/** Average green-channel intensity over a region -- the sample this detector expects each tick. Exported so callers don't duplicate the pixel math. */
export function calculateAverageGreenChannel(imageData) {
    if (!imageData || imageData.length === 0) return 0;
    let sum = 0;
    let count = 0;
    for (let i = 1; i < imageData.length; i += 4) {
        sum += imageData[i];
        count++;
    }
    return count > 0 ? sum / count : 0;
}
