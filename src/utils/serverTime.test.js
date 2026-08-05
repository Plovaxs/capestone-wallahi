import { describe, it, expect, vi, afterEach } from 'vitest';
import { getServerNow, getTrustedNowOrEstimate } from './serverTime';
import { _resetCheckpointForTests } from './trustedClock';

describe('getServerNow', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('returns the server-provided Date header instead of the local clock', async () => {
        const serverDate = new Date('2026-01-01T00:00:00.000Z');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            headers: { get: (name) => (name === 'date' ? serverDate.toUTCString() : null) },
        }));

        const result = await getServerNow();
        expect(result.getTime()).toBe(serverDate.getTime());
    });

    it('falls back to local time when the request fails (e.g. offline)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        const before = Date.now();
        const result = await getServerNow();
        const after = Date.now();
        expect(result.getTime()).toBeGreaterThanOrEqual(before);
        expect(result.getTime()).toBeLessThanOrEqual(after);
    });

    it('falls back to local time when the Date header is missing', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ headers: { get: () => null } } ));
        const before = Date.now();
        const result = await getServerNow();
        expect(result.getTime()).toBeGreaterThanOrEqual(before);
    });
});

describe('getTrustedNowOrEstimate', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        _resetCheckpointForTests();
    });

    it('returns source "server" and the real server time when reachable', async () => {
        const serverDate = new Date('2026-01-01T08:00:00.000Z');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            headers: { get: (name) => (name === 'date' ? serverDate.toUTCString() : null) },
        }));

        const result = await getTrustedNowOrEstimate();
        expect(result.source).toBe('server');
        expect(result.date.getTime()).toBe(serverDate.getTime());
    });

    it('falls back to an "estimated" time (not the raw device clock) when offline but a checkpoint exists', async () => {
        // First call succeeds and plants a checkpoint...
        const serverDate = new Date('2026-01-01T08:00:00.000Z');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            headers: { get: (name) => (name === 'date' ? serverDate.toUTCString() : null) },
        }));
        await getTrustedNowOrEstimate();

        // ...then the network drops.
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        const result = await getTrustedNowOrEstimate();
        expect(result.source).toBe('estimated');
        expect(result.date.getTime()).toBeGreaterThanOrEqual(serverDate.getTime());
    });

    it('falls back to "device_untrusted" when offline and no checkpoint exists yet', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        const result = await getTrustedNowOrEstimate();
        expect(result.source).toBe('device_untrusted');
    });
});
