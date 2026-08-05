import { describe, it, expect, beforeEach } from 'vitest';
import { recordServerTimeCheckpoint, hasServerTimeCheckpoint, estimateTrustedNow, _resetCheckpointForTests } from './trustedClock';

describe('trustedClock', () => {
    beforeEach(() => {
        _resetCheckpointForTests();
    });

    it('has no checkpoint before recordServerTimeCheckpoint is ever called', () => {
        expect(hasServerTimeCheckpoint()).toBe(false);
    });

    it('estimateTrustedNow falls back to the device clock (flagged untrusted) with no checkpoint', () => {
        const before = Date.now();
        const result = estimateTrustedNow();
        expect(result.source).toBe('device_untrusted');
        expect(result.date.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('estimateTrustedNow projects forward from the checkpoint using elapsed monotonic time', () => {
        const serverDate = new Date('2026-01-01T08:00:00.000Z');
        recordServerTimeCheckpoint(serverDate);
        expect(hasServerTimeCheckpoint()).toBe(true);

        const result = estimateTrustedNow();
        expect(result.source).toBe('estimated');
        // Should be at/just after the checkpoint time (a few ms of real elapsed time in-test).
        expect(result.date.getTime()).toBeGreaterThanOrEqual(serverDate.getTime());
        expect(result.date.getTime()).toBeLessThan(serverDate.getTime() + 5000);
    });

    it('is NOT affected by changing the device wall clock (the entire point)', () => {
        const serverDate = new Date('2026-01-01T08:00:00.000Z');
        recordServerTimeCheckpoint(serverDate);

        // Simulate a spoofed system clock by stubbing Date globally to a
        // wildly different value -- estimateTrustedNow must not budge,
        // since it's anchored to performance.now(), not Date.now()/`new Date()`.
        const RealDate = Date;
        try {
            // eslint-disable-next-line no-global-assign
            Date = class extends RealDate {
                constructor(...args) {
                    if (args.length === 0) return new RealDate('2099-01-01T00:00:00.000Z');
                    return new RealDate(...args);
                }
                static now() { return new RealDate('2099-01-01T00:00:00.000Z').getTime(); }
            };

            const result = estimateTrustedNow();
            expect(result.source).toBe('estimated');
            expect(result.date.getTime()).toBeLessThan(serverDate.getTime() + 5000);
        } finally {
            // eslint-disable-next-line no-global-assign
            Date = RealDate;
        }
    });
});
