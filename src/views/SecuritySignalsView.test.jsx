import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

vi.mock('../domain/impossibleTravelDetector', () => ({
    detectImpossibleTravel: vi.fn(() => [
        { employee_id: 'emp-1', fromDate: '2026-08-10', toDate: '2026-08-11', distanceKm: 5000, hoursElapsed: 1, impliedSpeedKmh: 5000 },
    ]),
}));

vi.mock('../data/repositories/knownDevicesRepository', () => ({
    knownDevicesRepository: {
        listAll: vi.fn(() => Promise.resolve([
            { id: 'd1', user_id: 'emp-1', label: 'iPhone', first_seen_at: new Date().toISOString() },
            { id: 'd2', user_id: 'emp-1', label: 'Old Android', first_seen_at: '2020-01-01T00:00:00Z' },
            { id: 'd3', user_id: 'emp-2', label: 'Laptop', first_seen_at: '2020-01-01T00:00:00Z' },
        ])),
    },
}));

import SecuritySignalsView from './SecuritySignalsView';

const supervisor = { id: 'sup-1', role: 'supervisor' };
const allUsers = [
    { id: 'emp-1', role: 'employee', name: 'Budi' },
    { id: 'emp-2', role: 'employee', name: 'Sari' },
];

describe('SecuritySignalsView', () => {
    it('shows the supervisorOnly message for a non-supervisor', () => {
        render(<SecuritySignalsView userProfile={{ role: 'employee' }} allUsers={allUsers} />);
        expect(screen.getByText('This page is only available to supervisors.')).toBeInTheDocument();
    });

    it('renders the Overview tab by default with the travel flag', async () => {
        await act(async () => { render(<SecuritySignalsView userProfile={supervisor} allUsers={allUsers} attendance={[]} />); });
        expect(screen.getByText('Impossible Travel')).toBeInTheDocument();
        expect(screen.getAllByText('Budi').length).toBeGreaterThan(0);
    });

    it('the All Known Devices tab shows every device, not just the last 24h', async () => {
        await act(async () => { render(<SecuritySignalsView userProfile={supervisor} allUsers={allUsers} attendance={[]} />); });
        await act(async () => { screen.getByText('All Known Devices').click(); });

        expect(screen.getByText('iPhone')).toBeInTheDocument();
        expect(screen.getByText('Old Android')).toBeInTheDocument();
        expect(screen.getByText('Laptop')).toBeInTheDocument();
    });

    it('the By Employee tab consolidates travel flags and device counts per employee', async () => {
        await act(async () => { render(<SecuritySignalsView userProfile={supervisor} allUsers={allUsers} attendance={[]} />); });
        await act(async () => { screen.getByText('By Employee').click(); });

        // Budi has a travel flag AND 2 devices; Sari has only 1 device, so
        // she's filtered out of this "worth a look" list entirely.
        expect(screen.getByText('Budi')).toBeInTheDocument();
        expect(screen.getByText('1 travel flag')).toBeInTheDocument();
        expect(screen.getByText('2 devices')).toBeInTheDocument();
        expect(screen.queryByText('Sari')).not.toBeInTheDocument();
    });
});
