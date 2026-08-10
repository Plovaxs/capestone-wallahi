/**
 * Lightweight, client-computed device identifier -- NOT a robust
 * fingerprinting library (no canvas/WebGL/audio entropy collection), just
 * a stable hash of ordinary navigator/screen properties. Good enough to
 * recognize "this is a device this account has used before" vs. "this is
 * new" (see migrations/20260810_add_device_trust.sql) without adding a
 * fingerprinting dependency or raising the privacy stakes of what's
 * fundamentally a "notify on new sign-in" feature, not a tracking one.
 */
export function buildFingerprintSource() {
    if (typeof navigator === 'undefined') return '';
    const screenInfo = typeof screen !== 'undefined' ? `${screen.width}x${screen.height}x${screen.colorDepth}` : '';
    let timeZone = '';
    try {
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
        // Intl unavailable in some minimal environments -- not fatal, just omit it.
    }
    return [
        navigator.userAgent || '',
        navigator.platform || '',
        navigator.language || '',
        screenInfo,
        timeZone,
        navigator.hardwareConcurrency ?? '',
    ].join('|');
}

/** Deterministic, non-cryptographic fallback (FNV-1a) for environments without SubtleCrypto (very old browsers, non-secure contexts). */
function fnv1aHash(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export async function computeDeviceFingerprint() {
    const source = buildFingerprintSource();
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        try {
            const data = new TextEncoder().encode(source);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
        } catch {
            // SubtleCrypto can still throw in some restricted contexts -- fall through to the FNV-1a fallback below.
        }
    }
    return fnv1aHash(source);
}

/** Parses a short "Browser on OS" label from the user agent for a human-readable device list -- deliberately approximate, not a full UA-parsing library. */
export function deriveDeviceLabel() {
    if (typeof navigator === 'undefined') return 'Unknown device';
    const ua = navigator.userAgent || '';

    let browser = 'Unknown browser';
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/OPR\//.test(ua)) browser = 'Opera';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'Safari';

    let os = 'Unknown OS';
    if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS';
    else if (/Linux/.test(ua)) os = 'Linux';

    return `${browser} on ${os}`;
}
