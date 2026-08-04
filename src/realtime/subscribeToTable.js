import { supabase } from '../supabaseClient';

const DEFAULT_DEBOUNCE_MS = 400;

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
 */
export function subscribeToTable(table, onChange, { debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
    const debouncedOnChange = debounceMs > 0 ? debounce(onChange, debounceMs) : onChange;

    const channel = supabase
        .channel(`realtime:${table}`)
        .on('postgres_changes', { event: '*', schema: 'public', table }, debouncedOnChange)
        .subscribe();

    return () => supabase.removeChannel(channel);
}
