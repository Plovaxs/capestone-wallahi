import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';
import CorrelationInsightsView from './CorrelationInsightsView';

const supervisor = { id: 'sup-1', role: 'supervisor' };

const allUsers = [
    { id: 'emp-1', role: 'employee', name: 'Budi' },
    { id: 'emp-2', role: 'employee', name: 'Sari' },
];

// 3+ mandatory-weekday attendance rows per employee so PunctualityPolicy
// (behind computeEngagementScores) produces a non-null score.
const attendance = [
    { employee_id: 'emp-1', date: '2026-08-10', status: 'Present' },
    { employee_id: 'emp-1', date: '2026-08-11', status: 'Present' },
    { employee_id: 'emp-1', date: '2026-08-12', status: 'Late' },
    { employee_id: 'emp-2', date: '2026-08-10', status: 'Late' },
    { employee_id: 'emp-2', date: '2026-08-11', status: 'Late' },
    { employee_id: 'emp-2', date: '2026-08-12', status: 'Present' },
];

const tasks = [
    { id: 't1', assigned_to: ['emp-1'], status: 'Approved' },
    { id: 't2', assigned_to: ['emp-1'], status: 'Approved' },
    { id: 't3', assigned_to: ['emp-2'], status: 'Rejected' },
];

const reviews = [
    { employee_id: 'emp-1', overall_score: 90 },
    { employee_id: 'emp-2', overall_score: 60 },
];

describe('CorrelationInsightsView', () => {
    it('shows the supervisorOnly message for a non-supervisor', () => {
        render(<CorrelationInsightsView userProfile={{ role: 'employee' }} />);
        expect(screen.getByText('This page is only available to supervisors.')).toBeInTheDocument();
    });

    it('renders the Overview tab (scatter cards) by default', () => {
        render(<CorrelationInsightsView userProfile={supervisor} allUsers={allUsers} tasks={tasks} attendance={attendance} reviews={reviews} />);
        expect(screen.getByText('Punctuality vs. Task Completion')).toBeInTheDocument();
    });

    it('the Employee Breakdown tab tabulates each employee\'s raw metrics', async () => {
        render(<CorrelationInsightsView userProfile={supervisor} allUsers={allUsers} tasks={tasks} attendance={attendance} reviews={reviews} />);
        await act(async () => { screen.getByText('Employee Breakdown').click(); });

        expect(screen.getByText('Budi')).toBeInTheDocument();
        expect(screen.getByText('Sari')).toBeInTheDocument();
    });

    it('the Outliers tab flags the employee with the largest punctuality/task-completion gap', async () => {
        render(<CorrelationInsightsView userProfile={supervisor} allUsers={allUsers} tasks={tasks} attendance={attendance} reviews={reviews} />);
        await act(async () => { screen.getByText('Outliers').click(); });

        expect(screen.getByText('Punctuality vs. Task Completion gap')).toBeInTheDocument();
        expect(screen.getAllByText(/pt gap/).length).toBeGreaterThan(0);
    });
});
