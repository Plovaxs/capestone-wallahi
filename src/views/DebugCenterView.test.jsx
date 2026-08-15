import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('../utils/connectivityChecks', () => ({
    runAllConnectivityChecks: vi.fn(() => Promise.resolve([
        { label: 'supabase', ok: true, latencyMs: 50, error: null },
        { label: 'supabase-realtime', ok: true, latencyMs: 60, error: null },
        { label: 'huggingface-cdn', ok: false, latencyMs: 6000, error: 'timeout' },
        { label: 'face-api-models', ok: true, latencyMs: 20, error: null },
    ])),
    checkHuggingFaceCdnReachable: vi.fn(() => Promise.resolve({ label: 'huggingface-cdn', ok: true, latencyMs: 40, error: null })),
}));

vi.mock('../data/repositories/clientErrorLogsRepository', () => ({
    clientErrorLogsRepository: { listRecent: vi.fn(() => Promise.resolve([])) },
}));

vi.mock('../offline/indexedDbCache', () => ({
    idbGet: vi.fn(() => Promise.resolve([])),
}));

const diagnosticRunsInsertMock = vi.fn(() => Promise.resolve());
const diagnosticRunsListRecentMock = vi.fn(() => Promise.resolve([]));
vi.mock('../data/repositories/debugDiagnosticRunsRepository', () => ({
    debugDiagnosticRunsRepository: {
        insert: (...args) => diagnosticRunsInsertMock(...args),
        listRecent: (...args) => diagnosticRunsListRecentMock(...args),
    },
}));

// 🟩 vi.mock(...) factories are hoisted above all top-level statements --
// vi.hoisted() is vitest's official escape hatch for mock fns that need to
// be both configured inside a factory AND asserted-on later in the test
// body (a bare `const x = vi.fn()` above the vi.mock call hits a
// ReferenceError/TDZ instead, since the mock call runs first).
const { mfaGetLevelMock, getSessionMock, getUserMock, channelSubscribeMock } = vi.hoisted(() => {
    const channelSubscribeMock = vi.fn((cb) => { cb('SUBSCRIBED'); return { subscribe: channelSubscribeMock }; });
    return {
        mfaGetLevelMock: vi.fn(() => Promise.resolve({ data: { currentLevel: 'aal1' }, error: null })),
        getSessionMock: vi.fn(() => Promise.resolve({
            data: { session: { user: { email: 'supervisor@example.com' }, expires_at: Math.floor(Date.now() / 1000) + 3600 } },
            error: null,
        })),
        getUserMock: vi.fn(() => Promise.resolve({ data: { user: { id: 'sup-1' } } })),
        channelSubscribeMock,
    };
});

vi.mock('../supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: getSessionMock,
            getUser: getUserMock,
            mfa: { getAuthenticatorAssuranceLevel: mfaGetLevelMock },
        },
        from: vi.fn(() => ({
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'sup-1' }, error: null }) }) }),
        })),
        channel: vi.fn(() => ({ subscribe: channelSubscribeMock })),
        removeChannel: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('face-api.js', () => ({
    nets: {
        tinyFaceDetector: { loadFromUri: vi.fn().mockResolvedValue() },
        faceLandmark68Net: { loadFromUri: vi.fn().mockResolvedValue() },
        faceRecognitionNet: { loadFromUri: vi.fn().mockResolvedValue() },
    },
    TinyFaceDetectorOptions: vi.fn(),
    detectSingleFace: vi.fn(() => ({ withFaceLandmarks: () => Promise.resolve(null) })),
}));

import DebugCenterView from './DebugCenterView';

const testSupervisor = { id: 'sup-1', role: 'supervisor', name: 'Test Supervisor' };

