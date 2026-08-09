import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

// 🟩 Capped read: this table is diagnostic/debugging data, not something a
// supervisor needs the entire history of on every page load -- the most
// recent few hundred is plenty to spot a pattern, and keeps the query fast
// even after months of accumulated (rare, hopefully) client errors.
const RECENT_LIMIT = 500;

export const clientErrorLogsRepository = {
    listRecent: () => runQuery('clientErrorLogs.listRecent', () =>
        supabase.from('client_error_logs').select('*').order('created_at', { ascending: false }).limit(RECENT_LIMIT)
    ),

    insert: (payload) => runMutation('clientErrorLogs.insert', () =>
        supabase.from('client_error_logs').insert(payload)
    ),

    delete: (id) => runMutation('clientErrorLogs.delete', () =>
        supabase.from('client_error_logs').delete().eq('id', id)
    ),

    deleteAll: () => runMutation('clientErrorLogs.deleteAll', () =>
        // RLS already scopes this to rows a supervisor can see/delete;
        // `.gte` on a not-null column is Postgres/PostgREST's documented way
        // to express "delete every row" without a bare unscoped .delete(),
        // which the client rejects for safety.
        supabase.from('client_error_logs').delete().gte('created_at', '1970-01-01')
    ),
};
