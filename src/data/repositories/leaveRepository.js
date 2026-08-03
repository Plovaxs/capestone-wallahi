import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const leaveRepository = {
    listAll: () => runQuery('leave.listAll', () =>
        supabase.from('leave_requests').select('*').order('start_date', { ascending: false })
    ),

    insert: (payload) => runMutation('leave.insert', () =>
        supabase.from('leave_requests').insert(payload)
    ),

    update: (id, patch) => runMutation('leave.update', () =>
        supabase.from('leave_requests').update(patch).eq('id', id)
    ),
};
