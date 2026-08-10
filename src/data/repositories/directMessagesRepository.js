import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const directMessagesRepository = {
    // RLS scopes this to rows where the current user is sender or
    // recipient -- no need to filter client-side.
    listForCurrentUser: () => runQuery('directMessages.listForCurrentUser', () =>
        supabase.from('direct_messages').select('*').order('created_at', { ascending: true })
    ),

    send: (senderId, recipientId, body) => runMutation('directMessages.send', () =>
        supabase.from('direct_messages').insert({ sender_id: senderId, recipient_id: recipientId, body })
    ),

    markRead: (messageIds) => runMutation('directMessages.markRead', () =>
        supabase.from('direct_messages').update({ read_at: new Date().toISOString() }).in('id', messageIds)
    ),
};
