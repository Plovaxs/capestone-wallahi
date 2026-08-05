import { supabaseUrl, supabaseAnonKey } from '../supabaseClient';
import { recordServerTimeCheckpoint, estimateTrustedNow } from './trustedClock';

/**
 * Every HTTP response carries a `Date` header set by the server, not the
 * client — reading it off a lightweight request to our own Supabase
 * project gives an authoritative clock reading with no new backend
 * endpoint/function required (and no schema change). This exists because
 * clock-in punctuality ("Late" vs "Present") previously trusted the
 * device's own `new Date()`, which is trivially spoofable by changing the
 * system clock before clocking in.
 */
async function fetchServerDate() {
    const res = await fetch(`${supabaseUrl}/rest/v1/`, {
        method: 'HEAD',
        headers: { apikey: supabaseAnonKey },
    });
    const dateHeader = res.headers.get('date');
    if (dateHeader) {
        const parsed = new Date(dateHeader);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return null;
}

/**
 * Falls back to local device time if the request fails (e.g. offline).
 * Fine for the many non-integrity-sensitive callers (clock-out, staleness
 * checks, timestamps) — for anything that decides punctuality, use
 * getTrustedNowOrEstimate() below instead, which has a much better offline
 * fallback than the raw (spoofable) device clock.
 */
export async function getServerNow() {
    try {
        const serverDate = await fetchServerDate();
        if (serverDate) {
            recordServerTimeCheckpoint(serverDate);
            return serverDate;
        }
    } catch {
        // offline or network error — fall through to local time below
    }
    return new Date();
}

/**
 * Same as getServerNow(), but on failure falls back to a monotonic-clock
 * ESTIMATE (see utils/trustedClock.js) instead of the raw device clock.
 * Used for offline clock-in: an intern who genuinely clocked in on time
 * but had no signal shouldn't be marked Late just because sync happened
 * after the cutoff, but the estimate still can't be defeated by someone
 * winding their device clock back before clocking in offline — unlike
 * trusting `new Date()` directly would be.
 *
 * Returns `{ date, source }` where source is 'server' | 'estimated' |
 * 'device_untrusted' (see estimateTrustedNow's doc for what each means).
 */
export async function getTrustedNowOrEstimate() {
    try {
        const serverDate = await fetchServerDate();
        if (serverDate) {
            recordServerTimeCheckpoint(serverDate);
            return { date: serverDate, source: 'server' };
        }
    } catch {
        // offline or network error — fall through to the estimate below
    }
    return estimateTrustedNow();
}
