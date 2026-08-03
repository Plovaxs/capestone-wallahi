import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const profilesRepository = {
    getById: (userId) => runQuery('profiles.getById', () =>
        supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
    ),

    listAll: () => runQuery('profiles.listAll', () =>
        supabase.from('profiles').select('*')
    ),

    update: (id, patch) => runMutation('profiles.update', () =>
        supabase.from('profiles').update(patch).eq('id', id)
    ),
};
