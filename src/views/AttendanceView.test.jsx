import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { getLocalDateString } from '../utils/dateOnly';

// ============================================================
// MOCK SETUP
// ============================================================
// AttendanceView pulls in ~20 vision modules (real pixel/landmark math,
// each already covered by its own dedicated test file) plus face-api.js,
// getUserMedia, and canvas 2D rendering, none of which jsdom implements.
// These component tests are about AttendanceView's ORCHESTRATION --
// guard-ref timing, Test Mode's write-safety, role-gating -- not the
// underlying detection math, so every vision module is mocked to a
// controllable, deterministic default ("everything passes") that
// individual tests override where needed.

vi.mock('../domain/attendanceClockIn', () => ({
    performClockIn: vi.fn(),
    performClockOut: vi.fn(),
    WORK_START_TIME: '08:00:00',
}));

// disableYolo defaults to true -- skips detectFaceFromImage's YOLO branch
// entirely (see AttendanceView.jsx: `if (!disableYolo && ...)`), so most
// tests only need to mock face-api.js's detectAllFaces/detectSingleFace,
// not @huggingface/transformers/YOLO. The one test that specifically
// exercises the YOLO-hang bug fix flips this to false.
globalThis.__mockDisableYolo = true;
vi.mock('../hooks/useNetworkBatteryAdaptive', () => ({
    useNetworkBatteryAdaptive: () => ({ disableYolo: globalThis.__mockDisableYolo, networkBatteryDiagnostics: {} }),
}));

// Never resolves -- simulates a Hugging Face CDN fetch that hangs rather
// than erroring, the exact failure mode Network Information API-based
// disableYolo can't detect (general connection looks fine; this one host
// specifically is unreachable).
vi.mock('@huggingface/transformers', () => ({
    pipeline: vi.fn(() => new Promise(() => {})),
}));

let mockFaceApiDetections = [];
vi.mock('face-api.js', () => {
    const chain = () => ({
        withFaceLandmarks: () => ({
            withFaceDescriptors: () => Promise.resolve(mockFaceApiDetections),
            withFaceDescriptor: () => Promise.resolve(mockFaceApiDetections[0] || null),
        }),
    });
    return {
        nets: {
            tinyFaceDetector: { loadFromUri: vi.fn().mockResolvedValue() },
            faceLandmark68Net: { loadFromUri: vi.fn().mockResolvedValue() },
            faceRecognitionNet: { loadFromUri: vi.fn().mockResolvedValue() },
        },
        TinyFaceDetectorOptions: vi.fn(),
        detectAllFaces: vi.fn(chain),
        detectSingleFace: vi.fn(chain),
        euclideanDistance: (a, b) => {
            let sum = 0;
            for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
            return Math.sqrt(sum);
        },
    };
});

vi.mock('../vision/faceQuality', () => ({
    checkFraming: vi.fn(() => ({ ok: true, reason: null })),
    checkBrightness: vi.fn(() => ({ ok: true, reason: null })),
    checkOcclusion: vi.fn(() => ({ ok: true, reason: null })),
    checkSingleFace: vi.fn(() => ({ ok: true, reason: null })),
    checkLensObstruction: vi.fn(() => ({ ok: true, reason: null })),
}));

vi.mock('../vision/primaryFaceSelector', () => ({
    selectPrimaryFace: vi.fn((candidates) => ({ primary: candidates[0] || null, isAmbiguous: false })),
}));

vi.mock('../vision/multiTemplateMatcher', () => ({
    normalizeStoredTemplates: vi.fn((v) => (Array.isArray(v[0]) ? v : [v])),
    matchAgainstTemplates: vi.fn(() => ({ distance: 0.1 })),
}));

vi.mock('../vision/matchConfidence', () => ({
    classifyMatch: vi.fn(() => 'confident'),
}));

vi.mock('../vision/antiReplayHeuristic', () => ({
    checkReplaySuspicion: vi.fn(() => ({ suspicious: false })),
}));

