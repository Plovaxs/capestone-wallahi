import { describe, it, expect, vi, afterEach } from 'vitest';
import { TokenBucket, getBucket } from './tokenBucket';

describe('TokenBucket', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('allows consumption up to capacity', () => {
        const bucket = new TokenBucket({ capacity: 3, refillRatePerSec: 0 });
        expect(bucket.tryConsume()).toBe(true);
        expect(bucket.tryConsume()).toBe(true);
        expect(bucket.tryConsume()).toBe(true);
    });

    it('rejects consumption once the bucket is empty', () => {
        const bucket = new TokenBucket({ capacity: 1, refillRatePerSec: 0 });
        expect(bucket.tryConsume()).toBe(true);
        expect(bucket.tryConsume()).toBe(false);
    });

    it('refills over time up to capacity', () => {
        vi.useFakeTimers();
        const bucket = new TokenBucket({ capacity: 2, refillRatePerSec: 1 });
        bucket.tryConsume();
        bucket.tryConsume();
        expect(bucket.tryConsume()).toBe(false);

        vi.advanceTimersByTime(1000);
        expect(bucket.tryConsume()).toBe(true);
    });

    it('reports zero wait time when tokens are available', () => {
        const bucket = new TokenBucket({ capacity: 1, refillRatePerSec: 1 });
        expect(bucket.msUntilNextToken()).toBe(0);
    });
});

describe('getBucket', () => {
    it('returns the same bucket instance for the same key', () => {
        const a = getBucket('shared-key-test', { capacity: 5, refillRatePerSec: 1 });
        const b = getBucket('shared-key-test', { capacity: 5, refillRatePerSec: 1 });
        expect(a).toBe(b);
    });
});
