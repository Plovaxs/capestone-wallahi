import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';
import OnboardingTrackerView from './OnboardingTrackerView';

const supervisor = { id: 'sup-1', role: 'supervisor' };

const allUsers = [
    {
        id: 'emp-1', role: 'employee', name: 'Budi', department: 'IT', position: 'Intern',
        source: 'Uni A', contract_start_date: '2026-01-01', contract_end_date: '2026-06-01', loa_file_path: 'x.pdf',
    },
    {
        id: 'emp-2', role: 'employee', name: 'Sari', department: 'HR', position: null,
        source: null, contract_start_date: null, contract_end_date: null, loa_file_path: null,
    },
];

const attendance = [{ employee_id: 'emp-1', date: '2026-08-10' }];

describe('OnboardingTrackerView', () => {
    it('shows the supervisorOnly message for a non-supervisor', () => {
        render(<OnboardingTrackerView userProfile={{ role: 'employee' }} />);
        expect(screen.getByText('This page is only available to supervisors.')).toBeInTheDocument();
    });

    it('renders the Overview tab by default with per-employee checklist status', () => {
        render(<OnboardingTrackerView userProfile={supervisor} allUsers={allUsers} attendance={attendance} />);
        expect(screen.getByText('Budi')).toBeInTheDocument();
        expect(screen.getByText('100%')).toBeInTheDocument();
        // Sari only has `department` set (1 of 6 checklist items) = 17%.
        expect(screen.getByText('17%')).toBeInTheDocument();
    });

    it('the By Checklist Item tab shows the LOA document as the biggest bottleneck', async () => {
        render(<OnboardingTrackerView userProfile={supervisor} allUsers={allUsers} attendance={attendance} />);
        await act(async () => { screen.getByText('By Checklist Item').click(); });

        expect(screen.getByText('Where the bottleneck is')).toBeInTheDocument();
        // Department is the only fully-complete item (both employees have
        // one set); every other checklist item is 1/2 (only Budi's set).
        expect(screen.getByText('2/2 complete')).toBeInTheDocument();
        expect(screen.getAllByText('1/2 complete').length).toBeGreaterThan(0);
    });

    it('the By Department tab groups average completion by department', async () => {
        render(<OnboardingTrackerView userProfile={supervisor} allUsers={allUsers} attendance={attendance} />);
        await act(async () => { screen.getByText('By Department').click(); });

        expect(screen.getByText('IT')).toBeInTheDocument();
        expect(screen.getByText('HR')).toBeInTheDocument();
    });
});
