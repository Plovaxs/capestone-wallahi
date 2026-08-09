/**
 * Tiny sessionStorage handshake between LoginPage.jsx and App.jsx: lets
 * App.jsx know "the session that was just established came from a live,
 * just-verified face scan" so it can auto clock the employee in without
 * making them visit Attendance separately -- without this signal, App.jsx
 * has no way to distinguish a fresh face-verified login from a restored
 * session (page refresh, tab reopen) or a password login, either of which
 * would mean skipping the auto clock-in (no fresh liveness proof).
 *
 * sessionStorage (not localStorage) so it never survives closing the tab,
 * and it's consumed (read once, then cleared) rather than left to expire
 * on its own -- see consumeFlag.
 */
const STORAGE_KEY = 'faceVerifiedLoginAt';
const MAX_AGE_MS = 30000; // generous but bounded -- covers the brief gap between verifyOtp resolving and App.jsx's post-login data load finishing, not indefinite reuse

export function markFaceVerifiedLogin() {
    try {
        sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
        // Storage unavailable (private browsing, quota) -- auto clock-in
        // on login just won't fire; the manual button in Attendance still works.
    }
}

/** Reads and clears the flag in one step so it can only ever trigger once per login. */
export function consumeFaceVerifiedLoginFlag() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        sessionStorage.removeItem(STORAGE_KEY);
        if (!raw) return false;
        return Date.now() - Number(raw) <= MAX_AGE_MS;
    } catch {
        return false;
    }
}
