import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

vi.mock('../supabaseClient', () => ({
    supabase: {
        from: vi.fn(() => ({
            select: vi.fn().mockReturnThis(),
            order: vi.fn(() => Promise.resolve({ data: evaluations, error: null })),
            update: vi.fn(() => ({ eq: vi.fn() })),
            insert: vi.fn(),
            delete: vi.fn(() => ({ eq: vi.fn() })),
        })),
    },
}));

vi.mock('../data/repositories/selfAssessmentsRepository', () => ({
    selfAssessmentsRepository: {
        listAll: vi.fn(() => Promise.resolve(selfAssessments)),
        submit: vi.fn(() => Promise.resolve()),
    },
}));

const evaluations = [
    { id: 1, employee_id: 'emp-1', supervisor_id: 'sup-1', final_score: 80, comments: 'good', created_at: '2026-08-11T08:00:00Z', scores: {} },
    { id: 2, employee_id: 'emp-1', supervisor_id: 'sup-1', final_score: 60, comments: 'ok', created_at: '2026-08-01T08:00:00Z', scores: {} },
];

// 26 items * 3 max = 78 raw max. All 1s -> 26/78*100 = 33.3.
const allOnes = Object.fromEntries(['A1','A2','A3','A4','A5','A6','B1','B2','B3','B4','B5','B6','B7','C1','C2','C3','C4','C5','C6','D1','D2','D3','D4','D5'].map((k) => [k, 1]));
const selfAssessments = [
    { id: 's1', employee_id: 'emp-1', scores: allOnes, comments: '', submitted_at: '2026-08-12T08:00:00Z' },
];

import PerformanceReviewView from './PerformanceReviewView';

const supervisor = { id: 'sup-1', role: 'supervisor', name: 'Boss' };
const allUsers = [supervisor, { id: 'emp-1', role: 'employee', name: 'Budi' }];

describe('PerformanceReviewView', () => {
    it('renders the Overview tab by default', async () => {
        await act(async () => { render(<PerformanceReviewView userProfile={supervisor} allUsers={allUsers} />); });
        expect(screen.getByText('Performance Assessment')).toBeInTheDocument();
    });

    it('the Score Trends tab ranks employees by their average historical score', async () => {
        await act(async () => { render(<PerformanceReviewView userProfile={supervisor} allUsers={allUsers} />); });
        await act(async () => { screen.getByText('Score Trends').click(); });

        expect(screen.getByText('Budi')).toBeInTheDocument();
        expect(screen.getByText('2 evaluations')).toBeInTheDocument();
        expect(screen.getByText('avg 70')).toBeInTheDocument();
    });

    it('the Self vs. Supervisor tab compares the latest self-assessment against the latest evaluation', async () => {
        await act(async () => { render(<PerformanceReviewView userProfile={supervisor} allUsers={allUsers} />); });
        await act(async () => { screen.getByText('Self vs. Supervisor').click(); });

        expect(screen.getByText('Budi')).toBeInTheDocument();
        // 24 rated items (all 1) / (26 * 3 max) * 100 = 30.8. Latest eval
        // (newest by created_at) is 80.
        expect(screen.getByText('self 30.8')).toBeInTheDocument();
        expect(screen.getByText('supervisor 80')).toBeInTheDocument();
    });
});
