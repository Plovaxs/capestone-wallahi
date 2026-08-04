/**
 * Network Information API + Battery Status API wrappers, both narrowly
 * supported (Chromium-family only; Battery API is restricted/removed in
 * several browsers over privacy-fingerprinting concerns) — every function
 * here degrades to a safe "assume normal conditions" default rather than
 * throwing when the API is missing.
 *
 * Used to decide whether to run the heavier YOLO face detector (a multi-MB
 * model fetch, plus meaningfully more CPU/battery per frame than face-api's
 * tiny detector alone) — on a slow/metered connection or draining battery,
 * skip it and fall back to the lighter always-available detector.
 */

export function getNetworkProfile() {
    const connection = typeof navigator !== 'undefined'
        ? (navigator.connection || navigator.mozConnection || navigator.webkitConnection)
        : null;

    if (!connection) return { supported: false, effectiveType: null, saveData: false, isSlow: false };

    const effectiveType = connection.effectiveType || null;
    const saveData = Boolean(connection.saveData);
    const isSlow = saveData || effectiveType === 'slow-2g' || effectiveType === '2g' || effectiveType === '3g';

    return { supported: true, effectiveType, saveData, isSlow };
}

export async function getBatteryProfile() {
    if (typeof navigator === 'undefined' || typeof navigator.getBattery !== 'function') {
        return { supported: false, level: 1, charging: true, isLow: false };
    }
    try {
        const battery = await navigator.getBattery();
        const level = battery.level;
        const charging = battery.charging;
        return { supported: true, level, charging, isLow: !charging && level < 0.2 };
    } catch {
        return { supported: false, level: 1, charging: true, isLow: false };
    }
}

/** Combines both signals into the single decision callers actually need. */
export function shouldReduceWorkload(networkProfile, batteryProfile) {
    return Boolean(networkProfile?.isSlow || batteryProfile?.isLow);
}
