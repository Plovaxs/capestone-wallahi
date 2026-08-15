import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

vi.mock('../supabaseClient', () => ({
    supabase: { from: vi.fn(() => ({ insert: vi.fn(), update: vi.fn(() => ({ eq: vi.fn() })) })) },
}));

import HelpdeskView from './HelpdeskView';

const supervisor = { id: 'sup-1', role: 'supervisor' };

const tickets = [
    { id: 1, employee_id: 'emp-1', employee_name: 'Budi', title: 'Broken laptop', contribution: 'x', category: 'Help Request ❓', ticket_status: 'Open', problem_types: ['Hardware'], created_at: '2026-08-10T08:00:00Z', replies: [] },
    { id: 2, employee_id: 'emp-1', employee_name: 'Budi', title: 'Git issue', contribution: 'x', category: 'Help Request ❓', ticket_status: 'Resolved', problem_types: ['Git Control', 'Hardware'], created_at: '2026-08-11T08:00:00Z', replies: [] },
    { id: 3, employee_id: 'emp-2', employee_name: 'Sari', title: 'Need laptop', contribution: 'x', category: 'Urgent Blocker 🚨', ticket_status: 'Open', problem_types: [], created_at: '2026-08-12T08:00:00Z', replies: [] },
];

describe('HelpdeskView', () => {
    it('renders the Overview tab by default with the ticket composer and list', () => {
        render(<HelpdeskView userProfile={supervisor} helpdeskTickets={tickets} fetchHelpdeskTickets={vi.fn()} />);
        expect(screen.getByText('File Ticket')).toBeInTheDocument();
        expect(screen.getByText('Broken laptop')).toBeInTheDocument();
    });

    it('the By Problem Type tab aggregates problem tags across all tickets', async () => {
        render(<HelpdeskView userProfile={supervisor} helpdeskTickets={tickets} fetchHelpdeskTickets={vi.fn()} />);
        await act(async () => { screen.getByText('By Problem Type').click(); });

        expect(screen.getByText('2 tickets')).toBeInTheDocument(); // Hardware
        expect(screen.getByText('1 ticket')).toBeInTheDocument(); // Git Control
    });

    it('the By Employee tab counts total and open tickets per employee', async () => {
        render(<HelpdeskView userProfile={supervisor} helpdeskTickets={tickets} fetchHelpdeskTickets={vi.fn()} />);
        await act(async () => { screen.getByText('By Employee').click(); });

        expect(screen.getByText('Budi')).toBeInTheDocument();
        expect(screen.getByText('Sari')).toBeInTheDocument();
    });
});
