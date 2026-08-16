import { describe, it, expect, vi } from 'vitest';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../data/repositories/systemSettingsRepository', () => ({
    systemSettingsRepository: { get: (...args) => getMock(...args) },
}));

import { isVirtualCameraCheckEnabled } from './systemSettings';

describe('isVirtualCameraCheckEnabled', () => {
    it('returns the stored boolean value when the row exists', async () => {
        getMock.mockResolvedValueOnce({ value: false });
        expect(await isVirtualCameraCheckEnabled()).toBe(false);
    });

    it('fails open to true when the row is missing', async () => {
        getMock.mockResolvedValueOnce(null);
        expect(await isVirtualCameraCheckEnabled()).toBe(true);
    });

    it('fails open to true when the stored value is not a boolean', async () => {
        getMock.mockResolvedValueOnce({ value: 'not-a-boolean' });
        expect(await isVirtualCameraCheckEnabled()).toBe(true);
    });

    it('fails open to true when the fetch throws', async () => {
        getMock.mockRejectedValueOnce(new Error('network error'));
        expect(await isVirtualCameraCheckEnabled()).toBe(true);
    });
});
