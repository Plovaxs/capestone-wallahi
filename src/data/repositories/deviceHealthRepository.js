import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

const RECENT_LIMIT = 500;

export const deviceHealthRepository = {
    // Employee names are resolved client-side via the already-fetched
    // allUsers list (same pattern as AuditLogView) rather than a
    // PostgREST embed, keeping this consistent with the rest of the app's
    // supervisor-facing views.
    listRecent: () => runQuery('deviceHealth.listRecent', () =>
        supabase.from('device_health_snapshots').select('*').order('created_at', { ascending: false }).limit(RECENT_LIMIT)
    ),

    insert: (payload) => runMutation('deviceHealth.insert', () =>
        supabase.from('device_health_snapshots').insert(payload)
    ),
};
