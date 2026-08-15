import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

vi.mock('../supabaseClient', () => ({
    supabase: {
        storage: { from: vi.fn(() => ({ createSignedUrl: vi.fn() })) },
        from: vi.fn(() => ({ update: vi.fn(() => ({ eq: vi.fn() })) })),
    },
}));

vi.mock('../data/repositories/profilesRepository', () => ({
    profilesRepository: { findDuplicateEnrollments: vi.fn(() => Promise.resolve([])) },
}));

import DashboardView from './DashboardView';

const supervisor = { id: 'sup-1', role: 'supervisor', name: 'Boss' };

const allUsers = [
    supervisor,
    { id: 'emp-1', role: 'employee', name: 'Budi' },
    { id: 'emp-2', role: 'employee', name: 'Sari' },
    { id: 'emp-3', role: 'employee', name: 'Rina' },
    { id: 'emp-4', role: 'employee', name: 'Toni' },
    { id: 'emp-5', role: 'employee', name: 'Wati' },
    { id: 'emp-6', role: 'employee', name: 'Dedi' },
];

// 6 employees with tasks, so the widget's top-5 leaderboard excludes Dedi,
// but the Full Leaderboard tab should still include him.
const tasks = allUsers
    .filter((u) => u.role === 'employee')
    .map((u, idx) => ({ id: `t-${u.id}`, assigned_to: [u.id], status: 'Approved', title: `Task ${idx}` }));

describe('DashboardView', () => {
    it('renders the Overview tab by default', async () => {
        await act(async () => { render(<DashboardView userProfile={supervisor} allUsers={allUsers} tasks={tasks} fetchAllUsers={vi.fn()} />); });
        expect(screen.getByText('Welcome, Boss!')).toBeInTheDocument();
    });

    it('the Full Leaderboard tab includes an employee beyond the widget\'s top-5 cutoff', async () => {
        await act(async () => { render(<DashboardView userProfile={supervisor} allUsers={allUsers} tasks={tasks} fetchAllUsers={vi.fn()} />); });
        await act(async () => { screen.getByText('Full Leaderboard').click(); });

        expect(screen.getByText('Everyone, ranked')).toBeInTheDocument();
        expect(screen.getByText('Dedi')).toBeInTheDocument();
    });

    it('the Full Engagement Signal tab renders without crashing', async () => {
        await act(async () => { render(<DashboardView userProfile={supervisor} allUsers={allUsers} tasks={tasks} fetchAllUsers={vi.fn()} />); });
        await act(async () => { screen.getByText('Full Engagement Signal').click(); });

        expect(screen.getByText("Every employee's engagement score")).toBeInTheDocument();
    });
});
