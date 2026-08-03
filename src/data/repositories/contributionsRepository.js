import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const contributionsRepository = {
    listPosts: () => runQuery('contributions.listPosts', () =>
        supabase.from('contributions').select('*').order('date', { ascending: false })
    ),

    listReplies: () => runQuery('contributions.listReplies', () =>
        supabase.from('contribution_replies').select('id, post_id, author_id, message, created_at').order('created_at', { ascending: true })
    ),

    insertPost: (payload) => runMutation('contributions.insertPost', () =>
        supabase.from('contributions').insert(payload)
    ),

    updatePost: (id, patch) => runMutation('contributions.updatePost', () =>
        supabase.from('contributions').update(patch).eq('id', id)
    ),

    deletePost: (id) => runMutation('contributions.deletePost', () =>
        supabase.from('contributions').delete().eq('id', id)
    ),

    insertReply: (payload) => runMutation('contributions.insertReply', () =>
        supabase.from('contribution_replies').insert(payload)
    ),
};
