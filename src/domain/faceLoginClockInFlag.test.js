import { describe, it, expect, beforeEach, vi } from 'vitest';
import { markFaceVerifiedLogin, consumeFaceVerifiedLoginFlag } from './faceLoginClockInFlag';

describe('faceLoginClockInFlag', () => {
    beforeEach(() => {
        sessionStorage.clear();
        vi.useRealTimers();
    });

    it('returns false when no flag was ever set', () => {
        expect(consumeFaceVerifiedLoginFlag()).toBe(false);
    });

    it('returns true right after marking a fresh face-verified login', () => {
        markFaceVerifiedLogin();
        expect(consumeFaceVerifiedLoginFlag()).toBe(true);
    });

    it('consumes the flag -- a second read returns false', () => {
        markFaceVerifiedLogin();
        expect(consumeFaceVerifiedLoginFlag()).toBe(true);
        expect(consumeFaceVerifiedLoginFlag()).toBe(false);
    });

    it('returns false once the flag is older than the max age window', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        markFaceVerifiedLogin();

        vi.setSystemTime(new Date('2026-01-01T00:01:00Z')); // +60s, well past the 30s window
        expect(consumeFaceVerifiedLoginFlag()).toBe(false);
        vi.useRealTimers();
    });
});
