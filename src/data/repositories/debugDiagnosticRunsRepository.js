import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

const HISTORY_LIMIT = 20;

export const debugDiagnosticRunsRepository = {
    // Persists a Connectivity-tab run so Debug Center's History tab can
    // show a trend instead of just "right now" -- also the insert that
    // the trg_alert_on_critical_diagnostic_failure trigger watches (see
    // migrations/20260812_add_debug_diagnostic_runs.sql).
    insert: (supervisorId, results) => runMutation('debugDiagnosticRuns.insert', () =>
        supabase.from('debug_diagnostic_runs').insert({ supervisor_id: supervisorId, results })
    ),

    listRecent: () => runQuery('debugDiagnosticRuns.listRecent', () =>
        supabase.from('debug_diagnostic_runs').select('*').order('created_at', { ascending: false }).limit(HISTORY_LIMIT)
    ),
};
