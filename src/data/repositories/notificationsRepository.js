import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const notificationsRepository = {
    listForUser: (userId) => runQuery('notifications.listForUser', () =>
        supabase.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false })
    ),

    markAllRead: (userId) => runMutation('notifications.markAllRead', () =>
        supabase.from('notifications').update({ read: true }).eq('user_id', userId)
    ),
};
