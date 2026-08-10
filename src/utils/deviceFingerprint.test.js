import { describe, it, expect } from 'vitest';
import { computeDeviceFingerprint, buildFingerprintSource, deriveDeviceLabel } from './deviceFingerprint';

describe('computeDeviceFingerprint', () => {
    it('produces a stable, deterministic hash for the same environment', async () => {
        const a = await computeDeviceFingerprint();
        const b = await computeDeviceFingerprint();
        expect(a).toBe(b);
        expect(typeof a).toBe('string');
        expect(a.length).toBeGreaterThan(0);
    });

    it('produces different hashes for different fingerprint sources', async () => {
        const a = await computeDeviceFingerprint();
        const originalUA = navigator.userAgent;
        Object.defineProperty(navigator, 'userAgent', { value: 'TotallyDifferentBrowser/1.0', configurable: true });
        const b = await computeDeviceFingerprint();
        Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true });
        expect(a).not.toBe(b);
    });
});

describe('buildFingerprintSource', () => {
    it('includes the user agent string', () => {
        expect(buildFingerprintSource()).toContain(navigator.userAgent);
    });
});

describe('deriveDeviceLabel', () => {
    it('identifies Chrome on Windows', () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        });
        expect(deriveDeviceLabel()).toBe('Chrome on Windows');
    });

    it('identifies Safari on macOS', () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            configurable: true,
        });
        expect(deriveDeviceLabel()).toBe('Safari on macOS');
    });

    it('falls back to "Unknown" labels for an unrecognized user agent', () => {
        Object.defineProperty(navigator, 'userAgent', { value: 'SomeExoticClient/1.0', configurable: true });
        expect(deriveDeviceLabel()).toBe('Unknown browser on Unknown OS');
    });
});
