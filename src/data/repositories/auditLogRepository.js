import { supabase } from '../../supabaseClient';
import { runQuery } from './apiClient';

// 🟩 Read-only by design -- audit_log has no client-side insert/update/
// delete policy at all (see migrations/20260810_document_audit_log.sql);
// every row is written server-side via log_audit_event() from a trigger,
// never by the client directly. This repository only ever needs listRecent().
const RECENT_LIMIT = 500;

const OWN_ACTIVITY_LIMIT = 25;

export const auditLogRepository = {
    listRecent: () => runQuery('auditLog.listRecent', () =>
        supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(RECENT_LIMIT)
    ),

    // Settings > Security "Recent Activity" -- actions attributed to this
    // user as actor (e.g. their own profile edits), not events that
    // happened TO them. Relies on the audit_log_select_own_or_supervisor
    // RLS policy added in migrations/20260812_add_audit_log_own_activity.sql.
    listForUser: (userId) => runQuery(`auditLog.listForUser:${userId}`, () =>
        supabase.from('audit_log').select('*').eq('actor_id', userId).order('created_at', { ascending: false }).limit(OWN_ACTIVITY_LIMIT)
    ),
};
