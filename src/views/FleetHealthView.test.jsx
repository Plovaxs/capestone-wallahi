import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

vi.mock('../data/repositories/deviceHealthRepository', () => ({
    deviceHealthRepository: { listRecent: vi.fn(() => Promise.resolve(snapshots)) },
}));

vi.mock('../realtime/subscribeToTable', () => ({
    subscribeToTable: vi.fn(() => () => {}),
}));

import FleetHealthView from './FleetHealthView';

const supervisor = { id: 'sup-1', role: 'supervisor' };
const allUsers = [
    { id: 'emp-1', name: 'Budi', role: 'employee' },
    { id: 'emp-2', name: 'Sari', role: 'employee' },
];

const snapshots = [
    { id: 1, employee_id: 'emp-1', created_at: '2026-08-10T08:00:00Z', avg_latency_ms: 100, model_tier: 'full', is_slow_network: false, lens_clear: true, battery_level: 0.8 },
    { id: 2, employee_id: 'emp-1', created_at: '2026-08-11T08:00:00Z', avg_latency_ms: 900, model_tier: 'reduced', is_slow_network: true, lens_clear: false, battery_level: 0.2 },
    { id: 3, employee_id: 'emp-2', created_at: '2026-08-11T08:00:00Z', avg_latency_ms: 150, model_tier: 'full', is_slow_network: false, lens_clear: true, battery_level: 0.9 },
];

describe('FleetHealthView', () => {
    it('shows the supervisorOnly message for a non-supervisor', () => {
        render(<FleetHealthView userProfile={{ role: 'employee' }} allUsers={allUsers} />);
        expect(screen.getByText('This page is only available to supervisors.')).toBeInTheDocument();
    });

    it('renders the Overview tab by default with fleet-wide stats', async () => {
        await act(async () => { render(<FleetHealthView userProfile={supervisor} allUsers={allUsers} />); });
        expect(screen.getByText('Sessions reported')).toBeInTheDocument();
        expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('the Per-Device Breakdown tab groups sessions by employee and flags issue counts', async () => {
        await act(async () => { render(<FleetHealthView userProfile={supervisor} allUsers={allUsers} />); });
        await act(async () => { screen.getByText('Per-Device Breakdown').click(); });

        expect(screen.getByText('Budi')).toBeInTheDocument();
        expect(screen.getByText('Sari')).toBeInTheDocument();
        // Budi has one flagged session (reduced tier + slow network + lens
        // issue counts as 1 flagged row), Sari has zero -- both pill colors
        // should be present.
        expect(document.querySelector('.bg-amber-50')).not.toBeNull();
        expect(document.querySelector('.bg-emerald-50')).not.toBeNull();
    });

    it('the Issues Only tab shows only the flagged session', async () => {
        await act(async () => { render(<FleetHealthView userProfile={supervisor} allUsers={allUsers} />); });
        await act(async () => { screen.getByText('Issues Only').click(); });

        expect(screen.getByText('Sessions with a flagged issue')).toBeInTheDocument();
        // Only Budi's bad session (id 2) should show up -- Sari never appears here.
        expect(screen.queryByText('Sari')).not.toBeInTheDocument();
    });
});
