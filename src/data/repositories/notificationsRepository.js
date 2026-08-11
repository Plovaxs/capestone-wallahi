import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const notificationsRepository = {
    // 🟩 SECURITY: label includes userId -- see profilesRepository.getById's
    // comment for why (runQuery's in-flight dedup would otherwise hand one
    // user's notifications to a different user on a shared-device login switch).
    listForUser: (userId) => runQuery(`notifications.listForUser:${userId}`, () =>
        supabase.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false })
    ),

    markAllRead: (userId) => runMutation('notifications.markAllRead', () =>
        supabase.from('notifications').update({ read: true }).eq('user_id', userId)
    ),
};
