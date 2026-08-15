import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '../i18n';
import BadgeScannerView from './BadgeScannerView';

const supervisor = { id: 'sup-1', role: 'supervisor' };
const allUsers = [
    { id: 'emp-1', role: 'employee', name: 'Budi Santoso', position: 'Intern', department: 'IT' },
    { id: 'emp-2', role: 'employee', name: 'Sari Wulandari', position: 'Intern', department: 'HR' },
];

describe('BadgeScannerView', () => {
    it('shows the supervisorOnly message for a non-supervisor', () => {
        render(<BadgeScannerView userProfile={{ role: 'employee' }} allUsers={allUsers} />);
        expect(screen.getByText('This page is only available to supervisors.')).toBeInTheDocument();
    });

    it('renders the Scanner tab by default', () => {
        render(<BadgeScannerView userProfile={supervisor} allUsers={allUsers} />);
        expect(screen.getByText('Start Scanning')).toBeInTheDocument();
    });

    it('the Scan History tab shows an empty state before any scan happens', async () => {
        render(<BadgeScannerView userProfile={supervisor} allUsers={allUsers} />);
        await act(async () => { screen.getByText('Scan History').click(); });
        expect(screen.getByText('No badges scanned yet this session.')).toBeInTheDocument();
    });

    it('the Manual Lookup tab filters allUsers by name as a camera-free fallback', async () => {
        render(<BadgeScannerView userProfile={supervisor} allUsers={allUsers} />);
        await act(async () => { screen.getByText('Manual Lookup').click(); });

        const input = screen.getByPlaceholderText('Type a name...');
        fireEvent.change(input, { target: { value: 'Budi' } });

        expect(screen.getByText('Budi Santoso')).toBeInTheDocument();
        expect(screen.queryByText('Sari Wulandari')).not.toBeInTheDocument();
    });

    it('the Manual Lookup tab shows a no-results state for an unknown name', async () => {
        render(<BadgeScannerView userProfile={supervisor} allUsers={allUsers} />);
        await act(async () => { screen.getByText('Manual Lookup').click(); });

        const input = screen.getByPlaceholderText('Type a name...');
        fireEvent.change(input, { target: { value: 'Zzz' } });

        expect(screen.getByText('No employees match that name.')).toBeInTheDocument();
    });
});
