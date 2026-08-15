import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

vi.mock('../supabaseClient', () => ({
    supabase: {
        from: vi.fn(() => ({ insert: vi.fn(), update: vi.fn(() => ({ eq: vi.fn() })), delete: vi.fn(() => ({ eq: vi.fn() })) })),
        channel: vi.fn(() => ({
            on: vi.fn().mockReturnThis(),
            subscribe: vi.fn().mockReturnThis(),
            send: vi.fn(),
        })),
        removeChannel: vi.fn(),
    },
}));

import ContributionsView from './ContributionsView';

const supervisor = { id: 'sup-1', role: 'supervisor', name: 'Boss' };
const allUsers = [
    supervisor,
    { id: 'emp-1', role: 'employee', name: 'Budi' },
    { id: 'emp-2', role: 'employee', name: 'Sari' },
];

const contributions = [
    {
        id: 1, employee_id: 'emp-1', date: '2026-08-10', title: 'Q', contribution: 'x',
        category: 'General Discussion', replies: [{ id: 'r1', author_id: 'sup-1', message: 'reply', timestamp: '10:00' }],
    },
    {
        id: 2, employee_id: 'emp-1', date: '2026-08-11', title: 'Q2', contribution: 'y',
        category: 'Project Milestone 🎉', replies: [],
    },
];

describe('ContributionsView', () => {
    it('renders the Overview tab by default with the composer and threads', () => {
        render(<ContributionsView userProfile={supervisor} contributions={contributions} allUsers={allUsers} fetchContributions={vi.fn()} />);
        expect(screen.getByText('Publish Thread')).toBeInTheDocument();
        expect(screen.getAllByText('Budi').length).toBeGreaterThan(0);
    });

    it('the Top Contributors tab ranks users by threads + replies', async () => {
        render(<ContributionsView userProfile={supervisor} contributions={contributions} allUsers={allUsers} fetchContributions={vi.fn()} />);
        await act(async () => { screen.getByText('Top Contributors').click(); });

        expect(screen.getByText('2 threads')).toBeInTheDocument();
        expect(screen.getByText('1 reply')).toBeInTheDocument();
    });

    it('the By Category tab counts threads per forum category', async () => {
        render(<ContributionsView userProfile={supervisor} contributions={contributions} allUsers={allUsers} fetchContributions={vi.fn()} />);
        await act(async () => { screen.getByText('By Category').click(); });

        expect(screen.getAllByText('General Discussion').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Project Milestone 🎉').length).toBeGreaterThan(0);
    });
});
