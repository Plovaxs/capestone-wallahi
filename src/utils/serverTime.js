import { supabaseUrl, supabaseAnonKey } from '../supabaseClient';

/**
 * Every HTTP response carries a `Date` header set by the server, not the
 * client — reading it off a lightweight request to our own Supabase
 * project gives an authoritative clock reading with no new backend
 * endpoint/function required (and no schema change). This exists because
 * clock-in punctuality ("Late" vs "Present") previously trusted the
 * device's own `new Date()`, which is trivially spoofable by changing the
 * system clock before clocking in.
 *
 * Falls back to local device time if the request fails (e.g. offline) —
 * at that point the offline mutation queue already governs when the
 * clock-in actually reaches the server, so a spoofed local clock only
 * affects the record while genuinely offline, not the common case.
 */
export async function getServerNow() {
    try {
        const res = await fetch(`${supabaseUrl}/rest/v1/`, {
            method: 'HEAD',
            headers: { apikey: supabaseAnonKey },
        });
        const dateHeader = res.headers.get('date');
        if (dateHeader) {
            const parsed = new Date(dateHeader);
            if (!Number.isNaN(parsed.getTime())) return parsed;
        }
    } catch {
        // offline or network error — fall through to local time below
    }
    return new Date();
}
