import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const helpdeskRepository = {
    listTickets: () => runQuery('helpdesk.listTickets', () =>
        supabase.from('helpdesk_tickets').select('*').order('created_at', { ascending: false })
    ),

    listReplies: () => runQuery('helpdesk.listReplies', () =>
        supabase.from('helpdesk_replies').select('id, ticket_id, author_id, message, created_at').order('created_at', { ascending: true })
    ),

    insertTicket: (payload) => runMutation('helpdesk.insertTicket', () =>
        supabase.from('helpdesk_tickets').insert(payload)
    ),

    updateTicket: (id, patch) => runMutation('helpdesk.updateTicket', () =>
        supabase.from('helpdesk_tickets').update(patch).eq('id', id)
    ),

    insertReply: (payload) => runMutation('helpdesk.insertReply', () =>
        supabase.from('helpdesk_replies').insert(payload)
    ),
};
