import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

vi.mock('../supabaseClient', () => ({
    supabase: { from: vi.fn(() => ({ insert: vi.fn(), update: vi.fn(() => ({ eq: vi.fn() })) })) },
}));

import TasksView from './TasksView';

const supervisor = { id: 'sup-1', role: 'supervisor', name: 'Boss' };
const allUsers = [
    supervisor,
    { id: 'emp-1', role: 'employee', name: 'Budi' },
    { id: 'emp-2', role: 'employee', name: 'Sari' },
];

const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

const tasks = [
    { id: 't1', title: 'Overdue High', priority: 'High', status: 'Pending', due_date: yesterday, assigned_to: ['emp-1'] },
    { id: 't2', title: 'On Track', priority: 'Low', status: 'Pending', due_date: nextWeek, assigned_to: ['emp-1', 'emp-2'] },
];

describe('TasksView', () => {
    it('renders the Overview tab (board) by default', async () => {
        await act(async () => { render(<TasksView userProfile={supervisor} allUsers={allUsers} tasks={tasks} taskSubmissions={[]} fetchTasks={vi.fn()} fetchTaskSubmissions={vi.fn()} />); });
        expect(screen.getByText('Task Management')).toBeInTheDocument();
    });

    it('the Escalations tab flags the overdue high-priority task as critical', async () => {
        await act(async () => { render(<TasksView userProfile={supervisor} allUsers={allUsers} tasks={tasks} taskSubmissions={[]} fetchTasks={vi.fn()} fetchTaskSubmissions={vi.fn()} />); });
        await act(async () => { screen.getByText('Escalations').click(); });

        expect(screen.getByText('Overdue High')).toBeInTheDocument();
        expect(screen.getByText('critical')).toBeInTheDocument();
        expect(screen.queryByText('On Track')).not.toBeInTheDocument();
    });

    it('the By Assignee tab shows task counts per person', async () => {
        await act(async () => { render(<TasksView userProfile={supervisor} allUsers={allUsers} tasks={tasks} taskSubmissions={[]} fetchTasks={vi.fn()} fetchTaskSubmissions={vi.fn()} />); });
        await act(async () => { screen.getByText('By Assignee').click(); });

        expect(screen.getAllByText('Budi').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Sari').length).toBeGreaterThan(0);
    });
});
