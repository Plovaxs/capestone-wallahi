import { supabase } from '../../supabaseClient';
import { runQuery } from './apiClient';

// 🟩 Read-only by design -- audit_log has no client-side insert/update/
// delete policy at all (see migrations/20260810_document_audit_log.sql);
// every row is written server-side via log_audit_event() from a trigger,
// never by the client directly. This repository only ever needs listRecent().
const RECENT_LIMIT = 500;

export const auditLogRepository = {
    listRecent: () => runQuery('auditLog.listRecent', () =>
        supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(RECENT_LIMIT)
    ),
};