describe('DebugCenterView', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.defineProperty(navigator, 'mediaDevices', {
            value: { getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] })) },
            writable: true,
            configurable: true,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the Connectivity tab by default', () => {
        render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
        expect(screen.getByText('System Connectivity')).toBeInTheDocument();
    });

    it('switches to the Storage & Offline tab and runs its checks', async () => {
        render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
        await act(async () => { screen.getByText('Storage & Offline').click(); });
        expect(screen.getByText('Storage & Offline', { selector: 'h3' })).toBeInTheDocument();

        await act(async () => { screen.getByText('Run Checks').click(); });
        expect(screen.getByText('localStorage read/write')).toBeInTheDocument();
        expect(screen.getByText('Offline mutation queue')).toBeInTheDocument();
    });

    it('switches to the Session & Auth tab and runs its checks', async () => {
        render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
        await act(async () => { screen.getByText('Session & Auth').click(); });
        await act(async () => { screen.getByText('Run Checks').click(); });
        expect(getSessionMock).toHaveBeenCalled();
        expect(mfaGetLevelMock).toHaveBeenCalled();
        expect(screen.getByText(/su\*+@example\.com/)).toBeInTheDocument();
    });

    it('switches to the Realtime tab and opens a test channel', async () => {
        render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
        await act(async () => { screen.getByText('Realtime').click(); });
        await act(async () => { screen.getByText('Run Checks').click(); });
        expect(channelSubscribeMock).toHaveBeenCalled();
        expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    it('the export report button is disabled until at least one check has run', async () => {
        render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
        expect(screen.getByText('Export Diagnostic Report')).toBeDisabled();

        await act(async () => { screen.getByText('Run Checks').click(); });
        expect(screen.getByText('Export Diagnostic Report')).not.toBeDisabled();
    });

    it('the connectivity tab shows the reported YOLO/Hugging Face reachability failure', async () => {
        render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
        await act(async () => { screen.getByText('Run Checks').click(); });
        expect(screen.getByText('Hugging Face CDN (YOLO face model)')).toBeInTheDocument();
        expect(screen.getByText('Unreachable')).toBeInTheDocument();
    });

    it('clicking "View Full Log" on the Errors tab navigates to errorMonitor', async () => {
        const setActiveView = vi.fn();
        render(<DebugCenterView setActiveView={setActiveView} userProfile={testSupervisor} />);
        await act(async () => { screen.getByText('Errors').click(); });
        await act(async () => { screen.getByText('View Full Log').click(); });
        expect(setActiveView).toHaveBeenCalledWith('errorMonitor');
    });

    it('persists every Connectivity run for the History tab / critical-failure alert trigger', async () => {
        render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
        await act(async () => { screen.getByText('Run Checks').click(); });
        expect(diagnosticRunsInsertMock).toHaveBeenCalledWith(
            'sup-1',
            expect.arrayContaining([expect.objectContaining({ label: 'huggingface-cdn', ok: false })])
        );
    });

    it('the History tab shows a pass/fail trend across past runs', async () => {
        diagnosticRunsListRecentMock.mockResolvedValueOnce([
            {
                id: 1,
                created_at: '2026-08-12T10:00:00Z',
                results: [
                    { label: 'supabase', ok: true },
                    { label: 'supabase-realtime', ok: true },
                    { label: 'huggingface-cdn', ok: false },
                    { label: 'face-api-models', ok: true },
                ],
            },
            {
                id: 2,
                created_at: '2026-08-12T09:00:00Z',
                results: [
                    { label: 'supabase', ok: true },
                    { label: 'supabase-realtime', ok: true },
                    { label: 'huggingface-cdn', ok: false },
                    { label: 'face-api-models', ok: true },
                ],
            },
        ]);

        render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
        await act(async () => { screen.getByText('History').click(); });
        await act(async () => { screen.getByText('Refresh').click(); });

        expect(screen.getByText('2/2 failed')).toBeInTheDocument();
    });

    it('the History tab shows an empty state when no runs have happened yet', async () => {
        render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
        await act(async () => { screen.getByText('History').click(); });
        await act(async () => { screen.getByText('Refresh').click(); });
        expect(screen.getByText('No diagnostic runs yet')).toBeInTheDocument();
    });
});
