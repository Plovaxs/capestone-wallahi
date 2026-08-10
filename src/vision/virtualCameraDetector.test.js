import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkVirtualCamera } from './virtualCameraDetector';

function mockDevices(devices) {
    Object.defineProperty(navigator, 'mediaDevices', {
        value: { enumerateDevices: vi.fn().mockResolvedValue(devices) },
        configurable: true,
    });
}

describe('checkVirtualCamera', () => {
    afterEach(() => {
        // Reset to jsdom's real default so tests don't bleed into each other.
        Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    });

    it('is not suspicious for an ordinary real webcam label', async () => {
        mockDevices([{ kind: 'videoinput', label: 'HD Pro Webcam C920' }]);
        const result = await checkVirtualCamera();
        expect(result.suspicious).toBe(false);
    });

    it('flags a known virtual-camera driver by name', async () => {
        mockDevices([{ kind: 'videoinput', label: 'OBS Virtual Camera' }]);
        const result = await checkVirtualCamera();
        expect(result.suspicious).toBe(true);
        expect(result.matchedLabel).toBe('OBS Virtual Camera');
    });

    it('flags other well-known virtual-camera tools case-insensitively', async () => {
        for (const label of ['ManyCam Virtual Webcam', 'Snap Camera', 'droidcam source 2', 'e2eSoft VCam']) {
            mockDevices([{ kind: 'videoinput', label }]);
            const result = await checkVirtualCamera();
            expect(result.suspicious, `expected "${label}" to be flagged`).toBe(true);
        }
    });

    it('ignores non-videoinput devices', async () => {
        mockDevices([{ kind: 'audioinput', label: 'OBS Virtual Camera Audio' }]);
        const result = await checkVirtualCamera();
        expect(result.suspicious).toBe(false);
    });

    it('does not crash and fails open when enumerateDevices is unavailable', async () => {
        Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
        const result = await checkVirtualCamera();
        expect(result).toEqual({ suspicious: false, matchedLabel: null });
    });

    it('fails open when enumerateDevices throws', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {
            value: { enumerateDevices: vi.fn().mockRejectedValue(new Error('boom')) },
            configurable: true,
        });
        const result = await checkVirtualCamera();
        expect(result).toEqual({ suspicious: false, matchedLabel: null });
    });
});
