import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const attendanceRepository = {
    listAll: () => runQuery('attendance.listAll', () =>
        supabase.from('attendance').select('*').order('date', { ascending: false })
    ),

    insert: (payload) => runMutation('attendance.insert', () =>
        supabase.from('attendance').insert(payload)
    ),

    update: (id, patch) => runMutation('attendance.update', () =>
        supabase.from('attendance').update(patch).eq('id', id)
    ),
};
