const BADGE_VERSION = 1;

/**
 * Employee ID badge payload -- encodes just enough to look someone up
 * (their profile id) plus a display name for a quick human sanity-check
 * at the point of scanning. Deliberately NOT used as an authentication
 * factor or wired into clock-in: a QR code is trivially photographable
 * and re-printable, so treating it as proof of identity would be a real
 * security regression versus the face-recognition flow. Its value here is
 * convenience -- a scannable ID card for physical/visual verification
 * (e.g. a front-desk check), not a login credential.
 */
export function encodeBadgePayload(profile) {
    return JSON.stringify({ v: BADGE_VERSION, id: profile.id, name: profile.name });
}

export function decodeBadgePayload(text) {
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.v !== BADGE_VERSION || !parsed.id) return null;
        return { id: parsed.id, name: parsed.name || null };
    } catch {
        return null;
    }
}
