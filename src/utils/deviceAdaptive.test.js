import { describe, it, expect, afterEach, vi } from 'vitest';
import { getNetworkProfile, getBatteryProfile, shouldReduceWorkload } from './deviceAdaptive';

describe('getNetworkProfile', () => {
    afterEach(() => {
        delete navigator.connection;
    });

    it('reports unsupported when navigator.connection is absent', () => {
        expect(getNetworkProfile()).toEqual({ supported: false, effectiveType: null, saveData: false, isSlow: false });
    });

    it('flags a 3g connection as slow', () => {
        Object.defineProperty(navigator, 'connection', { value: { effectiveType: '3g', saveData: false }, configurable: true });
        expect(getNetworkProfile()).toEqual({ supported: true, effectiveType: '3g', saveData: false, isSlow: true });
    });

    it('flags saveData mode as slow regardless of effectiveType', () => {
        Object.defineProperty(navigator, 'connection', { value: { effectiveType: '4g', saveData: true }, configurable: true });
        expect(getNetworkProfile().isSlow).toBe(true);
    });

    it('does not flag a fast, non-saveData connection as slow', () => {
        Object.defineProperty(navigator, 'connection', { value: { effectiveType: '4g', saveData: false }, configurable: true });
        expect(getNetworkProfile().isSlow).toBe(false);
    });
});

describe('getBatteryProfile', () => {
    afterEach(() => {
        delete navigator.getBattery;
    });

    it('reports unsupported when navigator.getBattery is absent', async () => {
        expect(await getBatteryProfile()).toEqual({ supported: false, level: 1, charging: true, isLow: false });
    });

    it('flags a low, unplugged battery', async () => {
        navigator.getBattery = vi.fn().mockResolvedValue({ level: 0.15, charging: false });
        expect(await getBatteryProfile()).toEqual({ supported: true, level: 0.15, charging: false, isLow: true });
    });

    it('does not flag a low battery while charging', async () => {
        navigator.getBattery = vi.fn().mockResolvedValue({ level: 0.1, charging: true });
        const result = await getBatteryProfile();
        expect(result.isLow).toBe(false);
    });

    it('degrades gracefully if getBattery rejects', async () => {
        navigator.getBattery = vi.fn().mockRejectedValue(new Error('unavailable'));
        expect(await getBatteryProfile()).toEqual({ supported: false, level: 1, charging: true, isLow: false });
    });
});

describe('shouldReduceWorkload', () => {
    it('reduces workload when the network is slow', () => {
        expect(shouldReduceWorkload({ isSlow: true }, { isLow: false })).toBe(true);
    });

    it('reduces workload when the battery is low', () => {
        expect(shouldReduceWorkload({ isSlow: false }, { isLow: true })).toBe(true);
    });

    it('does not reduce workload under normal conditions', () => {
        expect(shouldReduceWorkload({ isSlow: false }, { isLow: false })).toBe(false);
    });

    it('handles missing profiles without throwing', () => {
        expect(shouldReduceWorkload(null, null)).toBe(false);
    });
});
