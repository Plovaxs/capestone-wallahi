import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const taskSubmissionsRepository = {
    listAll: () => runQuery('taskSubmissions.listAll', () =>
        supabase.from('task_submissions').select('*').order('submitted_at', { ascending: true })
    ),

    // Upsert on (task_id, employee_id) -- a re-submission (after a targeted
    // revision cleared the old row, or just replacing a file before the
    // task completes) always resolves to one row per assignee, never a
    // duplicate.
    submit: (payload) => runMutation('taskSubmissions.submit', () =>
        supabase.from('task_submissions').upsert(payload, { onConflict: 'task_id,employee_id' })
    ),
};
