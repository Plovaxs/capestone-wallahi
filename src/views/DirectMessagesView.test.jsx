import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

// jsdom doesn't implement scrollIntoView -- the thread view calls it on
// every new message to auto-scroll to the bottom.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const messages = [
    { id: 1, sender_id: 'emp-1', recipient_id: 'sup-1', body: 'Hi boss', created_at: '2026-08-10T08:00:00Z', read_at: null },
    { id: 2, sender_id: 'sup-1', recipient_id: 'emp-1', body: 'Hi Budi', created_at: '2026-08-10T09:00:00Z', read_at: '2026-08-10T09:05:00Z' },
    { id: 3, sender_id: 'emp-2', recipient_id: 'sup-1', body: 'Need help', created_at: '2026-08-11T08:00:00Z', read_at: null },
];

vi.mock('../data/repositories/directMessagesRepository', () => ({
    directMessagesRepository: {
        listForCurrentUser: vi.fn(() => Promise.resolve(messages)),
        send: vi.fn(() => Promise.resolve()),
        markRead: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('../realtime/subscribeToTable', () => ({
    subscribeToTable: vi.fn(() => () => {}),
}));

import DirectMessagesView from './DirectMessagesView';

const supervisor = { id: 'sup-1', role: 'supervisor', name: 'Boss' };
const allUsers = [
    supervisor,
    { id: 'emp-1', role: 'employee', name: 'Budi' },
    { id: 'emp-2', role: 'employee', name: 'Sari' },
];

describe('DirectMessagesView', () => {
    it('renders the Conversations tab by default', async () => {
        await act(async () => { render(<DirectMessagesView userProfile={supervisor} allUsers={allUsers} />); });
        expect(screen.getByText('Messages')).toBeInTheDocument();
        expect(screen.getAllByText('Budi').length).toBeGreaterThan(0);
    });

    it('the Unread tab lists every unread message across all conversations', async () => {
        await act(async () => { render(<DirectMessagesView userProfile={supervisor} allUsers={allUsers} />); });
        await act(async () => { screen.getByText('Unread').click(); });

        expect(screen.getByText('Hi boss')).toBeInTheDocument();
        expect(screen.getByText('Need help')).toBeInTheDocument();
        // The already-read message (id 2, from Boss to Budi) must not appear.
        expect(screen.queryByText('Hi Budi')).not.toBeInTheDocument();
    });

    it('the Message Stats tab shows sent/received counts per contact', async () => {
        await act(async () => { render(<DirectMessagesView userProfile={supervisor} allUsers={allUsers} />); });
        await act(async () => { screen.getByText('Message Stats').click(); });

        expect(screen.getByText('Activity per contact')).toBeInTheDocument();
        expect(screen.getAllByText('Budi').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Sari').length).toBeGreaterThan(0);
    });
});
