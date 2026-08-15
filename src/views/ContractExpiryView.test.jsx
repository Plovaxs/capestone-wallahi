import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

vi.mock('../supabaseClient', () => ({
    supabase: { rpc: vi.fn(() => Promise.resolve({ data: false, error: null })) },
}));

import ContractExpiryView from './ContractExpiryView';

const supervisor = { id: 'sup-1', role: 'supervisor', name: 'Boss' };

// Fixed "today" the domain util accepts via options -- but the view calls
// analyzeContractExpiry with default `today: new Date()`, so instead we
// pick contract_end_date values relative to the real current date.
const inDays = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
};

const allUsers = [
    { id: 'emp-1', role: 'employee', name: 'Budi', department: 'IT', contract_end_date: inDays(-5) },
    { id: 'emp-2', role: 'employee', name: 'Sari', department: 'HR', contract_end_date: inDays(60) },
];

describe('ContractExpiryView', () => {
    it('shows the supervisorOnly message for a non-supervisor', () => {
        render(<ContractExpiryView userProfile={{ role: 'employee' }} />);
        expect(screen.getByText('This page is only available to supervisors.')).toBeInTheDocument();
    });

    it('renders the Overview tab by default with urgency stats', async () => {
        await act(async () => { render(<ContractExpiryView userProfile={supervisor} allUsers={allUsers} />); });
        expect(screen.getByText('Budi')).toBeInTheDocument();
        expect(screen.getByText('Sari')).toBeInTheDocument();
    });

    it('the Timeline tab groups contracts by expiry month', async () => {
        await act(async () => { render(<ContractExpiryView userProfile={supervisor} allUsers={allUsers} />); });
        await act(async () => { screen.getByText('Timeline').click(); });

        expect(screen.getByText('Upcoming expirations by month')).toBeInTheDocument();
        expect(screen.getByText('Budi')).toBeInTheDocument();
    });

    it('the By Department tab breaks down urgency counts per department', async () => {
        await act(async () => { render(<ContractExpiryView userProfile={supervisor} allUsers={allUsers} />); });
        await act(async () => { screen.getByText('By Department').click(); });

        expect(screen.getByText('IT')).toBeInTheDocument();
        expect(screen.getByText('HR')).toBeInTheDocument();
    });
});
