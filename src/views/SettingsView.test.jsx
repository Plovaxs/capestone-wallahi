import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

vi.mock('../supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(() => Promise.resolve({
                data: { session: { user: { email: 'boss@example.com', app_metadata: { provider: 'email' } }, expires_at: Math.floor(Date.now() / 1000) + 3600 } },
            })),
            mfa: { listFactors: vi.fn(() => Promise.resolve({ data: { totp: [] }, error: null })) },
            signOut: vi.fn(() => Promise.resolve({ error: null })),
        },
        storage: { from: vi.fn(() => ({ upload: vi.fn(), getPublicUrl: vi.fn(() => ({ data: { publicUrl: '' } })) })) },
    },
}));

vi.mock('../data/repositories/knownDevicesRepository', () => ({
    knownDevicesRepository: { listForUser: vi.fn(() => Promise.resolve([])), revoke: vi.fn() },
}));

vi.mock('../data/repositories/auditLogRepository', () => ({
    auditLogRepository: { listForUser: vi.fn(() => Promise.resolve([
        { id: 1, action: 'status_change', entity_type: 'task', created_at: '2026-08-10T08:00:00Z', details: {} },
    ])) },
}));

import SettingsView from './SettingsView';

const supervisor = {
    id: 'sup-1', role: 'supervisor', name: 'Boss', email: 'boss@example.com',
    department: 'IT', position: 'Manager', vacation_days: 10, sick_days: 5,
};

describe('SettingsView', () => {
    it('renders the Overview tab by default', async () => {
        await act(async () => { render(<SettingsView userProfile={supervisor} fetchProfile={vi.fn()} allUsers={[supervisor]} fetchAllUsers={vi.fn()} />); });
        expect(screen.getByText('Account Settings')).toBeInTheDocument();
    });

    it('the Session Info tab shows the current session details', async () => {
        await act(async () => { render(<SettingsView userProfile={supervisor} fetchProfile={vi.fn()} allUsers={[supervisor]} fetchAllUsers={vi.fn()} />); });
        await act(async () => { screen.getByText('Session Info').click(); });

        expect(screen.getByText('boss@example.com')).toBeInTheDocument();
    });

    it('the Export My Data tab triggers a JSON download', async () => {
        await act(async () => { render(<SettingsView userProfile={supervisor} fetchProfile={vi.fn()} allUsers={[supervisor]} fetchAllUsers={vi.fn()} />); });
        await act(async () => { screen.getByText('Export My Data').click(); });

        const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
        const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        await act(async () => { screen.getByText('Download JSON').click(); });

        expect(createObjectURLSpy).toHaveBeenCalled();
        expect(revokeObjectURLSpy).toHaveBeenCalled();
        createObjectURLSpy.mockRestore();
        revokeObjectURLSpy.mockRestore();
    });
});
