import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

const entries = [
    { id: 1, entity_type: 'profile', action: 'role_change', actor_id: 'sup-1', created_at: new Date().toISOString(), details: { name: 'Budi', from: 'employee', to: 'employee' } },
    { id: 2, entity_type: 'task', action: 'status_change', actor_id: 'sup-1', created_at: new Date().toISOString(), details: { title: 'Report', from: 'Pending', to: 'Approved' } },
    { id: 3, entity_type: 'leave_request', action: 'status_change', actor_id: 'sup-2', created_at: new Date().toISOString(), details: { type: 'Sick', from: 'Pending', to: 'Approved' } },
];

vi.mock('../data/repositories/auditLogRepository', () => ({
    auditLogRepository: { listRecent: vi.fn(() => Promise.resolve(entries)) },
}));

vi.mock('../realtime/subscribeToTable', () => ({
    subscribeToTable: vi.fn(() => () => {}),
}));

import AuditLogView from './AuditLogView';

const supervisor = { id: 'sup-1', role: 'supervisor' };
const allUsers = [
    { id: 'sup-1', role: 'supervisor', name: 'Boss One' },
    { id: 'sup-2', role: 'supervisor', name: 'Boss Two' },
];

describe('AuditLogView', () => {
    it('shows the supervisorOnly message for a non-supervisor', () => {
        render(<AuditLogView userProfile={{ role: 'employee' }} allUsers={allUsers} />);
        expect(screen.getByText('This page is only available to supervisors.')).toBeInTheDocument();
    });

    it('renders the Overview tab by default with the full feed', async () => {
        await act(async () => { render(<AuditLogView userProfile={supervisor} allUsers={allUsers} />); });
        expect(screen.getByText('Total (recent)')).toBeInTheDocument();
        expect(screen.getAllByText('3').length).toBeGreaterThan(0);
    });

    it('the By Actor tab aggregates entries per actor', async () => {
        await act(async () => { render(<AuditLogView userProfile={supervisor} allUsers={allUsers} />); });
        await act(async () => { screen.getByText('By Actor').click(); });

        expect(screen.getByText('Boss One')).toBeInTheDocument();
        expect(screen.getByText('2 entries')).toBeInTheDocument();
        expect(screen.getByText('Boss Two')).toBeInTheDocument();
        expect(screen.getByText('1 entry')).toBeInTheDocument();
    });

    it('the By Entity Type tab aggregates entries per entity type', async () => {
        await act(async () => { render(<AuditLogView userProfile={supervisor} allUsers={allUsers} />); });
        await act(async () => { screen.getByText('By Entity Type').click(); });

        expect(screen.getByText('Roles')).toBeInTheDocument();
        expect(screen.getByText('Tasks')).toBeInTheDocument();
        expect(screen.getByText('Leave Requests')).toBeInTheDocument();
    });
});
