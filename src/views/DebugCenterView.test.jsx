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

// 🟩 Open-eye landmark points (6 per eye, EAR comfortably above the closed
// threshold) shared by every camera-tab test below -- real coordinates
// don't matter, only that calculateEAR/isEyeClosed read them as "open".
const OPEN_EYE_POINTS = [
    { x: 0, y: 0 }, { x: 2, y: -2 }, { x: 4, y: -2 },
    { x: 6, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 2 },
];
const mockLandmarks = { getLeftEye: () => OPEN_EYE_POINTS, getRightEye: () => OPEN_EYE_POINTS };
const mockDetection = { detection: { score: 0.9, box: { x: 10, y: 10, width: 100, height: 100 } }, landmarks: mockLandmarks };

// 🟩 face-api.js's real detectSingleFace(...).withFaceLandmarks() returns a
// chainable, awaitable "task" object -- both a thenable AND exposes a
// further .withFaceDescriptor() step. Mirrored here so both call sites in
// DebugCenterView.jsx (the one-shot pipeline step, which stops at
// withFaceLandmarks, and the live overlay loop, which chains
// withFaceDescriptor too) work against the same mock.
function makeLandmarksTask(detection) {
    const task = Promise.resolve(detection);
    task.withFaceDescriptor = () => Promise.resolve(
        detection ? { ...detection, descriptor: new Float32Array(128).fill(0.1) } : null
    );
    return task;
}

vi.mock('face-api.js', () => ({
    nets: {
        tinyFaceDetector: { loadFromUri: vi.fn().mockResolvedValue() },
        faceLandmark68Net: { loadFromUri: vi.fn().mockResolvedValue() },
        faceRecognitionNet: { loadFromUri: vi.fn().mockResolvedValue() },
    },
    TinyFaceDetectorOptions: vi.fn(),
    detectSingleFace: vi.fn(() => ({
        withFaceLandmarks: () => makeLandmarksTask(globalThis.__mockFaceDetection ?? null),
    })),
}));

const identifyFaceByDescriptorMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock('../data/repositories/profilesRepository', () => ({
    profilesRepository: { identifyFaceByDescriptor: (...args) => identifyFaceByDescriptorMock(...args) },
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

    it('the connectivity tab shows a Hugging Face reachability failure', async () => {
        render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
        await act(async () => { screen.getByText('Run Checks').click(); });
        expect(screen.getByText('Hugging Face API (general reachability)')).toBeInTheDocument();
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

    describe('Camera & Face Recognition Pipeline', () => {
        beforeEach(() => {
            globalThis.__mockFaceDetection = mockDetection;
            // 🟩 jsdom never actually plays media, so a real <video>'s
            // readyState stays 0 (HAVE_NOTHING) forever -- without this
            // stub, runPipelineTest's "wait for the video to be ready" loop
            // would poll on a REAL 150ms setTimeout up to its 4s deadline,
            // which act()'s microtask-only flush never waits out.
            Object.defineProperty(window.HTMLMediaElement.prototype, 'readyState', {
                configurable: true,
                get: () => 4,
            });
        });

        afterEach(() => {
            delete globalThis.__mockFaceDetection;
            delete window.HTMLMediaElement.prototype.readyState;
        });

        it('auto-starts the live face/eye overlay after a successful run instead of stopping the camera', async () => {
            render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
            await act(async () => { screen.getByText('Camera & Face').click(); });
            await act(async () => { screen.getByText('Run Test').click(); });

            // 🟩 Regression guard for the "camera dies right after the test
            // finishes" bug: reaching the live-scanning state (and its Stop
            // button) proves the stream was never torn down at the end of
            // runPipelineTest.
            expect(screen.getByText('Stop Live Preview')).toBeInTheDocument();
            expect(screen.getByText('🔍 LIVE FACE')).toBeInTheDocument();
            expect(screen.getByText('Blinks detected: 0')).toBeInTheDocument();
        });

        it('identifies the live-detected face against enrolled profiles and shows name + role', async () => {
            identifyFaceByDescriptorMock.mockResolvedValueOnce([
                { profile_id: 'emp-1', profile_name: 'Budi Santoso', profile_role: 'employee', distance: 0.21, threshold: 0.5 },
            ]);

            render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
            await act(async () => { screen.getByText('Camera & Face').click(); });
            await act(async () => { screen.getByText('Run Test').click(); });

            expect(identifyFaceByDescriptorMock).toHaveBeenCalledWith(expect.any(Array), 0.5);
            expect(screen.getByText(/Identified as Budi Santoso \(Employee\)/)).toBeInTheDocument();
        });

        // 🟩 REGRESSION TEST: the RPC used to hard-filter out any match
        // above the threshold, so a live capture that landed just barely
        // above 0.5 (plausible given this panel's lighting/angle differs
        // from a real login attempt) came back completely empty --
        // reported live by a supervisor whose face matches fine at actual
        // login but got "no match" here. It now always returns the closest
        // match with its real distance, and the UI labels it a "closest
        // guess" instead of silently saying nothing was found.
        it('shows a "closest guess" (not a confident match) when the nearest profile is above the match threshold', async () => {
            identifyFaceByDescriptorMock.mockResolvedValueOnce([
                { profile_id: 'sup-1', profile_name: 'Test Supervisor', profile_role: 'supervisor', distance: 0.63, threshold: 0.5 },
            ]);

            render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
            await act(async () => { screen.getByText('Camera & Face').click(); });
            await act(async () => { screen.getByText('Run Test').click(); });

            expect(screen.getByText(/Closest guess: Test Supervisor \(Supervisor\)/)).toBeInTheDocument();
        });

        it('shows "nobody enrolled" only when the system has no enrolled faces at all', async () => {
            identifyFaceByDescriptorMock.mockResolvedValueOnce([]);

            render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
            await act(async () => { screen.getByText('Camera & Face').click(); });
            await act(async () => { screen.getByText('Run Test').click(); });

            expect(screen.getByText('Nobody in the system has an enrolled face yet.')).toBeInTheDocument();
        });

        it('stopping the live preview clears the overlay and blink counter', async () => {
            render(<DebugCenterView setActiveView={vi.fn()} userProfile={testSupervisor} />);
            await act(async () => { screen.getByText('Camera & Face').click(); });
            await act(async () => { screen.getByText('Run Test').click(); });
            expect(screen.getByText('Stop Live Preview')).toBeInTheDocument();

            await act(async () => { screen.getByText('Stop Live Preview').click(); });
            expect(screen.queryByText('🔍 LIVE FACE')).not.toBeInTheDocument();
            expect(screen.getByText('Start Live Preview')).toBeInTheDocument();
        });
    });
});
