import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';
import TeamView from './TeamView';
import { getLocalDateString } from '../utils/dateOnly';

const lead = { id: 'lead-1', role: 'employee', is_team_lead: true, department: 'IT' };
const today = getLocalDateString();
// 🟩 Fixed weekday dates (a Monday/Tuesday), not "today"/"yesterday" --
// PunctualityPolicy.calculate only counts mandatory (weekday) rows, so a
// test run landing on a real-world weekend would silently exclude
// "today"/"yesterday" rows and make the punctuality assertions flaky.
const MONDAY = '2026-08-10';
const TUESDAY = '2026-08-11';

const allUsers = [
    lead,
    { id: 'emp-1', role: 'employee', department: 'IT', name: 'Budi', position: 'Intern' },
    { id: 'emp-2', role: 'employee', department: 'IT', name: 'Sari', position: 'Intern' },
];

const todayAttendance = [{ employee_id: 'emp-1', date: today, status: 'Present' }];

// Deterministic weekday-only data -- kept separate from `todayAttendance`
// so this assertion never depends on what real-world weekday the test
// happens to run on.
const punctualityAttendance = [
    { employee_id: 'emp-1', date: MONDAY, status: 'Present' },
    { employee_id: 'emp-1', date: TUESDAY, status: 'Late' },
    { employee_id: 'emp-2', date: MONDAY, status: 'Present' },
];

// A couple of days ago, whatever weekday that happens to be -- the Weekly
// Trend tab doesn't care about weekday-ness (unlike PunctualityPolicy),
// just that a record falls within the trailing-7-days window.
const twoDaysAgo = getLocalDateString(new Date(Date.now() - 2 * 86400000));
const trendAttendance = [
    { employee_id: 'emp-1', date: today, status: 'Present' },
    { employee_id: 'emp-1', date: twoDaysAgo, status: 'Late' },
];

describe('TeamView', () => {
    it('shows the leadOnly message for a non-team-lead', () => {
        render(<TeamView userProfile={{ id: 'x', is_team_lead: false }} allUsers={allUsers} attendance={todayAttendance} />);
        expect(screen.getByText('This page is only available to designated team leads.')).toBeInTheDocument();
    });

    it('renders the Overview tab with today\'s status by default', () => {
        render(<TeamView userProfile={lead} allUsers={allUsers} attendance={todayAttendance} />);
        expect(screen.getByText('Budi')).toBeInTheDocument();
        expect(screen.getByText('Present')).toBeInTheDocument();
        expect(screen.getByText('Not in yet')).toBeInTheDocument();
    });

    it('the Punctuality tab scores each teammate from their full attendance history', async () => {
        render(<TeamView userProfile={lead} allUsers={allUsers} attendance={punctualityAttendance} />);
        await act(async () => { screen.getByText('Punctuality').click(); });

        // Budi: 1 Present + 1 Late = 50%. Sari: 1 Present = 100%.
        expect(screen.getByText('100%')).toBeInTheDocument();
        expect(screen.getByText('50%')).toBeInTheDocument();
    });

    it('the Weekly Trend tab renders a P/L grid per teammate', async () => {
        render(<TeamView userProfile={lead} allUsers={allUsers} attendance={trendAttendance} />);
        await act(async () => { screen.getByText('Weekly Trend').click(); });

        expect(screen.getByText('Last 7 days')).toBeInTheDocument();
        expect(screen.getAllByText('P').length).toBeGreaterThan(0);
        expect(screen.getAllByText('L').length).toBeGreaterThan(0);
    });
});