vi.mock('../vision/descriptorStaleness', () => ({
    recordMatchDistance: vi.fn(() => ({ shouldSuggestReEnrollment: false })),
    clearStalenessCounter: vi.fn(),
    getAdaptiveThreshold: vi.fn(() => 0.5),
}));

vi.mock('../vision/enrollmentQuality', () => ({
    checkEnrollmentQuality: vi.fn(() => ({ ok: true, reason: null })),
}));

vi.mock('../vision/scanReadiness', () => ({
    calculatePoseReadiness: vi.fn(() => 100),
    calculateFrameReadiness: vi.fn(() => 100),
}));

// 🟩 Real box-motion tracker logic, but with a test-controllable "ready"
// override so individual tests can force hasNaturalMovement/isErratic
// without needing real successive-frame pixel geometry.
let mockBoxMotionStats = { ready: true, hasNaturalMovement: true, isErratic: false };
vi.mock('../vision/boxMotionHeuristic', () => ({
    calculateBoxShiftRatio: vi.fn(() => 0.01),
    createBoxMotionTracker: vi.fn(() => ({
        addSample: vi.fn(),
        getStats: () => mockBoxMotionStats,
        reset: vi.fn(),
    })),
}));

vi.mock('../vision/colorLivenessHeuristic', () => ({
    checkColorLiveness: vi.fn(() => ({ suspicious: false })),
}));

vi.mock('../vision/textureSharpnessHeuristic', () => ({
    checkTextureSharpness: vi.fn(() => ({ suspicious: false })),
}));

vi.mock('../vision/livenessFusion', () => ({
    evaluatePassiveLiveness: vi.fn(() => ({ suspicious: false })),
}));

vi.mock('../vision/pulseDetector', () => ({
    createPulseDetector: vi.fn(() => ({
        getStats: () => ({ ready: false, hasPlausiblePulse: true }),
        reset: vi.fn(),
        addSample: vi.fn(),
    })),
    calculateAverageGreenChannel: vi.fn(() => 128),
}));

vi.mock('../vision/automationDetector', () => ({
    detectAutomation: vi.fn(() => ({ suspicious: false })),
}));

vi.mock('../vision/virtualCameraDetector', () => ({
    checkVirtualCamera: vi.fn(() => Promise.resolve({ suspicious: false })),
}));

vi.mock('../utils/systemSettings', () => ({
    isVirtualCameraCheckEnabled: vi.fn(() => Promise.resolve(true)),
    VIRTUAL_CAMERA_CHECK_KEY: 'virtual_camera_check_enabled',
}));

vi.mock('../vision/inferenceLatencyMonitor', () => ({
    createLatencyMonitor: vi.fn(() => ({
        record: vi.fn(),
        getStats: () => ({ ready: false, isOverBudget: false, avgMs: 0 }),
    })),
}));

vi.mock('../vision/faceOverlayGeometry', () => ({
    calculateFaceOverlayStyle: vi.fn(() => ({})),
}));

vi.mock('../vision/handRegionHeuristic', () => ({
    checkHandInFrame: vi.fn(() => ({ suspicious: false })),
}));

vi.mock('../vision/deviceEdgeHeuristic', () => ({
    checkDeviceEdges: vi.fn(() => ({ suspicious: false })),
}));

// 🟩 Controllable blink-challenge stand-in, exposed on globalThis so both
// this factory (hoisted above all top-level declarations by vi.mock) and
// the test bodies below can read/write the same flag without a
// hoisting/TDZ error.
globalThis.__mockChallengeConfirmed = true;
vi.mock('../vision/livenessDetector', () => {
    function MockRandomLivenessChallenge({ challengeType, steps }) {
        this.challengeType = challengeType;
        this.totalSteps = steps;
        this.stepIndex = 0;
    }
    MockRandomLivenessChallenge.prototype.isExpired = function () { return false; };
    MockRandomLivenessChallenge.prototype.reset = function () { this.stepIndex = 0; };
    MockRandomLivenessChallenge.prototype.registerFrame = function () { return globalThis.__mockChallengeConfirmed; };
    return {
        RandomLivenessChallenge: MockRandomLivenessChallenge,
        CHALLENGE_TYPES: { BLINK: 'blink' },
        CHALLENGE_INSTRUCTION_SUFFIX: { blink: 'Blink' },
        CHALLENGE_DIRECTION_GLYPH: { blink: null },
        calculateHeadTurnRatio: vi.fn(() => 0),
        calculatePitchRatio: vi.fn(() => 0),
        calculateEyeBoxes: vi.fn(() => null),
        isEyeClosed: vi.fn(() => false),
    };
});

