import { useEffect, useState } from 'react';
import { getNetworkProfile, getBatteryProfile, shouldReduceWorkload } from '../utils/deviceAdaptive';

/**
 * Watches the Network Information + Battery Status APIs (both narrowly
 * supported, both degrade to "assume normal conditions" where missing) and
 * decides whether the heavier YOLO face detector should be skipped in
 * favor of the always-available lighter one -- a multi-MB model fetch plus
 * meaningfully more CPU/battery per frame isn't worth it on a slow/metered
 * connection or a draining battery.
 *
 * Extracted out of AttendanceView.jsx: this effect doesn't touch the scan
 * loop, the webcam stream, or any other piece of that view's state, so it
 * was one of the few genuinely self-contained slices of that very large
 * component -- a plain "read some sensors, derive a decision" hook.
 *
 * `active` gates it the same way the call site did inline before
 * (skip entirely for supervisors, who never run the scan loop this feeds).
 */
export function useNetworkBatteryAdaptive(active) {
    const [disableYolo, setDisableYolo] = useState(false);
    const [diagnostics, setDiagnostics] = useState({
        networkEffectiveType: null,
        isSlowNetwork: false,
        batteryLevel: null,
        isCharging: null,
    });

    useEffect(() => {
        if (!active) return;
        let isCancelled = false;
        let batteryRef = null;

        const evaluate = async () => {
            const network = getNetworkProfile();
            const battery = await getBatteryProfile();
            if (isCancelled) return;
            setDisableYolo(shouldReduceWorkload(network, battery));
            setDiagnostics({
                networkEffectiveType: network.effectiveType,
                isSlowNetwork: network.isSlow,
                batteryLevel: battery.supported ? battery.level : null,
                isCharging: battery.supported ? battery.charging : null,
            });
        };

        evaluate();

        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        connection?.addEventListener?.('change', evaluate);

        (async () => {
            if (typeof navigator.getBattery !== 'function') return;
            try {
                const battery = await navigator.getBattery();
                if (isCancelled) return;
                batteryRef = battery;
                battery.addEventListener('levelchange', evaluate);
                battery.addEventListener('chargingchange', evaluate);
            } catch {
                // Battery API unavailable/denied — network signal alone still applies.
            }
        })();

        return () => {
            isCancelled = true;
            connection?.removeEventListener?.('change', evaluate);
            batteryRef?.removeEventListener('levelchange', evaluate);
            batteryRef?.removeEventListener('chargingchange', evaluate);
        };
    }, [active]);

    return { disableYolo, networkBatteryDiagnostics: diagnostics };
}
