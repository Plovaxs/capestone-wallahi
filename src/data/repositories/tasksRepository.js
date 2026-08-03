import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const tasksRepository = {
    listAll: () => runQuery('tasks.listAll', () =>
        supabase.from('tasks').select('*').order('created_at', { ascending: false })
    ),

    insert: (payload) => runMutation('tasks.insert', () =>
        supabase.from('tasks').insert(payload)
    ),

    update: (id, patch) => runMutation('tasks.update', () =>
        supabase.from('tasks').update(patch).eq('id', id)
    ),

    delete: (id) => runMutation('tasks.delete', () =>
        supabase.from('tasks').delete().eq('id', id)
    ),
};
