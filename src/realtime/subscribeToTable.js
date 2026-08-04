import { supabase } from '../supabaseClient';

const DEFAULT_DEBOUNCE_MS = 400;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

/**
 * Coalesces a burst of calls into one, firing `fn` only after `delayMs`
 * has passed with no further calls — a bulk-approve action that updates
 * 20 rows individually fires 20 separate postgres_changes events; without
 * this, that's 20 redundant full-table refetches instead of 1.
 */
export function debounce(fn, delayMs) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delayMs);
    };
}

/**
 * Subscribes to INSERT/UPDATE/DELETE on `table` via Supabase Realtime and
 * invokes `onChange` for every event (debounced — see above). Used purely
 * as a "something changed, go refetch" signal rather than hand-merging
 * each replication payload into local state — diff-merging every table's
 * payload shape correctly is a much bigger (and riskier) project on its own.
 *
 * Requires realtime replication to be enabled for `table` in the Supabase
 * project's dashboard settings (Database -> Replication) — a project
 * setting, not a schema change. If it isn't enabled, this subscribes
 * without error but simply never fires, so it's kept as an enhancement
 * layered on top of the existing periodic fetches, never their replacement.
 *
 * 🟩 CONNECTION HEALTH: Supabase's WebSocket can drop (network blip, laptop
 * sleep/wake, mobile switching networks) and previously just went silent —
 * the app kept "listening" to a dead channel with no indication anything
 * was wrong. This now watches the channel's status and re-subscribes with
 * exponential backoff on CHANNEL_ERROR/TIMED_OUT, and reports status
 * transitions via `onHealthChange` for anything that wants to surface it
 * (e.g. a "reconnecting..." indicator).
 */
export function subscribeToTable(table, onChange, { debounceMs = DEFAULT_DEBOUNCE_MS, onHealthChange } = {}) {
    const debouncedOnChange = debounceMs > 0 ? debounce(onChange, debounceMs) : onChange;

    let channel = null;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let stopped = false;

    const scheduleReconnect = () => {
        if (reconnectTimer || stopped) return;
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (channel) supabase.removeChannel(channel);
            if (!stopped) connect();
        }, delay);
    };

    const connect = () => {
        // A unique channel name per (re)connect avoids colliding with a
        // still-tearing-down previous instance of the same subscription.
        channel = supabase
            .channel(`realtime:${table}:${Date.now()}`)
            .on('postgres_changes', { event: '*', schema: 'public', table }, debouncedOnChange)
            .subscribe((status) => {
                onHealthChange?.(status);
                if (status === 'SUBSCRIBED') {
                    reconnectAttempt = 0; // healthy again — reset backoff
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    scheduleReconnect();
                }
            });
    };

    connect();

    return () => {
        stopped = true;
        clearTimeout(reconnectTimer);
        if (channel) supabase.removeChannel(channel);
    };
}
