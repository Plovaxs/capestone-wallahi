import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

vi.mock('../supabaseClient', () => ({
    supabase: { from: vi.fn(() => ({ insert: vi.fn(), update: vi.fn(() => ({ eq: vi.fn() })) })) },
}));

import LeaveView from './LeaveView';

const supervisor = { id: 'sup-1', role: 'supervisor', name: 'Boss', vacation_days: 10, sick_days: 5 };
const allUsers = [
    supervisor,
    { id: 'emp-1', role: 'employee', name: 'Budi' },
    { id: 'emp-2', role: 'employee', name: 'Sari' },
];

const leaveRequests = [
    { id: 1, employee_id: 'emp-1', type: 'Paid Holiday', status: 'Approved', start_date: '2026-08-10', end_date: '2026-08-11', reason: 'x' },
    { id: 2, employee_id: 'emp-1', type: 'Sick Leave', status: 'Approved', start_date: '2026-08-12', end_date: '2026-08-12', reason: 'y' },
    { id: 3, employee_id: 'emp-2', type: 'Paid Holiday', status: 'Pending', start_date: '2026-08-15', end_date: '2026-08-15', reason: 'z' },
];

describe('LeaveView', () => {
    it('renders the Overview tab by default', async () => {
        await act(async () => { render(<LeaveView userProfile={supervisor} allUsers={allUsers} leaveRequests={leaveRequests} fetchLeaveRequests={vi.fn()} fetchProfile={vi.fn()} />); });
        expect(screen.getByText('My Remaining Allowance')).toBeInTheDocument();
    });

    it('the By Type tab sums approved days per leave type', async () => {
        await act(async () => { render(<LeaveView userProfile={supervisor} allUsers={allUsers} leaveRequests={leaveRequests} fetchLeaveRequests={vi.fn()} fetchProfile={vi.fn()} />); });
        await act(async () => { screen.getByText('By Type').click(); });

        // Paid Holiday: Aug 10-11 = 2 days (approved). Sick Leave: Aug 12 = 1 day.
        expect(screen.getByText('Paid Holiday')).toBeInTheDocument();
        expect(screen.getByText('2 days')).toBeInTheDocument();
        expect(screen.getByText('Sick Leave')).toBeInTheDocument();
        expect(screen.getByText('1 day')).toBeInTheDocument();
    });

    it('the By Employee tab shows approved-day totals per employee for a supervisor', async () => {
        await act(async () => { render(<LeaveView userProfile={supervisor} allUsers={allUsers} leaveRequests={leaveRequests} fetchLeaveRequests={vi.fn()} fetchProfile={vi.fn()} />); });
        await act(async () => { screen.getByText('By Employee').click(); });

        expect(screen.getAllByText('Budi').length).toBeGreaterThan(0);
        expect(screen.getByText('3 days')).toBeInTheDocument();
        // Sari's only request is Pending, not Approved -- excluded from the
        // stats list (she still exists elsewhere, e.g. the export filter
        // dropdown, so check the stats list itself doesn't grow to include her).
        expect(screen.getAllByText('Sari').length).toBe(1);
    });
});