vi.mock('../sensors/motionStability', () => ({
    createMotionStabilityTracker: vi.fn(() => ({
        addReading: vi.fn(),
        getStats: () => ({ ready: false, isSuspiciouslyFlat: false }),
        reset: vi.fn(),
    })),
}));

vi.mock('../vision/microMotionTracker', () => ({
    createMicroMotionTracker: vi.fn(() => ({
        addFrame: vi.fn(),
        getStats: () => ({ ready: false, isSuspiciouslyFlat: false }),
        reset: vi.fn(),
    })),
}));

vi.mock('../sensors/ambientLight', () => ({
    createAmbientLightWatcher: vi.fn(() => null),
}));

vi.mock('../utils/torchControl', () => ({
    isTorchSupported: vi.fn(() => false),
    setTorch: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../geo/geofenceStateMachine', () => ({
    createGeofenceStateMachine: vi.fn(() => ({ update: () => ({ state: 'INSIDE' }) })),
}));

vi.mock('../utils/tokenBucket', () => ({
    getBucket: vi.fn(() => ({ tryConsume: () => true })),
}));

vi.mock('../data/repositories/deviceHealthRepository', () => ({
    deviceHealthRepository: { insert: vi.fn(() => Promise.resolve()) },
}));

vi.mock('../supabaseClient', () => ({
    supabase: {
        from: vi.fn(() => ({
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        })),
        rpc: vi.fn(() => Promise.resolve({ data: false, error: null })),
    },
}));

import AttendanceView from './AttendanceView';
import { performClockIn, performClockOut } from '../domain/attendanceClockIn';
import { pipeline as yoloPipeline } from '@huggingface/transformers';

// ============================================================
// DOM/BROWSER ENVIRONMENT STUBS
// ============================================================
const fakeCanvasCtx = {
    filter: 'none',
    drawImage: vi.fn(),
    getImageData: vi.fn((x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)).fill(128), width: w, height: h })),
};

const FACE_DESCRIPTOR = new Array(128).fill(0.1);

const employeeProfile = {
    id: 'emp-1',
    role: 'employee',
    name: 'Test Employee',
    work_mode: 'WFO',
    face_descriptor: JSON.stringify([FACE_DESCRIPTOR]),
    clock_pin_hash: null,
};

const supervisorProfile = {
    id: 'sup-1',
    role: 'supervisor',
    name: 'Test Supervisor',
    work_mode: 'WFO',
    face_descriptor: JSON.stringify([FACE_DESCRIPTOR]),
    clock_pin_hash: null,
};

let getUserMediaMock;

function setupBrowserStubs() {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => fakeCanvasCtx);

    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };
    getUserMediaMock = vi.fn(() => Promise.resolve(fakeStream));
    Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: getUserMediaMock },
        writable: true,
        configurable: true,
    });

    navigator.geolocation = {
        watchPosition: vi.fn((success) => {
            success({ coords: { latitude: -6.2, longitude: 106.8 } });
            return 1;
        }),
        clearWatch: vi.fn(),
    };
}

// Makes the rendered <video> element look "ready" with real dimensions --
// jsdom's HTMLMediaElement never actually decodes video, so these are 0
// by default and detectFaceFromImage's `if (!ready || width === 0 ...)`
// guard would otherwise always bail out.
function markVideoReady(container) {
    const video = container.querySelector('video');
    if (!video) return;
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true });
}

