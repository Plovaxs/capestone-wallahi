import { supabase } from '../supabaseClient';

/**
 * Subscribes to INSERT/UPDATE/DELETE on `table` via Supabase Realtime and
 * invokes `onChange` for every event. Used purely as a "something changed,
 * go refetch" signal rather than hand-merging each replication payload
 * into local state — diff-merging every table's payload shape correctly
 * is a much bigger (and riskier) project on its own.
 *
 * Requires realtime replication to be enabled for `table` in the Supabase
 * project's dashboard settings (Database -> Replication) — a project
 * setting, not a schema change. If it isn't enabled, this subscribes
 * without error but simply never fires, so it's kept as an enhancement
 * layered on top of the existing periodic fetches, never their replacement.
 */
export function subscribeToTable(table, onChange) {
    const channel = supabase
        .channel(`realtime:${table}`)
        .on('postgres_changes', { event: '*', schema: 'public', table }, onChange)
        .subscribe();

    return () => supabase.removeChannel(channel);
}
