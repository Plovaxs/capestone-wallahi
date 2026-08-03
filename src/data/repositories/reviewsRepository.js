import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const reviewsRepository = {
    listAll: () => runQuery('reviews.listAll', () =>
        supabase.from('performance_evaluations').select('*').order('created_at', { ascending: false })
    ),

    insert: (payload) => runMutation('reviews.insert', () =>
        supabase.from('performance_evaluations').insert(payload)
    ),

    update: (id, patch) => runMutation('reviews.update', () =>
        supabase.from('performance_evaluations').update(patch).eq('id', id)
    ),

    delete: (id) => runMutation('reviews.delete', () =>
        supabase.from('performance_evaluations').delete().eq('id', id)
    ),
};