const makeDetection = () => ({
    detection: { score: 0.9, box: { x: 10, y: 10, width: 100, height: 100 } },
    landmarks: { getLeftEye: () => [], getRightEye: () => [] },
    descriptor: FACE_DESCRIPTOR,
});

describe('AttendanceView', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        mockFaceApiDetections = [makeDetection()];
        globalThis.__mockChallengeConfirmed = true;
        mockBoxMotionStats = { ready: true, hasNaturalMovement: true, isErratic: false };
        performClockIn.mockResolvedValue({ success: true, time: '09:00:00', status: 'Present', source: 'face-match' });
        performClockOut.mockResolvedValue({ success: true, time: '17:00:00', source: 'face-match' });
        setupBrowserStubs();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        globalThis.__mockDisableYolo = true;
    });

    // 🟩 Not using RTL's waitFor/findBy* here: both poll via a real
    // setTimeout internally, which never fires while vi.useFakeTimers() is
    // active and nothing is advancing the fake clock during the poll --
    // every await hangs until the 5s test timeout. Since the camera/model
    // mount effects here resolve via microtasks (not timers), a plain
    // `await act(async () => {})` flush is sufficient and doesn't hang.
    const renderAndFlushMount = async (userProfile, props = {}) => {
        let result;
        await act(async () => {
            result = render(
                <AttendanceView
                    userProfile={userProfile}
                    attendance={[]}
                    allUsers={[userProfile]}
                    fetchAttendance={vi.fn()}
                    fetchProfile={vi.fn()}
                    {...props}
                />
            );
        });
        markVideoReady(result.container);
        return result;
    };

    // Advances the fake clock in small, individually act()-wrapped steps
    // instead of one large jump -- a React state update from inside a
    // fake-timer callback (e.g. the guard-ref reset flipping faceStatus,
    // which tears down and recreates the scan interval) needs its own
    // commit to flush before the newly-created interval is "live" for the
    // next timer advancement to find; batching the whole advance into a
    // single vi.advanceTimersByTimeAsync call intermittently missed that
    // recreated interval's first tick.
    const advanceByMs = async (totalMs, stepMs = 200) => {
        let remaining = totalMs;
        while (remaining > 0) {
            const step = Math.min(stepMs, remaining);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(step);
            });
            remaining -= step;
        }
    };

    // Drives the scan loop forward by n ticks (each FACE_SCAN_INTERVAL_MS).
    const advanceScanTicks = async (n = 1) => advanceByMs(n * 1800);

    describe('Part 1(a): clock-in rejected with no scan attempted', () => {
        it('never calls performClockIn while no face has been detected', async () => {
            mockFaceApiDetections = []; // detectAllFaces finds nothing
            await renderAndFlushMount(employeeProfile);
            expect(getUserMediaMock).toHaveBeenCalled();
            await advanceScanTicks(2);
            expect(performClockIn).not.toHaveBeenCalled();
        });
    });

    describe('Part 1(b): clock-in rejected without a confirmed blink or box motion', () => {
        it('does not clock in while the blink challenge is unconfirmed', async () => {
            globalThis.__mockChallengeConfirmed = false;
            await renderAndFlushMount(employeeProfile);
            expect(getUserMediaMock).toHaveBeenCalled();
            await advanceScanTicks(2);
            expect(performClockIn).not.toHaveBeenCalled();
        });

        it('does not clock in while box motion is insufficient, even with a confirmed blink', async () => {
            globalThis.__mockChallengeConfirmed = true;
            mockBoxMotionStats = { ready: true, hasNaturalMovement: false, isErratic: false };
            await renderAndFlushMount(employeeProfile);
            expect(getUserMediaMock).toHaveBeenCalled();
            await advanceScanTicks(2);
            expect(performClockIn).not.toHaveBeenCalled();
        });
    });

    describe('Part 1(c): clock-in succeeds on a valid live match', () => {
        it('calls performClockIn once every gate (match, blink, motion) passes', async () => {
            await renderAndFlushMount(employeeProfile);
            expect(getUserMediaMock).toHaveBeenCalled();
            await advanceScanTicks(1);
            expect(performClockIn).toHaveBeenCalledTimes(1);
            expect(performClockIn).toHaveBeenCalledWith(expect.objectContaining({ source: 'face-match' }));
        });
    });

    describe('Part 1 regression: YOLO (Xenova/yolov8n-face) is never attempted -- confirmed permanently gated on Hugging Face\'s side', () => {
        it('never calls the YOLO pipeline, and still completes a scan via face-api alone', async () => {
            // 🟩 Verified live against the real Hugging Face API: every
            // request to Xenova/yolov8n-face (including this exact model)
            // returns 401 "Invalid username or password", unconditionally --
            // a permanent access restriction, not a flaky network condition.
            // AttendanceView.jsx's YOLO_MODEL_CANDIDATES revolver marks this
            // model knownBroken, which skips the network request entirely
            // (see ensureYoloFaceDetector there) rather than trying-and-
            // timing-out on every fresh session -- which would have also
            // guaranteed an un-suppressible "Failed to load resource: 401"
            // browser console line every time, since Chrome logs failed
            // network responses at the browser layer regardless of how the
            // JS promise is handled. disableYolo=false here specifically to
            // prove the revolver's knownBroken skip -- not the
            // network-adaptive hook -- is what's actually gating it (every
            // other test in this file leaves disableYolo=true).
            globalThis.__mockDisableYolo = false;
            await renderAndFlushMount(employeeProfile);
            expect(getUserMediaMock).toHaveBeenCalled();

            await advanceScanTicks(1);
            expect(performClockIn).toHaveBeenCalledTimes(1);
            expect(yoloPipeline).not.toHaveBeenCalled();
        });
    });

    describe('Part 1 regression: guard-ref reset after a failed clock-in', () => {
        it('allows a second real clock-in attempt after the first one fails', async () => {
            performClockIn.mockResolvedValueOnce({ success: false, reason: 'db-error', error: new Error('boom') });
            performClockIn.mockResolvedValueOnce({ success: true, time: '09:00:00', status: 'Present', source: 'face-match' });

            await renderAndFlushMount(employeeProfile);
            expect(getUserMediaMock).toHaveBeenCalled();

            await advanceScanTicks(1);
            expect(performClockIn).toHaveBeenCalledTimes(1);

            // Before the Part 1 fix, faceStatus stayed stuck at 'matched' and
            // autoClockInGuardRef stayed `true` forever -- no further tick
            // would ever call performClockIn again. After the fix, faceStatus
            // resets to 'scanning' and the scan effect recreates its interval.
            await advanceScanTicks(4);
            expect(performClockIn).toHaveBeenCalledTimes(2);
        });
    });

    describe('Part 2: Test Biometric Scan mode never writes real attendance', () => {
        it('never calls performClockIn/performClockOut when Test Mode fails immediately (no enrolled face)', async () => {
            const profileWithNoFace = { ...employeeProfile, face_descriptor: null };
            await renderAndFlushMount(profileWithNoFace);
            expect(getUserMediaMock).toHaveBeenCalled();

            const startButton = screen.getByText(/Start Test Scan/i);
            await act(async () => { startButton.click(); });

            expect(screen.getByText(/registered face to test against/i)).toBeInTheDocument();
            expect(performClockIn).not.toHaveBeenCalled();
            expect(performClockOut).not.toHaveBeenCalled();
        });

        it('never calls performClockIn/performClockOut on a passing Test Mode run, and reports pass', async () => {
            await renderAndFlushMount(employeeProfile);
            expect(getUserMediaMock).toHaveBeenCalled();

            const startButton = screen.getByText(/Start Test Scan/i);
            await act(async () => { startButton.click(); });
            await act(async () => { await vi.advanceTimersByTimeAsync(1800); });

            expect(screen.getByText(/Pipeline working/i)).toBeInTheDocument();
            expect(performClockIn).not.toHaveBeenCalled();
            expect(performClockOut).not.toHaveBeenCalled();
        });

        it('reports a specific failure reason (no blink) instead of just failing silently', async () => {
            globalThis.__mockChallengeConfirmed = false;
            await renderAndFlushMount(employeeProfile);
            expect(getUserMediaMock).toHaveBeenCalled();

            const startButton = screen.getByText(/Start Test Scan/i);
            await act(async () => { startButton.click(); });

            // Drive past the 20s test-mode timeout -- the scan ticks every
            // 1800ms, so the timeout is actually only observed on whichever
            // tick lands just after the 20000ms mark (the 12th, at 21600ms).
            await advanceByMs(22000);

            expect(screen.getByText(/No blink was detected in time/i)).toBeInTheDocument();
            expect(performClockIn).not.toHaveBeenCalled();
            expect(performClockOut).not.toHaveBeenCalled();
        });

        it('is available to a supervisor too, and still never writes attendance', async () => {
            await renderAndFlushMount(supervisorProfile);
            expect(getUserMediaMock).toHaveBeenCalled();

            const startButton = screen.getByText(/Start Test Scan/i);
            await act(async () => { startButton.click(); });
            await act(async () => { await vi.advanceTimersByTimeAsync(1800); });

            expect(screen.getByText(/Pipeline working/i)).toBeInTheDocument();
            expect(performClockIn).not.toHaveBeenCalled();
            expect(performClockOut).not.toHaveBeenCalled();
        });
    });

    describe('Part 3: supervisors get the real camera/scan pipeline', () => {
        it('requests camera access for a supervisor (previously skipped entirely)', async () => {
            await renderAndFlushMount(supervisorProfile);
            expect(getUserMediaMock).toHaveBeenCalled();
        });

        it('can complete a real clock-in using the same pipeline as an employee', async () => {
            await renderAndFlushMount(supervisorProfile);
            expect(getUserMediaMock).toHaveBeenCalled();
            await advanceScanTicks(1);
            expect(performClockIn).toHaveBeenCalledTimes(1);
            expect(performClockIn).toHaveBeenCalledWith(expect.objectContaining({ source: 'face-match' }));
        });

        it('still renders the existing supervisor monitoring roster alongside the new clock-in panel', async () => {
            await renderAndFlushMount(supervisorProfile, { allUsers: [supervisorProfile, employeeProfile] });
            expect(getUserMediaMock).toHaveBeenCalled();
            // Roster/monitoring content (unique to the supervisor branch) --
            // "Test Employee" legitimately appears twice (the roster table
            // row and the export-filter <select>'s <option>), so this
            // asserts presence, not uniqueness.
            expect(screen.getAllByText(/Test Employee/i).length).toBeGreaterThan(0);
            // Clock-in panel content (previously supervisor-exclusive-hidden).
            expect(screen.getByText(/Start Test Scan/i)).toBeInTheDocument();
        });
    });

    // 🟩 Closes a previously-flagged coverage gap: clock-in (c/h above) had
    // full component-level coverage, clock-out didn't. Clock-out shares the
    // exact same tick-processing code path as clock-in (confirmed by
    // reading the source -- there's no separate/duplicated implementation
    // to test independently), so these tests exist to prove that shared
    // path actually gets exercised correctly when routed to
    // performClockOut instead of performClockIn, not to re-prove the
    // liveness gates themselves (already covered above).
    describe('Clock-out: impossible before a clock-in exists', () => {
        it('does not render a clock-out option when there is no open clock-in for today', async () => {
            await renderAndFlushMount(employeeProfile); // attendance=[] by default -- no todayRecord
            expect(getUserMediaMock).toHaveBeenCalled();
            expect(screen.queryByText('Clock Out Shift')).not.toBeInTheDocument();
        });
    });

    describe('Clock-out: rejected without a confirmed scan, succeeds once armed and verified', () => {
        const openClockInToday = () => ([{
            id: 'row-1',
            employee_id: 'emp-1',
            date: getLocalDateString(),
            clock_in: '08:00:00',
            clock_out: null,
            status: 'Present',
        }]);

        it('does not call performClockOut while the blink challenge is unconfirmed, even after arming clock-out', async () => {
            globalThis.__mockChallengeConfirmed = false;
            const { container } = await renderAndFlushMount(employeeProfile, { attendance: openClockInToday() });
            expect(getUserMediaMock).toHaveBeenCalled();

            await act(async () => { screen.getByText('Clock Out Shift').click(); });
            markVideoReady(container);
            await advanceScanTicks(2);

            expect(performClockOut).not.toHaveBeenCalled();
        });

        it('calls performClockOut once armed and every gate (match, blink, motion) passes', async () => {
            const { container } = await renderAndFlushMount(employeeProfile, { attendance: openClockInToday() });
            expect(getUserMediaMock).toHaveBeenCalled();

            // Not clocking out yet -- the real scan loop shouldn't be
            // running (todayRecord exists, isClockingOut is still false).
            await advanceScanTicks(1);
            expect(performClockOut).not.toHaveBeenCalled();
            expect(performClockIn).not.toHaveBeenCalled();

            await act(async () => { screen.getByText('Clock Out Shift').click(); });
            markVideoReady(container);
            await advanceScanTicks(1);

            expect(performClockOut).toHaveBeenCalledTimes(1);
            expect(performClockIn).not.toHaveBeenCalled();
        });

        // 🟩 REGRESSION TEST: reported live -- clocking in, then later
        // clicking "Clock Out Shift" in that SAME page session, showed no
        // face box, no eye box, and never detected anything at all. Root
        // cause: a successful clock-in sets faceStatus to 'matched' and
        // nothing ever reset it back to 'scanning' afterward -- the main
        // scan-loop effect's own guard (`faceStatus !== 'scanning'` ->
        // return early, never even creating the detection interval)
        // silently blocked clock-out from running a single tick. The tests
        // above start with todayRecord already present via props (no real
        // clock-in ever ran in the render), which is exactly why they
        // never exercised this path -- this one drives a REAL clock-in
        // first, same as Part 1(c), before arming clock-out.
        it('still runs the scan loop for clock-out after a real clock-in earlier in the same session', async () => {
            const { container, rerender } = await renderAndFlushMount(employeeProfile);
            expect(getUserMediaMock).toHaveBeenCalled();

            await advanceScanTicks(1);
            expect(performClockIn).toHaveBeenCalledTimes(1);

            // Simulates the parent's fetchAttendance() picking up the new
            // row and passing it back down as a fresh `attendance` prop --
            // exactly what happens in the real app after a successful
            // clock-in, without re-mounting the component (faceStatus's
            // in-memory 'matched' value carries over, same as production).
            await act(async () => {
                rerender(
                    <AttendanceView
                        userProfile={employeeProfile}
                        attendance={openClockInToday()}
                        allUsers={[employeeProfile]}
                        fetchAttendance={vi.fn()}
                        fetchProfile={vi.fn()}
                    />
                );
            });
            markVideoReady(container);

            await act(async () => { screen.getByText('Clock Out Shift').click(); });
            markVideoReady(container);
            await advanceScanTicks(1);

            expect(performClockOut).toHaveBeenCalledTimes(1);
        });

        // 🟩 REGRESSION TEST: reported live AGAIN after the faceStatus fix
        // above shipped -- clock-out's scan loop was confirmed to be
        // running again, but the screen still showed the clock-in's old
        // "Match verified! Logging attendance..." status text (and no
        // face/eye box), because arming clock-out never reset the other
        // UI-facing state (biometricStatus, challengeGlyph, faceOverlayBox,
        // eyeBoxes) left over from the earlier successful clock-in. This
        // asserts the state right after clicking "Clock Out Shift", BEFORE
        // any new tick runs, so it fails if only faceStatus is reset but
        // the stale status text/boxes are left showing.
        it('clears the stale clock-in status text and face/eye boxes the instant clock-out is armed', async () => {
            const { container, rerender } = await renderAndFlushMount(employeeProfile);
            expect(getUserMediaMock).toHaveBeenCalled();

            await advanceScanTicks(1);
            expect(performClockIn).toHaveBeenCalledTimes(1);
            expect(screen.getByText('Match verified! Logging attendance...')).toBeInTheDocument();

            await act(async () => {
                rerender(
                    <AttendanceView
                        userProfile={employeeProfile}
                        attendance={openClockInToday()}
                        allUsers={[employeeProfile]}
                        fetchAttendance={vi.fn()}
                        fetchProfile={vi.fn()}
                    />
                );
            });
            markVideoReady(container);

            await act(async () => { screen.getByText('Clock Out Shift').click(); });

            expect(screen.getByText('Scanning for frontal matrix...')).toBeInTheDocument();
            expect(screen.queryByText('Match verified! Logging attendance...')).not.toBeInTheDocument();
            expect(screen.queryByText(/blink to confirm/i)).not.toBeInTheDocument();
        });
    });

    describe('Part 3: supervisor clock-out uses the identical gated pipeline', () => {
        it('can complete a real clock-out, gated the same way as an employee', async () => {
            const openClockInToday = [{
                id: 'row-1',
                employee_id: 'sup-1',
                date: getLocalDateString(),
                clock_in: '08:00:00',
                clock_out: null,
                status: 'Present',
            }];
            const { container } = await renderAndFlushMount(supervisorProfile, { attendance: openClockInToday });
            expect(getUserMediaMock).toHaveBeenCalled();

            await act(async () => { screen.getByText('Clock Out Shift').click(); });
            markVideoReady(container);
            await advanceScanTicks(1);

            expect(performClockOut).toHaveBeenCalledTimes(1);
        });
    });

    describe('New submodules (supervisor-only, additive section at the bottom of the page)', () => {
        const employeeA = { id: 'emp-a', role: 'employee', name: 'Budi' };
        const employeeB = { id: 'emp-b', role: 'employee', name: 'Sari' };

        it('the Punctuality Breakdown tab scores every employee from their full attendance history', async () => {
            const attendanceRows = [
                { id: 'r1', employee_id: 'emp-a', date: '2026-08-10', status: 'Present' },
                { id: 'r2', employee_id: 'emp-a', date: '2026-08-11', status: 'Late' },
                { id: 'r3', employee_id: 'emp-b', date: '2026-08-10', status: 'Present' },
            ];
            await renderAndFlushMount(supervisorProfile, {
                allUsers: [supervisorProfile, employeeA, employeeB],
                attendance: attendanceRows,
            });

            // Punctuality Breakdown is the default insights tab -- both
            // names also appear in the (unrelated) roster table above it,
            // so just confirm they're present and the computed score shows.
            expect(screen.getAllByText('Budi').length).toBeGreaterThan(0);
            expect(screen.getAllByText('Sari').length).toBeGreaterThan(0);
            expect(screen.getByText('100%')).toBeInTheDocument();
        });

        it('the Recent Late Records tab lists Late-status rows across the whole team', async () => {
            const attendanceRows = [
                { id: 'r1', employee_id: 'emp-a', date: '2026-08-10', status: 'Present' },
                { id: 'r2', employee_id: 'emp-a', date: '2026-08-11', status: 'Late' },
                { id: 'r3', employee_id: 'emp-b', date: '2026-08-12', status: 'Late' },
            ];
            await renderAndFlushMount(supervisorProfile, {
                allUsers: [supervisorProfile, employeeA, employeeB],
                attendance: attendanceRows,
            });

            await act(async () => { screen.getByText('Recent Late Records').click(); });

            expect(screen.getByText('2026-08-11')).toBeInTheDocument();
            expect(screen.getByText('2026-08-12')).toBeInTheDocument();
            // The one Present-status row must not show up in this list.
            expect(screen.queryByText('2026-08-10')).not.toBeInTheDocument();
        });
    });
});
