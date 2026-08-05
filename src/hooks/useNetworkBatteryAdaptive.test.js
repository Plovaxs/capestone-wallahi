import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

describe('useNetworkBatteryAdaptive', () => {
    afterEach(() => {
        vi.doUnmock('../utils/deviceAdaptive');
        vi.resetModules();
    });

    it('does nothing when inactive (e.g. supervisor viewing the page)', async () => {
        vi.doMock('../utils/deviceAdaptive', () => ({
            getNetworkProfile: () => ({ supported: true, effectiveType: '4g', isSlow: false }),
            getBatteryProfile: async () => ({ supported: true, level: 1, charging: true }),
            shouldReduceWorkload: () => false,
        }));
        const { useNetworkBatteryAdaptive } = await import('./useNetworkBatteryAdaptive');

        const { result } = renderHook(() => useNetworkBatteryAdaptive(false));
        expect(result.current.disableYolo).toBe(false);
        expect(result.current.networkBatteryDiagnostics.networkEffectiveType).toBeNull();
    });

    it('reports normal conditions without disabling YOLO on a fast connection with good battery', async () => {
        vi.doMock('../utils/deviceAdaptive', () => ({
            getNetworkProfile: () => ({ supported: true, effectiveType: '4g', isSlow: false }),
            getBatteryProfile: async () => ({ supported: true, level: 0.9, charging: false }),
            shouldReduceWorkload: (network, battery) => Boolean(network.isSlow || (battery.supported && battery.level < 0.2)),
        }));
        const { useNetworkBatteryAdaptive } = await import('./useNetworkBatteryAdaptive');

        const { result } = renderHook(() => useNetworkBatteryAdaptive(true));

        await waitFor(() => expect(result.current.networkBatteryDiagnostics.networkEffectiveType).toBe('4g'));
        expect(result.current.disableYolo).toBe(false);
        expect(result.current.networkBatteryDiagnostics.isSlowNetwork).toBe(false);
        expect(result.current.networkBatteryDiagnostics.batteryLevel).toBe(0.9);
    });

    it('disables YOLO when the network is slow', async () => {
        vi.doMock('../utils/deviceAdaptive', () => ({
            getNetworkProfile: () => ({ supported: true, effectiveType: '2g', isSlow: true }),
            getBatteryProfile: async () => ({ supported: true, level: 0.9, charging: false }),
            shouldReduceWorkload: (network) => Boolean(network.isSlow),
        }));
        const { useNetworkBatteryAdaptive } = await import('./useNetworkBatteryAdaptive');

        const { result } = renderHook(() => useNetworkBatteryAdaptive(true));

        await waitFor(() => expect(result.current.disableYolo).toBe(true));
        expect(result.current.networkBatteryDiagnostics.isSlowNetwork).toBe(true);
    });

    it('reports null battery fields when the Battery API is unsupported', async () => {
        vi.doMock('../utils/deviceAdaptive', () => ({
            getNetworkProfile: () => ({ supported: true, effectiveType: '4g', isSlow: false }),
            getBatteryProfile: async () => ({ supported: false, level: 1, charging: true }),
            shouldReduceWorkload: () => false,
        }));
        const { useNetworkBatteryAdaptive } = await import('./useNetworkBatteryAdaptive');

        const { result } = renderHook(() => useNetworkBatteryAdaptive(true));

        await waitFor(() => expect(result.current.networkBatteryDiagnostics.networkEffectiveType).toBe('4g'));
        expect(result.current.networkBatteryDiagnostics.batteryLevel).toBeNull();
        expect(result.current.networkBatteryDiagnostics.isCharging).toBeNull();
    });
});
