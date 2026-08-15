import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

const errors = [
    { id: 1, message: 'TypeError: x is null', user_email: 'a@example.com', created_at: new Date().toISOString() },
    { id: 2, message: 'TypeError: x is null', user_email: 'a@example.com', created_at: new Date().toISOString() },
    { id: 3, message: 'Network error', user_email: 'b@example.com', created_at: new Date().toISOString() },
];

vi.mock('../data/repositories/clientErrorLogsRepository', () => ({
    clientErrorLogsRepository: {
        listRecent: vi.fn(() => Promise.resolve(errors)),
        deleteAll: vi.fn(() => Promise.resolve()),
        delete: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('../realtime/subscribeToTable', () => ({
    subscribeToTable: vi.fn(() => () => {}),
}));

import ErrorMonitorView from './ErrorMonitorView';

const supervisor = { id: 'sup-1', role: 'supervisor' };

describe('ErrorMonitorView', () => {
    it('shows the supervisorOnly message for a non-supervisor', () => {
        render(<ErrorMonitorView userProfile={{ role: 'employee' }} />);
        expect(screen.getByText('This page is only available to supervisors.')).toBeInTheDocument();
    });

    it('renders the Overview tab by default with the flat error feed', async () => {
        await act(async () => { render(<ErrorMonitorView userProfile={supervisor} />); });
        expect(screen.getByText('Total (recent)')).toBeInTheDocument();
        expect(screen.getAllByText('TypeError: x is null').length).toBe(2);
    });

    it('the By Message tab deduplicates recurring errors with an occurrence count', async () => {
        await act(async () => { render(<ErrorMonitorView userProfile={supervisor} />); });
        await act(async () => { screen.getByText('By Message').click(); });

        expect(screen.getAllByText('TypeError: x is null').length).toBe(1);
        expect(screen.getByText('2 occurrences')).toBeInTheDocument();
        expect(screen.getByText('1 occurrence')).toBeInTheDocument();
    });

    it('the By User tab aggregates errors per user', async () => {
        await act(async () => { render(<ErrorMonitorView userProfile={supervisor} />); });
        await act(async () => { screen.getByText('By User').click(); });

        expect(screen.getByText('a@example.com')).toBeInTheDocument();
        expect(screen.getByText('b@example.com')).toBeInTheDocument();
        expect(screen.getByText('2 occurrences')).toBeInTheDocument();
    });
});
