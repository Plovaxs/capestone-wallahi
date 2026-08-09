import { describe, it, expect } from 'vitest';
import { createPulseDetector, calculateAverageGreenChannel } from './pulseDetector';

/** Feeds a clean sine wave at `bpm` into the detector, sampled at sampleRateHz for durationSeconds. */
function feedSyntheticPulse(detector, { bpm, sampleRateHz, durationSeconds, amplitude = 1, dc = 128, startT = 0 }) {
    const freqHz = bpm / 60;
    const stepMs = 1000 / sampleRateHz;
    const totalSamples = Math.round(durationSeconds * sampleRateHz);
    for (let i = 0; i < totalSamples; i++) {
        const tMs = startT + i * stepMs;
        const value = dc + amplitude * Math.sin(2 * Math.PI * freqHz * (tMs / 1000));
        detector.addSample(value, tMs);
    }
}

describe('createPulseDetector', () => {
    it('is not ready before enough samples accumulate', () => {
        const detector = createPulseDetector({ sampleRateHz: 20 });
        detector.addSample(128, 0);
        detector.addSample(129, 50);
        expect(detector.getStats().ready).toBe(false);
    });

    it('detects a clean synthetic pulse at 72 BPM within a reasonable tolerance', () => {
        const detector = createPulseDetector({ bufferSeconds: 6, sampleRateHz: 20 });
        feedSyntheticPulse(detector, { bpm: 72, sampleRateHz: 20, durationSeconds: 6 });
        const stats = detector.getStats();
        expect(stats.ready).toBe(true);
        expect(stats.hasPlausiblePulse).toBe(true);
        expect(stats.estimatedBpm).toBeGreaterThanOrEqual(60);
        expect(stats.estimatedBpm).toBeLessThanOrEqual(84); // +-12 BPM tolerance -- autocorrelation lag resolution is coarse over a short window
    });

    it('detects a faster synthetic pulse at 110 BPM', () => {
        const detector = createPulseDetector({ bufferSeconds: 6, sampleRateHz: 20 });
        feedSyntheticPulse(detector, { bpm: 110, sampleRateHz: 20, durationSeconds: 6 });
        const stats = detector.getStats();
        expect(stats.hasPlausiblePulse).toBe(true);
        expect(stats.estimatedBpm).toBeGreaterThanOrEqual(95);
        expect(stats.estimatedBpm).toBeLessThanOrEqual(125);
    });

    it('does not find a plausible pulse in a perfectly flat signal (a static photo/screen)', () => {
        const detector = createPulseDetector({ bufferSeconds: 6, sampleRateHz: 20 });
        for (let i = 0; i < 120; i++) detector.addSample(128, i * 50);
        const stats = detector.getStats();
        expect(stats.ready).toBe(true);
        expect(stats.hasPlausiblePulse).toBe(false);
        expect(stats.estimatedBpm).toBe(null);
    });

    it('does not find a plausible pulse in a non-periodic monotonic drift (e.g. slow lighting change)', () => {
        const detector = createPulseDetector({ bufferSeconds: 6, sampleRateHz: 20 });
        for (let i = 0; i < 120; i++) detector.addSample(100 + i * 0.2, i * 50);
        const stats = detector.getStats();
        expect(stats.hasPlausiblePulse).toBe(false);
    });

    it('reset() clears the buffer back to not-ready', () => {
        const detector = createPulseDetector({ sampleRateHz: 20 });
        feedSyntheticPulse(detector, { bpm: 72, sampleRateHz: 20, durationSeconds: 6 });
        expect(detector.getStats().ready).toBe(true);
        detector.reset();
        expect(detector.getStats().ready).toBe(false);
    });

    it('handles irregularly-timed samples (real setInterval jitter) via resampling', () => {
        const detector = createPulseDetector({ bufferSeconds: 6, sampleRateHz: 20 });
        const freqHz = 72 / 60;
        let t = 0;
        for (let i = 0; i < 130; i++) {
            // Jittered step: nominally 50ms, +-15ms noise (deterministic, not random, for a stable test).
            const jitter = (i % 3 === 0) ? 15 : (i % 3 === 1) ? -10 : 5;
            t += 50 + jitter;
            detector.addSample(128 + Math.sin(2 * Math.PI * freqHz * (t / 1000)), t);
        }
        const stats = detector.getStats();
        expect(stats.ready).toBe(true);
        expect(stats.hasPlausiblePulse).toBe(true);
    });
});

describe('calculateAverageGreenChannel', () => {
    it('averages only the green channel across all pixels', () => {
        // 2 pixels: [R,G,B,A, R,G,B,A] = [10,20,30,255, 50,60,70,255]
        const data = new Uint8ClampedArray([10, 20, 30, 255, 50, 60, 70, 255]);
        expect(calculateAverageGreenChannel(data)).toBe((20 + 60) / 2);
    });

    it('returns 0 for missing/empty input', () => {
        expect(calculateAverageGreenChannel(null)).toBe(0);
        expect(calculateAverageGreenChannel(new Uint8ClampedArray(0))).toBe(0);
    });
});
