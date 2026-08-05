/**
 * In-memory checkpoint anchoring "the last time we know, for certain, what
 * the server's clock said" against `performance.now()` — a MONOTONIC timer
 * that (unlike `Date.now()`/`new Date()`) cannot be rewound by a user
 * changing their device's system clock. This is what lets an offline
 * clock-in still be attributed a trustworthy timestamp once the app is
 * back online, without falling back to blindly trusting the device clock
 * (which would reopen exactly the spoofing hole getServerNow() exists to
 * close — see utils/serverTime.js).
 *
 * Deliberately in-memory only (not persisted to localStorage/IndexedDB) —
 * performance.now() resets to 0 on every page load, so a checkpoint saved
 * from a previous session could never be correlated to the current
 * session's performance.now() readings anyway.
 */
let checkpoint = null; // { serverTimeMs, perfNowMs }

/** Called whenever a real server timestamp is successfully obtained. */
export function recordServerTimeCheckpoint(serverDate) {
    checkpoint = { serverTimeMs: serverDate.getTime(), perfNowMs: performance.now() };
}

export function hasServerTimeCheckpoint() {
    return checkpoint !== null;
}

/**
 * Best-effort "what time is it right now", without a network round trip.
 * Returns `{ date, source }`:
 *  - source: 'estimated' — derived from the last known server time plus
 *    monotonic elapsed time since. Not spoofable by changing the device
 *    clock (performance.now() ignores wall-clock/system-time changes).
 *  - source: 'device_untrusted' — no checkpoint exists yet this session
 *    (the app never successfully reached the server since it loaded), so
 *    this falls back to the device clock, which IS spoofable. Callers
 *    doing anything integrity-sensitive (punctuality) should record/surface
 *    this source rather than silently treating it as equally trustworthy.
 */
export function estimateTrustedNow() {
    if (checkpoint) {
        const elapsedMs = performance.now() - checkpoint.perfNowMs;
        return { date: new Date(checkpoint.serverTimeMs + elapsedMs), source: 'estimated' };
    }
    return { date: new Date(), source: 'device_untrusted' };
}

/** Test-only: clears the module-level checkpoint between test cases. */
export function _resetCheckpointForTests() {
    checkpoint = null;
}
