import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

const insertMock = vi.fn(() => Promise.resolve({ error: null }));
vi.mock('../supabaseClient', () => ({
    supabase: { from: vi.fn(() => ({ insert: (...args) => insertMock(...args) })) },
}));

vi.mock('../utils/rateLimit', () => ({
    checkRateLimit: vi.fn(() => Promise.resolve({ allowed: true })),
    formatRateLimitMessage: vi.fn(() => 'rate limited'),
}));

const connectivityMock = vi.fn(() => Promise.resolve([{ label: 'supabase', ok: true, latencyMs: 10, error: null }]));
vi.mock('../utils/connectivityChecks', () => ({
    runAllConnectivityChecks: (...args) => connectivityMock(...args),
}));

import ReportBugButton from './ReportBugButton';

const userProfile = { id: 'emp-1', role: 'employee', name: 'Test Employee' };

describe('ReportBugButton', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        insertMock.mockResolvedValue({ error: null });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders nothing when there is no logged-in user', () => {
        const { container } = render(<ReportBugButton userProfile={null} activeView="dashboard" />);
        expect(container).toBeEmptyDOMElement();
    });

    it('opens the report modal on click and submits a ticket with the description and a diagnostic snapshot attached', async () => {
        render(<ReportBugButton userProfile={userProfile} activeView="attendance" />);

        await act(async () => { screen.getByLabelText('Report a Problem').click(); });
        expect(screen.getByText('What happened?')).toBeInTheDocument();

        const textarea = screen.getByPlaceholderText(/My face isn't being detected/);
        fireEvent.change(textarea, { target: { value: 'The clock-in button does nothing when I click it' } });

        await act(async () => { screen.getByText('Send Report').click(); });

        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
            employee_id: 'emp-1',
            category: 'Help Request ❓',
            problem_types: ['Software'],
        }));
        const insertedPayload = insertMock.mock.calls[0][0];
        expect(insertedPayload.contribution).toContain('The clock-in button does nothing');
        expect(insertedPayload.contribution).toContain('"page": "attendance"');
        // Connectivity opted out by default -- shouldn't have run.
        expect(connectivityMock).not.toHaveBeenCalled();
    });

    it('runs a live connectivity check and attaches it when the user opts in', async () => {
        render(<ReportBugButton userProfile={userProfile} activeView="dashboard" />);
        await act(async () => { screen.getByLabelText('Report a Problem').click(); });

        const textarea = screen.getByPlaceholderText(/My face isn't being detected/);
        fireEvent.change(textarea, { target: { value: 'Something is broken' } });
        await act(async () => { screen.getByLabelText(/Also test my connection/).click(); });
        await act(async () => { screen.getByText('Send Report').click(); });

        expect(connectivityMock).toHaveBeenCalled();
        const insertedPayload = insertMock.mock.calls[0][0];
        expect(insertedPayload.contribution).toContain('"connectivity"');
    });

    it('does not submit an empty report', async () => {
        render(<ReportBugButton userProfile={userProfile} activeView="dashboard" />);
        await act(async () => { screen.getByLabelText('Report a Problem').click(); });
        expect(screen.getByText('Send Report')).toBeDisabled();
        expect(insertMock).not.toHaveBeenCalled();
    });
});
