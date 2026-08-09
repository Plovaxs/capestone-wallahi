import { describe, it, expect, beforeEach } from 'vitest';
import { recordMatchDistance, clearStalenessCounter, getAdaptiveThreshold } from './descriptorStaleness';

describe('recordMatchDistance', () => {
    const userId = 'user-staleness-test';

    beforeEach(() => {
        localStorage.clear();
    });

    it('increments the counter for a near-threshold match', () => {
        const threshold = 0.5;
        const result = recordMatchDistance(userId, 0.48, threshold);
        expect(result.count).toBe(1);
    });

    it('decrements (floored at 0) the counter for a confident match', () => {
        recordMatchDistance(userId, 0.48, 0.5);
        recordMatchDistance(userId, 0.48, 0.5);
        const result = recordMatchDistance(userId, 0.1, 0.5);
        expect(result.count).toBe(1);
    });

    it('never goes below zero', () => {
        const result = recordMatchDistance(userId, 0.1, 0.5);
        expect(result.count).toBe(0);
    });

    it('suggests re-enrollment once the reminder count is reached', () => {
        let result;
        for (let i = 0; i < 5; i++) {
            result = recordMatchDistance(userId, 0.48, 0.5, { reminderCount: 5 });
        }
        expect(result.shouldSuggestReEnrollment).toBe(true);
    });

    it('does not suggest re-enrollment before the reminder count is reached', () => {
        const result = recordMatchDistance(userId, 0.48, 0.5, { reminderCount: 5 });
        expect(result.shouldSuggestReEnrollment).toBe(false);
    });

    it('clearStalenessCounter resets the count to zero', () => {
        recordMatchDistance(userId, 0.48, 0.5);
        clearStalenessCounter(userId);
        const result = recordMatchDistance(userId, 0.1, 0.5);
        expect(result.count).toBe(0);
    });
});

describe('getAdaptiveThreshold', () => {
    const userId = 'user-adaptive-test';
    const globalThreshold = 0.5;

    beforeEach(() => {
        localStorage.clear();
    });

    it('falls back to the global threshold before enough history has accumulated', () => {
        for (let i = 0; i < 3; i++) recordMatchDistance(userId, 0.45, globalThreshold);
        expect(getAdaptiveThreshold(userId, globalThreshold, { minSamples: 8 })).toBe(globalThreshold);
    });

    it('never returns less than the global threshold (one-directional: loosen only, never tighten)', () => {
        // Consistently very confident matches (low distance) -- a naive
        // adaptation might try to tighten the threshold here, which this
        // function must never do.
        for (let i = 0; i < 10; i++) recordMatchDistance(userId, 0.1, globalThreshold);
        expect(getAdaptiveThreshold(userId, globalThreshold, { minSamples: 8 })).toBe(globalThreshold);
    });

    it('never returns more than globalThreshold + maxLooseningMargin, even for a consistently borderline history', () => {
        for (let i = 0; i < 10; i++) recordMatchDistance(userId, 0.49, globalThreshold);
        const adaptive = getAdaptiveThreshold(userId, globalThreshold, { minSamples: 8, maxLooseningMargin: 0.05 });
        expect(adaptive).toBeLessThanOrEqual(globalThreshold + 0.05);
        expect(adaptive).toBeGreaterThanOrEqual(globalThreshold);
    });

    it('loosens somewhat for someone whose successful matches have real variance near the threshold', () => {
        // Genuine spread (not all-identical, which would have zero stdDev
        // and nothing to loosen based on) with a mean+stdDev that lands
        // just past the global threshold.
        for (let i = 0; i < 5; i++) recordMatchDistance(userId, 0.45, globalThreshold);
        for (let i = 0; i < 5; i++) recordMatchDistance(userId, 0.499, globalThreshold);
        const adaptive = getAdaptiveThreshold(userId, globalThreshold, { minSamples: 8, maxLooseningMargin: 0.05 });
        expect(adaptive).toBeGreaterThan(globalThreshold);
    });

    it('is unaffected by a different user\'s history (per-user isolation)', () => {
        for (let i = 0; i < 10; i++) recordMatchDistance('other-user', 0.49, globalThreshold);
        expect(getAdaptiveThreshold(userId, globalThreshold, { minSamples: 8 })).toBe(globalThreshold);
    });
});
