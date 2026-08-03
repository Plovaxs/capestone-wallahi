import { describe, it, expect, beforeEach } from 'vitest';
import { recordMatchDistance, clearStalenessCounter } from './descriptorStaleness';

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
