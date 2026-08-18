import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { supabase } from '../supabaseClient';
import ExportButton from '../components/ExportButton';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';
import ModuleTabBar from '../components/ModuleTabBar';
import EdgeDiagnosticsPanel from '../components/EdgeDiagnosticsPanel';
import { generateTablePdf } from '../utils/generateTablePdf';
import SortableTh from '../components/SortableTh';
import { PunctualityPolicy } from '../domain/PunctualityPolicy';
import { showUserError } from '../utils/errorHandling';
import { performClockIn, performClockOut } from '../domain/attendanceClockIn';
import { isWeekend } from '../domain/attendanceDayPolicy';
import { checkRateLimit, formatRateLimitMessage } from '../utils/rateLimit';
import { deviceHealthRepository } from '../data/repositories/deviceHealthRepository';
import { calculateHeadTurnRatio, calculatePitchRatio, RandomLivenessChallenge, CHALLENGE_TYPES, CHALLENGE_INSTRUCTION_SUFFIX, CHALLENGE_DIRECTION_GLYPH, calculateEyeBoxes, isEyeClosed } from '../vision/livenessDetector';
import { checkHandInFrame, checkHandNearFrameEdges } from '../vision/handRegionHeuristic';
import { checkScreenGlare } from '../vision/screenGlareHeuristic';
import { checkDeviceEdges } from '../vision/deviceEdgeHeuristic';
import { getLocalDateString } from '../utils/dateOnly';
import { checkFraming, checkBrightness, checkOcclusion, checkSingleFace, checkLensObstruction } from '../vision/faceQuality';
import { selectPrimaryFace } from '../vision/primaryFaceSelector';
import { normalizeStoredTemplates, matchAgainstTemplates } from '../vision/multiTemplateMatcher';
import { classifyMatch } from '../vision/matchConfidence';
import { checkReplaySuspicion } from '../vision/antiReplayHeuristic';
import { recordMatchDistance, clearStalenessCounter, getAdaptiveThreshold } from '../vision/descriptorStaleness';
import { checkEnrollmentQuality } from '../vision/enrollmentQuality';
import { calculatePoseReadiness, calculateFrameReadiness } from '../vision/scanReadiness';
import ScanReadinessBar from '../components/ScanReadinessBar';
import { saveEnrollmentProgress, loadEnrollmentProgress, clearEnrollmentProgress } from '../vision/enrollmentProgress';
import { isTorchSupported, setTorch } from '../utils/torchControl';
import { createGeofenceStateMachine } from '../geo/geofenceStateMachine';
import { calculateDistanceMeters, OFFICE_LOCATION, ALLOWED_RADIUS_METERS } from '../geo/officeGeofence';
import { createMotionStabilityTracker } from '../sensors/motionStability';
import { createMicroMotionTracker } from '../vision/microMotionTracker';
import { calculateBoxShiftRatio, createBoxMotionTracker } from '../vision/boxMotionHeuristic';
import { checkColorLiveness } from '../vision/colorLivenessHeuristic';
import { checkTextureSharpness } from '../vision/textureSharpnessHeuristic';
import { evaluatePassiveLiveness } from '../vision/livenessFusion';
import { createPulseDetector, calculateAverageGreenChannel } from '../vision/pulseDetector';
import { detectAutomation } from '../vision/automationDetector';
import { checkVirtualCamera } from '../vision/virtualCameraDetector';
import { isVirtualCameraCheckEnabled } from '../utils/systemSettings';
import { createLatencyMonitor } from '../vision/inferenceLatencyMonitor';
import { calculateFaceOverlayStyle } from '../vision/faceOverlayGeometry';
import { createAmbientLightWatcher } from '../sensors/ambientLight';
import { useNetworkBatteryAdaptive } from '../hooks/useNetworkBatteryAdaptive';
import { usePageVisibility } from '../hooks/usePageVisibility';
import { getBucket } from '../utils/tokenBucket';
import Modal from '../components/Modal';
import { withTimeout } from '../data/pipeline/withTimeout';

// 🟩 LAZY-LOADED HEAVY VISION LIBS: face-api.js and @huggingface/transformers
// are multi-MB and were previously static imports, so simply navigating to
// this page downloaded both up front even before the user ever opens the
// camera. Dynamic import() defers the fetch to the moment this view
// actually needs them (inside loadModels/ensureYoloFaceDetector below), and
// the module-level promise cache means a remount (or the other page that
// also lazy-loads face-api.js, see LoginPage.jsx) reuses the same
// in-flight/resolved fetch instead of re-requesting it.
// 🟩 Clears its own cache on failure (flaky network, CDN hiccup) instead of
// caching the rejection forever -- without this, the "Retry" button added
// alongside this lazy-loading change would just immediately re-throw the
// same failed promise on every attempt instead of actually retrying.
let faceApiModulePromise = null;
const loadFaceApiModule = () => {
    if (!faceApiModulePromise) {
        faceApiModulePromise = import('face-api.js').catch((err) => {
            faceApiModulePromise = null;
            throw err;
        });
    }
    return faceApiModulePromise;
};

let transformersModulePromise = null;
const loadTransformersModule = () => {
    if (!transformersModulePromise) {
        transformersModulePromise = import('@huggingface/transformers').catch((err) => {
            transformersModulePromise = null;
            throw err;
        });
    }
    return transformersModulePromise;
};

const QUALITY_HINT_KEYS = {
    'no-face': 'attendance.statusScanning',
    'multiple-faces': 'attendance.statusMultipleFaces',
    'too-far': 'attendance.statusTooFar',
    'too-close': 'attendance.statusTooClose',
    'off-center': 'attendance.statusOffCenter',
    'too-dark': 'attendance.statusTooDark',
    'too-bright': 'attendance.statusTooBright',
    'low-confidence': 'attendance.statusLowConfidence',
    'lens-obstructed': 'attendance.statusLensObstructed',
};

const ENROLL_QUALITY_HINT_KEYS = {
    'too-dark': 'attendance.enrollQualityTooDark',
    'too-bright': 'attendance.enrollQualityTooBright',
    'too-blurry': 'attendance.enrollQualityTooBlurry',
};

const CAMERA_ERROR_I18N_KEYS = {
    denied: { title: 'attendance.cameraErrorDeniedTitle', body: 'attendance.cameraErrorDeniedBody' },
    'not-found': { title: 'attendance.cameraErrorNotFoundTitle', body: 'attendance.cameraErrorNotFoundBody' },
    busy: { title: 'attendance.cameraErrorBusyTitle', body: 'attendance.cameraErrorBusyBody' },
    unsupported: { title: 'attendance.cameraErrorUnsupportedTitle', body: 'attendance.cameraErrorUnsupportedBody' },
    unknown: { title: 'attendance.cameraErrorUnknownTitle', body: 'attendance.cameraErrorUnknownBody' },
};

// 🟩 REVOLVER: ordered list of candidate YOLO face-detection models. On any
// failure for the currently-selected candidate -- model-load error, missing
// required files, unsupported architecture, or an inference timeout -- the
// scan loop advances to the next entry for the very next tick, no page
// reload required (see yoloCandidateIndexRef / yoloExhaustedRef below).
// Only once every candidate here has failed does it give up on YOLO for the
// rest of the session and fall back to the face-api-only path (the same
// path LoginPage.jsx uses exclusively).
//
// 🟩 As of 2026-08-15, every publicly reachable face-specific YOLO model
// was checked with a REAL load attempt against this exact
// @huggingface/transformers version (not a file-listing guess), and every
// one failed:
//   - Xenova/yolov8n-face: the entire Xenova org now returns 401 "Invalid
//     username or password" on every model, unconditionally -- confirmed
//     live across multiple Xenova model ids. Permanent, not flaky network.
//     Marked knownBroken below so the revolver skips the doomed network
//     request entirely and advances immediately, instead of eating a
//     browser-console 401 line for nothing.
//   - AdamCodd/YOLOv11n-face-detection: has root config.json + model.onnx,
//     but is missing the required preprocessor_config.json.
//   - deepghs/yolo-face: has real face-detection ONNX weights, but nested
//     under subfolders with no root-level config.json/preprocessor_config.json
//     (still fails even with transformers.js's `subfolder` option).
//   - arnabdhar/YOLOv8-Face-Detection, jaredthejelly/yolov8s-face-detection:
//     ship no .onnx weights at all (PyTorch-only).
//   - onnx-community (Hugging Face's own post-Xenova ONNX org) has no
//     face-specific detector at all -- only general object detectors
//     (yolov10n, etc.), which fail with "Unsupported model type: yolov10"
//     since transformers.js doesn't support that architecture yet.
//   - hustvl/yolos-tiny (the officially-integrated YOLOS architecture,
//     tried as a last resort on the theory that an architecture
//     transformers.js genuinely supports would at least load): has no ONNX
//     export in its repo at all.
// The list below is intentionally left with just that one known-broken
// placeholder. The moment a real working candidate is found (root-level
// config.json + preprocessor_config.json + .onnx weights, architecture
// supported by this transformers.js version), add it here -- the revolver
// picks it up automatically, no other code changes needed.
const YOLO_MODEL_CANDIDATES = [
  { id: 'Xenova/yolov8n-face', knownBroken: true },
];

const AttendanceView = ({ userProfile, attendance = [], allUsers = [], fetchAttendance, fetchProfile, onlineUserIds = new Set() }) => {
    const { t } = useTranslation();
    // 🟩 PAGE VISIBILITY: the scan loops below run every 500-1200ms doing
    // webcam capture + local face-detection inference — real CPU/battery
    // cost, and the camera stays actively engaged, even though none of it
    // calls the API directly. None of that serves any purpose while the
    // tab is backgrounded and nobody can see or click anything, so both
    // loops pause while hidden and pick back up the moment it's visible.
    const isTabVisible = usePageVisibility();
    const FACE_MODEL_URL = import.meta.env.VITE_FACE_MODEL_URL || '/models';
    const FACE_MATCH_THRESHOLD = 0.5;
    const YOLO_FACE_THRESHOLD = 0.35;
    const FACE_SCAN_INTERVAL_MS = 1800;
    // 🟩 BUG FIX: unlike LoginPage.jsx (which never uses YOLO at all --
    // face-api.js only), this view's YOLO detector fetches its model from
    // Hugging Face's CDN on first use. That fetch had NO timeout anywhere:
    // on a network that can't reach huggingface.co at all (corporate
    // firewall, ISP-level block, regional restriction) -- which the
    // Network Information API used by useNetworkBatteryAdaptive can't
    // detect, since general connection speed looks fine -- the `await`
    // simply never resolves, permanently freezing that tick (and every
    // tick after it, since faceScanBusyRef never clears) with no face box,
    // no eye box, and no error message. Reported as "face recognition
    // seems broken, no box ever shows up" on attendance specifically, not
    // login -- consistent with this being the one code path login never
    // touches.
    const YOLO_LOAD_TIMEOUT_MS = 8000;
    const YOLO_INFERENCE_TIMEOUT_MS = 3000;
    // 🟩 Built once face-api.js finishes loading (see loadModels) instead of
    // at module/component top-level, which previously required face-api.js
    // to already be present just to construct this options object.
    const faceapiRef = useRef(null);
    const detectOptionsRef = useRef(null);

    // 🟩 MULTI-ANGLE ENROLLMENT: one template captured per pose instead of a
    // single frontal snapshot — matched against all of them at clock-in time
    // (see multiTemplateMatcher.js) for meaningfully better day-to-day
    // accuracy. Yaw/pitch sign conventions below are a best-effort approximation
    // (mirrored camera preview can flip perceived left/right) — the live
    // numeric readout shown to the user is the real feedback loop, the
    // instruction text is just a starting hint.
    // 🟩 SIMPLIFIED: real-user feedback said the left/right/up/down turns
    // were confusing and made enrollment feel broken/stuck ("susah bener
    // enroll wajah nya") -- a single straight-on capture is far more
    // reliable to complete, at the cost of the multi-angle matching
    // robustness the extra poses used to buy.
    // 🟩 SIMPLIFIED FURTHER (2026-08-11): only 'center' has ever been in this
    // array since the fix above, and repeated real-user feedback (this
    // session) confirmed any left/right/up/down turning -- in this wizard
    // or the liveness challenge -- is unreliable/confusing for non-technical
    // users ("old people do not like doing too much stuff"). Removed the
    // now-fully-dead directional branches instead of leaving unreachable
    // code behind them.
    const ENROLLMENT_POSES = ['center'];
    const CENTER_YAW_THRESHOLD = 0.08;
    const CENTER_PITCH_THRESHOLD = 0.10;
    const isPoseAchieved = (pose, yaw, pitch) => (
        pose === 'center' && Math.abs(yaw) < CENTER_YAW_THRESHOLD && Math.abs(pitch) < CENTER_PITCH_THRESHOLD
    );

    const [isLoading, setIsLoading] = useState(false);
    const [isEnrolling, setIsEnrolling] = useState(false); // 🟩 NEW: guards against rapid re-clicks on Enroll Facial Matrix
    const [enrollmentStepIndex, setEnrollmentStepIndex] = useState(-1); // -1 = wizard not active
    const [enrollmentCaptures, setEnrollmentCaptures] = useState([]);
    const [enrollmentPoseReading, setEnrollmentPoseReading] = useState({ yaw: 0, pitch: 0, achieved: false });
    const [liveDistance, setLiveDistance] = useState(null); 
    const [isInRange, setIsInRange] = useState(false); 
    const [currentCoords, setCurrentCoords] = useState(null); 
    const [isCameraReady, setIsCameraReady] = useState(false);
    const [, setCameraStatus] = useState('idle'); // cameraStatus itself is never read, only tracked
    // 🟩 CAMERA FALLBACK: distinguishes *why* the webcam gate failed (denied
    // permission vs. no camera hardware vs. browser/context doesn't support
    // getUserMedia at all vs. camera already claimed by another app) so the
    // UI can tell the employee what to actually do about it, instead of the
    // scan panel just silently sitting there forever.
    const [cameraError, setCameraError] = useState(null);
    // 🟩 ANTI-AUTOMATION: computed once at mount -- see vision/automationDetector.js
    // and LoginPage.jsx's identical check for the full rationale (blocks a
    // WebDriver-controlled session from the face-scan gate entirely, near-zero
    // false-positive signal, doesn't affect the manual clock-in button).
    const [automationDetected] = useState(() => detectAutomation().suspicious);
    // 🟩 SECURITY: virtual/software camera driver -- see
    // vision/virtualCameraDetector.js and LoginPage.jsx's identical check.
    // Only knowable once camera permission is granted, so set once
    // getUserMedia resolves below, not up front like automationDetected.
    const [virtualCameraDetected, setVirtualCameraDetected] = useState(false);
    // 🟩 MITIGATION: the neural model loader below previously had no
    // try/catch at all -- a failed model fetch (flaky network, CDN hiccup)
    // threw an unhandled promise rejection with zero user-facing feedback;
    // the scan panel just sat on "Loading network weights..." forever.
    const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
    const [modelLoadAttempt, setModelLoadAttempt] = useState(0);
    const [faceStatus, setFaceStatus] = useState('idle');
    // 🟩 BUG FIX (Part 1 guard-ref reset): a failed clock-in sets faceStatus
    // to 'matched' (a few lines above the guardRef check) and then, on
    // failure, resets it back to 'scanning' -- but both happen within the
    // same tick's state-update batch. React bails out of re-rendering (and
    // therefore never re-runs the scan-loop effect, whose deps include
    // faceStatus) when a state variable's value at the end of a batch is
    // identical to its value at the start, which 'scanning' -> 'matched' ->
    // 'scanning' is. A monotonically-incrementing nonce has no such
    // collapse-to-no-op risk -- every failed attempt is a guaranteed-distinct
    // value, so it reliably forces the effect to re-run and recreate the
    // scan interval regardless of what faceStatus itself settles on.
    const [clockInRetryNonce, setClockInRetryNonce] = useState(0);
    const [biometricStatus, setBiometricStatus] = useState(t('login.statusInitializing'));
    // 🟩 UI: directional challenge glyph kept separate from biometricStatus
    // text -- see LoginPage.jsx's identical split for the full rationale
    // (a glyph+long-instruction string doesn't fit well in a small
    // whitespace-nowrap overlay pill).
    const [challengeGlyph, setChallengeGlyph] = useState(null);
    const [, setClockInAt] = useState(''); // write-only, never displayed
    const [, setClockInSource] = useState('none'); // write-only, never displayed
    const [, setCurrentModelVersion] = useState(null); // write-only, never displayed
    // 🟩 NETWORK & BATTERY ADAPTIVE (hooks/useNetworkBatteryAdaptive.js):
    // YOLO is a heavier model fetch + more CPU/battery per frame than
    // face-api's tiny detector alone -- skipped on a slow/metered
    // connection or draining battery. Employees only; supervisors never
    // run the scan loop this feeds.
    // 🟩 PART 3: supervisors now run the exact same scan pipeline as
    // employees (see the camera/model-loading effects below), so this no
    // longer excludes them.
    const { disableYolo, networkBatteryDiagnostics } = useNetworkBatteryAdaptive(!!userProfile);
    const [faceOverlayBox, setFaceOverlayBox] = useState(null);
    // 🟩 NEW: per-eye boxes + closed/open read for the main clock-in scan
    // loop, so a blink is visibly confirmed on screen instead of only
    // being inferred from the status text.
    const [eyeBoxes, setEyeBoxes] = useState(null);
    const [hasStoredFace, setHasStoredFace] = useState(false);
    const [, setFaceMatchDistance] = useState(null); // write-only, never displayed
    const [, setFaceDetectionMode] = useState('idle'); // write-only, never displayed
    const [isFaceVerified, setIsFaceVerified] = useState(false);
    const [scanReadiness, setScanReadiness] = useState(0); // 🟩 NEW: 0-100 "how close to a good capture" score driving the readiness bar during the live clock-in scan
    const [showConsentModal, setShowConsentModal] = useState(false); // 🟩 NEW: biometric-data consent gate before first enrollment
    // 🟩 LOW-LIGHT MITIGATION: don't just reject a dark scan — actively try to
    // fix it. `lowLightStreakRef` counts consecutive dark reads (debounces a
    // single noisy frame from flicking the torch on/off); once it crosses
    // the threshold, `isLowLightRef` also tells detectFaceFromImage to boost
    // brightness/contrast on the capture canvas before running detection.
    const lowLightStreakRef = useRef(0);
    const isLowLightRef = useRef(false);
    const qualityIssueStreakRef = useRef(0); // 🟩 BUG FIX: see the qualityIssue block below -- debounces a single bad-quality tick so it doesn't swallow the one frame a blink transition needed
    const passiveSuspicionStreakRef = useRef(0); // 🟩 BUG FIX: see the livenessSuspicious block below -- a blink's eyelid/eyelash edge can trip deviceEdgeSuspicious for exactly one frame
    const [torchActive, setTorchActive] = useState(false);
    // 🟩 Throttles the expensive full-frame lens-obstruction scan (see below)
    // to once every 5 ticks instead of every scan tick.
    const lensCheckTickRef = useRef(0);
    const cachedLensResultRef = useRef({ ok: true, reason: null });
    const LENS_CHECK_INTERVAL_TICKS = 5;
    // 🟩 BUG FIX: counts consecutive *real* (non-cached) obstructed
    // verdicts -- see the lens-check block below for why a single one is
    // never enough to block on its own.
    const lensObstructedStreakRef = useRef(0);
    // 🟩 SENSOR FUSION: fuses devicemotion's x/y/z accelerometer axes into a
    // rolling stability signal — mobile-only (desktop webcams have no
    // accelerometer, so this just never becomes `ready` there, which is the
    // correct no-op). See sensors/motionStability.js.
    const motionTrackerRef = useRef(createMotionStabilityTracker());
    const microMotionTrackerRef = useRef(createMicroMotionTracker()); // 🟩 NEW: pixel-based liveness signal that works on desktop webcams too (motionTrackerRef above needs a phone/tablet accelerometer)
    const latestColorLivenessRef = useRef({ suspicious: false }); // 🟩 NEW: latest per-tick skin-color/texture plausibility read — catches a shaken physical photo/phone that would otherwise pass the motion-only signals
    // 🟩 SECURITY: active liveness challenge, reinstated as a mandatory gate
    // on top of the passive signals above (see vision/livenessFusion.js)
    // after a printed photo defeated the previous passive-only design for
    // BOTH this page and Login during the capstone defense.
    // 🟩 SIMPLIFIED (2026-08-12): single blink instead of double, per
    // explicit design call -- see LoginPage.jsx's identical change for the
    // full rationale. The mandatory rPPG pulse gate that used to be the
    // other hard backstop is now advisory-only; mandatory frame-to-frame
    // face-box motion (vision/boxMotionHeuristic.js) takes its place as
    // the second backstop alongside the blink.
    const livenessChallengeRef = useRef(new RandomLivenessChallenge({
        challengeType: CHALLENGE_TYPES.BLINK,
        steps: 1,
    }));
    const boxMotionTrackerRef = useRef(createBoxMotionTracker());
    const prevFaceBoxForMotionRef = useRef(null);
    // 🟩 rPPG PULSE LIVENESS: an additional, independent biometric vote --
    // see vision/pulseDetector.js for the full rationale. Deliberately
    // decoupled from the main ~1.2s scan tick below (a pulse needs ~20Hz
    // sampling); a separate fast interval (see the "PULSE SAMPLING LOOP"
    // effect further down) feeds it instead. latestFaceBoxRef mirrors
    // faceOverlayBox state into a ref so that fast loop always reads the
    // current box without needing to tear down/recreate itself every time
    // the (much slower) main tick updates it. pulseCanvasRef is a single
    // reused small canvas (not reallocated 20x/sec) for the cheap
    // crop+downscale read.
    const pulseDetectorRef = useRef(createPulseDetector());
    const latestFaceBoxRef = useRef(null);
    const pulseCanvasRef = useRef(null);
    // 🟩 EDGE-INFERENCE LATENCY MONITOR: see vision/inferenceLatencyMonitor.js
    // -- observed (not just predicted-at-mount-time) per-tick detection
    // latency. dynamicYoloDisableRef is a one-way circuit breaker: once a
    // device has proven it can't sustain YOLO's cost, stays downgraded to
    // face-api-only for the rest of the session.
    const latencyMonitorRef = useRef(createLatencyMonitor());
    const dynamicYoloDisableRef = useRef(false);
    // 🟩 REVOLVER STATE: yoloCandidateIndexRef points at the current entry in
    // YOLO_MODEL_CANDIDATES; advances by one on any failure. yoloExhaustedRef
    // flips true (one-way) once the index runs past the end of the list --
    // distinct from dynamicYoloDisableRef above, which is a separate
    // sustained-latency circuit breaker unrelated to which model was tried.
    const yoloCandidateIndexRef = useRef(0);
    const yoloExhaustedRef = useRef(false);
    // 🟩 EDGE DEVICE DIAGNOSTICS: a purely local, purely visual readout of
    // the sensor signals already being computed above — network/battery
    // adaptive mode, ambient light, lens clarity, motion stability. Nothing
    // here is broadcast anywhere (that's exactly what made the earlier
    // "Digital Twin" dashboard wasteful and got it removed); this is just
    // rendering state that already exists locally, at zero extra network
    // cost, so the IoT/edge-computing work in this view is actually visible
    // instead of running silently in the background.
    // Network/battery fields live in useNetworkBatteryAdaptive's own state
    // (see networkBatteryDiagnostics above) and get merged in at render
    // time for EdgeDiagnosticsPanel -- everything else here still comes
    // from the scan loop/ambient-light watcher below.
    const [sensorDiagnostics, setSensorDiagnostics] = useState({
        ambientLux: null,
        isAmbientLowLight: false,
        lensClear: true,
        motionReady: false,
        motionStable: true,
        microMotionReady: false,
        microMotionStable: true,
        colorPlausible: true,
        pulseReady: false,
        pulsePlausible: true,
        pulseBpm: null,
        latencyReady: false,
        latencyOverBudget: false,
        avgLatencyMs: 0,
    });

    const [searchTerm, setSearchTerm] = useState('');
    const [filterSource, setFilterSource] = useState('all');
    const [filterMode, setFilterMode] = useState('all');
    const [filterStatus, setFilterStatus] = useState('all');
    const [sortBy, setSortBy] = useState('name-az');
    const [historyStatusFilter, setHistoryStatusFilter] = useState('all'); // 🟩 NEW: On Time / Late filter for the personal log grid

    // --- SORTABLE TABLE COLUMNS (roster table) — takes precedence over the sortBy dropdown when set ---
    const [columnSort, setColumnSort] = useState({ key: null, direction: 'asc' });
    const toggleColumnSort = (key) => {
        setColumnSort(prev => (
            prev.key === key
                ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
                : { key, direction: 'asc' }
        ));
    };

    // 🟩 TIMEZONE FIX: toISOString() returns the UTC calendar date, which
    // is still YESTERDAY for a WIB (UTC+7) user clocking in before 7am
    // local. getLocalDateString() uses local calendar fields instead.
    const today = getLocalDateString();
    // 🟩 Memoized so this always returns the SAME reference when `attendance`
    // hasn't changed -- otherwise the `[]` fallback (taken whenever
    // `attendance` isn't an array) would be a fresh array every render,
    // defeating myHistory/filteredMyHistory's own memoization below.
    const attendanceRows = useMemo(() => (Array.isArray(attendance) ? attendance : []), [attendance]);
    const todayRecord = attendanceRows.find(record => record.employee_id === userProfile.id && record.date === today);

    // 🟩 NEW SUBMODULES (supervisor-only, purely additive): this file is
    // the most sensitive one in the app -- live camera + face-recognition
    // state machine -- so unlike every other view's "wrap existing content
    // in an Overview tab" treatment, NOTHING above this comment (the
    // clock-in/scan flow, camera refs, enrollment wizard, roster table)
    // was touched or gated behind a tab at all. These two panels are
    // appended as a brand new, fully independent section at the very
    // bottom of the page (see the end of the JSX return below), reusing
    // only the already-fetched `attendanceRows`/`allUsers` props -- no new
    // state feeds into the scan loop, and no existing state feeds into
    // these.
    const [insightsTab, setInsightsTab] = useState('punctuality');
    const teamPunctuality = useMemo(() => {
        if (userProfile.role !== 'supervisor') return [];
        return allUsers
            .filter((u) => u.role === 'employee')
            .map((emp) => {
                const rows = attendanceRows.filter((a) => a.employee_id === emp.id);
                return { id: emp.id, name: emp.name, score: PunctualityPolicy.calculate(rows), recordCount: rows.length };
            })
            .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    }, [userProfile.role, allUsers, attendanceRows]);
    const recentLateRecords = useMemo(() => {
        if (userProfile.role !== 'supervisor') return [];
        const usersById = new Map(allUsers.map((u) => [u.id, u]));
        return attendanceRows
            .filter((a) => a.status === 'Late')
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 20)
            .map((a) => ({ ...a, name: usersById.get(a.employee_id)?.name || t('attendance.unknownEmployee') }));
    }, [userProfile.role, allUsers, attendanceRows, t]);


    const webcamVideoRef = useRef(null);
    const referenceDescriptorRef = useRef(null);
    const faceScanBusyRef = useRef(false);
    const scanFailureStreakRef = useRef(0); // 🟩 NEW: consecutive scan-tick exceptions -- previously only ever logged to console with zero user-facing feedback
    const yoloDetectorRef = useRef(null);
    const yoloDetectorPromiseRef = useRef(null);
    const autoClockInGuardRef = useRef(false);
    // 🟩 NEW: clock-out face verification. Previously "Clock Out" was a bare
    // button with zero identity check -- anyone at a shared device could
    // clock someone else out. Arming this reuses the exact same scan loop,
    // matcher, and (now-hardened) liveness pipeline as clock-in, just
    // routed to handleClockOut on a confirmed live match instead.
    const [isClockingOut, setIsClockingOut] = useState(false);
    const clockOutGuardRef = useRef(false);
    const webcamStreamRef = useRef(null);
    const borderlineStreakRef = useRef(0); // consecutive borderline-tier match reads, for confidence-tiered re-check
    // Client-side pre-throttle on repeated mismatches (NOT the security boundary —
    // trivially bypassable client-side — just avoids hammering the scan loop
    // indefinitely; per utils/tokenBucket.js's documented purpose).
    const mismatchBucketRef = useRef(getBucket(`face-scan-${userProfile.id}`, { capacity: 8, refillRatePerSec: 8 / 30 }));
    const enrollmentScanBusyRef = useRef(false);
    const latestEnrollmentDetectionRef = useRef(null);

    // ============================================================
    // PART 2: "TEST BIOMETRIC SCAN" MODE -- lets either role verify the
    // scan/liveness/match pipeline actually works without creating or
    // touching any real attendance record. Deliberately uses its OWN
    // liveness-challenge/box-motion tracker instances (never
    // livenessChallengeRef/boxMotionTrackerRef, the ones the real clock-in/
    // out loop above owns) so a test run can never leave residue that
    // affects a real clock-in/out attempt, and vice versa. Reuses the same
    // pure detection functions (detectFaceFromImage, matchAgainstTemplates,
    // evaluatePassiveLiveness, etc.) -- same math, genuinely the same
    // pipeline -- just an independent orchestration loop that only ever
    // writes to test-scoped state below, never to attendance/handleClockIn/
    // handleClockOut/todayRecord/isClockingOut.
    // ============================================================
    const [isTestScanning, setIsTestScanning] = useState(false);
    const [testScanResult, setTestScanResult] = useState(null); // null | { status: 'pass'|'fail', reason: string }
    const testScanBusyRef = useRef(false);
    const testLivenessChallengeRef = useRef(null);
    const testBoxMotionTrackerRef = useRef(null);
    const testPrevFaceBoxRef = useRef(null);
    const testScanStartedAtRef = useRef(0);
    const TEST_SCAN_TIMEOUT_MS = 20000;

    // 🟩 MULTI-TEMPLATE: returns an array of Float32Array templates instead
    // of a single descriptor. Handles both a legacy single-angle enrollment
    // (wrapped as a 1-element array) and a multi-angle enrollment (several
    // templates, one per captured pose) — see vision/multiTemplateMatcher.js.
    // No schema change: the profiles.face_descriptor column already stores
    // arbitrary JSON text, this is just a different shape within it.
    const parseStoredDescriptor = (value) => {
        if (!value) return [];
        let parsed = value;
        if (typeof value === 'string') {
            try { parsed = JSON.parse(value); } catch { return []; }
        }
        return normalizeStoredTemplates(parsed).map((t) => new Float32Array(t));
    };

    const getRecordClockInTime = (record) => record?.clock_in || record?.created_at || '';

    const normalizeBoundingBox = (box) => {
        if (!box) return null;
        const x = Number(box.xmin ?? box.x ?? 0);
        const y = Number(box.ymin ?? box.y ?? 0);
        const width = Number(box.width ?? ((box.xmax ?? 0) - (box.xmin ?? 0)));
        const height = Number(box.height ?? ((box.ymax ?? 0) - (box.ymin ?? 0)));
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
        return { x, y, width, height };
    };

    const detectWithFaceApi = async (canvasOrImage) => {
        const faceapi = faceapiRef.current;
        const detections = await faceapi.detectAllFaces(canvasOrImage, detectOptionsRef.current).withFaceLandmarks().withFaceDescriptors();
        if (detections.length > 0) {
            const best = detections.sort((a, b) => (b.detection.score || 0) - (a.detection.score || 0))[0];
            return { ...best, faceCount: detections.length };
        }
        const single = await faceapi.detectSingleFace(canvasOrImage, detectOptionsRef.current).withFaceLandmarks().withFaceDescriptor();
        return single ? { ...single, faceCount: 1 } : null;
    };

    const detectFaceFromImage = async (imageEl) => {
        // 🟩 Defensive guard: the enrollment "Start Enrollment" button was
        // only ever gated on the camera being ready, not on the (lazily
        // loaded) face-api.js module having actually finished downloading —
        // a narrow but real race on a slow connection. Bail out cleanly
        // instead of throwing on `faceapiRef.current` being null.
        if (!imageEl || !faceapiRef.current) return null;
        const faceapi = faceapiRef.current;
        const isVideo = imageEl.tagName === 'VIDEO';
        const ready = isVideo ? imageEl.readyState >= 2 : imageEl.complete;
        const width = isVideo ? imageEl.videoWidth : imageEl.naturalWidth;
        const height = isVideo ? imageEl.videoHeight : imageEl.naturalHeight;

        if (!ready || width === 0 || height === 0) return null;

        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = width;
        sourceCanvas.height = height;
        // 🟩 PERF: this canvas's context gets read back with getImageData
        // several times per tick downstream (face-box region, lens/hand
        // full-frame checks, device-edge border region) -- willReadFrequently
        // tells the browser to optimize for that instead of GPU-accelerated
        // drawing, avoiding the "Multiple readback operations" warning and
        // the actual readback slowdown it's warning about. Must be set here,
        // at first getContext() -- a canvas's context (and its options) are
        // fixed for its lifetime, so setting it on a later getContext() call
        // on the same canvas (e.g. where liveDet.sourceCanvas is reused
        // further down) has no effect.
        const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
        if (!sourceContext) return null;
        // 🟩 LOW-LIGHT IMAGE ENHANCEMENT: when recent frames came back too
        // dark, boost brightness/contrast on the way into the capture canvas
        // instead of just rejecting every scan until the room gets brighter.
        // Standard Canvas 2D `filter` — cheap, and only active while dark.
        sourceContext.filter = isLowLightRef.current ? 'brightness(1.6) contrast(1.15)' : 'none';
        sourceContext.drawImage(imageEl, 0, 0, width, height);
        sourceContext.filter = 'none';

        if (!yoloExhaustedRef.current && !disableYolo && !dynamicYoloDisableRef.current) {
            try {
                const detector = await withTimeout(ensureYoloFaceDetector(), YOLO_LOAD_TIMEOUT_MS, 'yolo-model-load');
                const rawDetections = await withTimeout(
                    detector(sourceCanvas, { threshold: YOLO_FACE_THRESHOLD }),
                    YOLO_INFERENCE_TIMEOUT_MS,
                    'yolo-inference'
                );
                // 🟩 CROWDED-SCENE HANDLING: pick the primary (largest + most
                // centered) face among everyone YOLO found in the frame instead
                // of blindly taking the highest-confidence box — a bystander
                // walking past shouldn't be able to outrank the person actually
                // standing in front of the camera. isAmbiguous only flags when a
                // second face is both similar in size AND physically adjacent to
                // the primary — the actual "photo held next to face" attack shape.
                const candidates = rawDetections
                    .map((d) => ({ box: normalizeBoundingBox(d.box), score: d.score }))
                    .filter((d) => d.box);
                const { primary, isAmbiguous } = selectPrimaryFace(candidates, width, height);

                if (primary?.box) {
                    const cropCanvas = cropFaceCanvas(sourceCanvas, primary.box);
                    if (cropCanvas) {
                        const croppedDetection = await detectWithFaceApi(cropCanvas);
                        if (croppedDetection) {
                            return {
                                ...croppedDetection,
                                source: 'yolo',
                                box: primary.box,
                                faceCount: candidates.length, // YOLO's whole-frame count takes precedence over the single crop's own count
                                isAmbiguous,
                                sourceCanvas,
                            };
                        }
                    }
                }
            } catch (_error) {
                // 🟩 REVOLVER: any failure for the currently-selected
                // candidate -- model-load error, the knownBroken placeholder,
                // or an inference timeout -- advances to the next entry in
                // YOLO_MODEL_CANDIDATES for the very next scan tick, no page
                // reload needed. Previously a single failure permanently
                // disabled YOLO for the whole session; now that only happens
                // once every candidate in the list has been tried and failed
                // (yoloExhaustedRef), so a working model added to the list
                // later gets a real chance instead of being preempted by an
                // earlier candidate's one-shot failure.
                yoloDetectorRef.current = null;
                yoloDetectorPromiseRef.current = null;
                yoloCandidateIndexRef.current += 1;
                if (yoloCandidateIndexRef.current >= YOLO_MODEL_CANDIDATES.length) {
                    yoloExhaustedRef.current = true;
                }
                if (import.meta.env.DEV) {
                    console.info(
                        `YOLO candidate failed, revolver advancing (${yoloCandidateIndexRef.current}/${YOLO_MODEL_CANDIDATES.length}). Falling back to face-api full frame for this tick.`,
                        _error
                    );
                }
            }
        }

        const allFaceApiDetections = await faceapi.detectAllFaces(sourceCanvas, detectOptionsRef.current).withFaceLandmarks().withFaceDescriptors();
        if (allFaceApiDetections.length > 0) {
            const candidates = allFaceApiDetections
                .map((d) => ({ box: normalizeBoundingBox(d.detection?.box), raw: d }))
                .filter((d) => d.box);
            const { primary, isAmbiguous } = selectPrimaryFace(candidates, width, height);
            if (primary) {
                return { ...primary.raw, source: 'faceapi', box: primary.box, faceCount: candidates.length, isAmbiguous, sourceCanvas };
            }
        }

        // Last-resort fallback for the rare case detectAllFaces finds nothing
        // but the single-face detector's slightly different algorithm does.
        const single = await faceapi.detectSingleFace(sourceCanvas, detectOptionsRef.current).withFaceLandmarks().withFaceDescriptor();
        if (!single) return null;
        return {
            ...single,
            source: 'faceapi',
            box: normalizeBoundingBox(single.detection?.box || single.box),
            faceCount: 1,
            isAmbiguous: false,
            sourceCanvas,
        };
    };

    const cropFaceCanvas = (sourceCanvas, box) => {
        if (!sourceCanvas || !box) return null;
        const x = Math.max(0, Math.floor(box.xmin ?? box.x ?? 0));
        const y = Math.max(0, Math.floor(box.ymin ?? box.y ?? 0));
        const width = Math.max(1, Math.floor(box.width ?? ((box.xmax ?? 0) - (box.xmin ?? 0))));
        const height = Math.max(1, Math.floor(box.height ?? ((box.ymax ?? 0) - (box.ymin ?? 0))));
        const safeWidth = Math.min(width, sourceCanvas.width - x);
        const safeHeight = Math.min(height, sourceCanvas.height - y);

        if (safeWidth <= 1 || safeHeight <= 1) return null;

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = safeWidth;
        cropCanvas.height = safeHeight;
        const cropContext = cropCanvas.getContext('2d');
        if (!cropContext) return null;
        cropContext.drawImage(sourceCanvas, x, y, safeWidth, safeHeight, 0, 0, safeWidth, safeHeight);
        return cropCanvas;
    };

    const ensureYoloFaceDetector = async () => {
        if (yoloDetectorRef.current) return yoloDetectorRef.current;
        const candidate = YOLO_MODEL_CANDIDATES[yoloCandidateIndexRef.current];
        if (!candidate) throw new Error('yolo-revolver-exhausted');
        // 🟩 REVOLVER: a candidate marked knownBroken (currently only
        // Xenova/yolov8n-face, permanently 401-gated at the HF org level --
        // see YOLO_MODEL_CANDIDATES doc comment) is rejected here WITHOUT
        // making the network request at all. The caller's catch block
        // advances the revolver to the next candidate exactly like any
        // other failure, so this costs one skipped tick, not a wasted round
        // trip or an unsuppressable browser-console 401 line.
        if (candidate.knownBroken) throw new Error(`yolo-candidate-known-broken:${candidate.id}`);

        if (!yoloDetectorPromiseRef.current) {
            // 🟩 SIMPLIFIED: there's no local copy of the YOLO weights under
            // public/models/ (only the face-api.js models live there), so a
            // fallback fetch to a local YOLO path was guaranteed to 404/fail
            // right after the remote Hugging Face fetch already failed --
            // just extra latency and console noise before the caller's own
            // try/catch (detectFaceFromImage) falls back to face-api.js.
            yoloDetectorPromiseRef.current = loadTransformersModule()
                .then(({ pipeline }) => pipeline('object-detection', candidate.id))
                .then(detector => {
                    yoloDetectorRef.current = detector;
                    setCurrentModelVersion(candidate.id);
                    return detector;
                })
                .catch((err) => {
                    yoloDetectorPromiseRef.current = null;
                    throw err;
                });
        }
        return yoloDetectorPromiseRef.current;
    };

    // HISTORY SUMMARY CALCULATIONS
    // 🟩 PERFORMANCE: this used to re-filter/re-score the WHOLE company's
    // attendance table (not just this employee's rows) on every render,
    // including the live scan loop's own re-renders every
    // FACE_SCAN_INTERVAL_MS while the camera is active -- unrelated to
    // these history-tab numbers. Memoized like the rest of this file's
    // derived state.
    const myHistory = useMemo(
        () => attendanceRows.filter(a => a.employee_id === userProfile.id),
        [attendanceRows, userProfile.id]
    );
    const totalDays = myHistory.length;
    const lateDays = useMemo(() => myHistory.filter(a => a.status === 'Late').length, [myHistory]);
    const punctualityScore = useMemo(() => PunctualityPolicy.calculate(myHistory) ?? 0, [myHistory]);

    // 🟩 NEW: Lets an intern filter their own log by On Time / Late instead of
    // scanning every card manually.
    const filteredMyHistory = useMemo(
        () => myHistory.filter(a => historyStatusFilter === 'all' || a.status === historyStatusFilter),
        [myHistory, historyStatusFilter]
    );

    const activeEmployees = allUsers.filter(u => u.role === 'employee');
    const clockedInTodayCount = activeEmployees.filter(emp => 
        attendanceRows.some(a => a.employee_id === emp.id && a.date === today)
    ).length;
    const wfhAssignmentCount = activeEmployees.filter(emp => emp.work_mode === 'WFH').length;
    const wfoAssignmentCount = activeEmployees.filter(emp => (emp.work_mode || 'WFO') === 'WFO').length;

    const uniqueSources = Array.from(
        new Set(
            allUsers
                .filter(u => u.role === 'employee')
                .map(u => u.source || u.university || 'President University')
        )
    );

    const processedInterns = allUsers
        .filter(u => u.role === 'employee')
        .filter(emp => {
            const matchesSearch = emp.name.toLowerCase().includes(searchTerm.toLowerCase());
            const empSource = emp.source || emp.university || 'President University';
            const matchesSource = filterSource === 'all' || empSource === filterSource;
            const empMode = emp.work_mode || 'WFO';
            const matchesMode = filterMode === 'all' || empMode === filterMode;
            
            const empTodayRecord = attendanceRows.find(a => a.employee_id === emp.id && a.date === today);
            let matchesStatus = true;
            if (filterStatus === 'clocked_in') matchesStatus = !!empTodayRecord;
            if (filterStatus === 'not_clocked_in') matchesStatus = !empTodayRecord;

            return matchesSearch && matchesSource && matchesMode && matchesStatus;
        })
        .sort((a, b) => {
            if (columnSort.key) {
                const dir = columnSort.direction === 'asc' ? 1 : -1;
                if (columnSort.key === 'status') {
                    const aClocked = attendanceRows.some(att => att.employee_id === a.id && att.date === today);
                    const bClocked = attendanceRows.some(att => att.employee_id === b.id && att.date === today);
                    return (bClocked - aClocked) * dir;
                }
                const getVal = (emp) => {
                    if (columnSort.key === 'name') return emp.name;
                    if (columnSort.key === 'institution') return emp.source || emp.university || 'President University';
                    if (columnSort.key === 'mode') return emp.work_mode || 'WFO';
                    return '';
                };
                return getVal(a).localeCompare(getVal(b)) * dir;
            }
            if (sortBy === 'name-az') return a.name.localeCompare(b.name);
            if (sortBy === 'name-za') return b.name.localeCompare(a.name);
            if (sortBy === 'status-active') {
                const aClocked = attendanceRows.some(att => att.employee_id === a.id && att.date === today);
                const bClocked = attendanceRows.some(att => att.employee_id === b.id && att.date === today);
                return bClocked - aClocked;
            }
            return 0;
        });

    const [exportEmployeeId, setExportEmployeeId] = useState('all'); // 🟩 NEW: single-employee export filter

    const exportDataFiltered = processedInterns
        .filter(emp => exportEmployeeId === 'all' || emp.id === exportEmployeeId)
        .flatMap(emp => 
        attendanceRows.filter(a => a.employee_id === emp.id).map(record => ({
            Date: record.date,
            Employee: emp.name,
            Institution: emp.source || emp.university || 'President University',
            "Assigned Mode": emp.work_mode || 'WFO',
            Status: record.status,
            "Check In": getRecordClockInTime(record),
            "Check Out": record.clock_out
        }))
    );

    // ==========================================
    // GEOLOCATION STREAM LOGIC
    // ==========================================
    useEffect(() => {
        if (!navigator.geolocation || !userProfile) return;

        // 🟩 GEOFENCE STATE MACHINE: a plain `dist <= radius` check flickers
        // whenever GPS noise (routinely several meters) puts a reading right
        // at the boundary — the "in range" gate would flip on and off every
        // few seconds for anyone standing near the edge. Hysteresis + a
        // small debounce (see geo/geofenceStateMachine.js) smooths that out.
        // A fresh machine per effect run — it should reset if the assigned
        // office location itself changes.
        const geofenceMachine = createGeofenceStateMachine({ radiusMeters: ALLOWED_RADIUS_METERS, hysteresisMeters: 25, requiredConsecutiveReads: 2 });

        const watchId = navigator.geolocation.watchPosition(
            (position) => {
                try {
                    const { latitude, longitude } = position.coords;
                    setCurrentCoords({ latitude, longitude });

                    const dist = calculateDistanceMeters(latitude, longitude, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);

                    setLiveDistance(dist);

                    // 🟩 REVERTED (2026-08-16): a prior round drove this by
                    // work_mode for supervisors too, same as an employee's.
                    // Reported live: that blocked a supervisor from clocking
                    // in/out while genuinely away from the office on
                    // supervisor business. Supervisors are exempt from the
                    // geofence unconditionally again, regardless of their
                    // assigned WFO/WFH mode -- only employees are gated by it.
                    const assignedMode = userProfile.work_mode || 'WFO';
                    if (userProfile.role === 'supervisor' || assignedMode === 'WFH') {
                        setIsInRange(true);
                    } else {
                        setIsInRange(geofenceMachine.update(dist).state === 'INSIDE');
                    }
                } catch (e) {
                    if (import.meta.env.DEV) console.info(e);
                }
            },
            (_err) => {
                setCurrentCoords(null);
                setLiveDistance(null);
                setIsInRange(false);
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );

        return () => navigator.geolocation.clearWatch(watchId);
    }, [userProfile]);

    // ==========================================
    // SENSOR FUSION: DEVICE MOTION STABILITY
    // ==========================================
    useEffect(() => {
        // 🟩 PART 3: no longer excludes supervisors -- same liveness pipeline as employees.
        if (!userProfile || typeof DeviceMotionEvent === 'undefined') return;

        // 🟩 devicemotion can fire as often as ~60Hz on capable hardware —
        // the tracker only needs enough samples to see whether the device is
        // trembling naturally or dead-still, so readings are throttled to
        // roughly 10/sec instead of processing (and array-pushing) every
        // single event. Real battery/CPU savings on mobile with no loss of
        // signal quality for what this is actually detecting.
        let lastSampleAt = 0;
        const MOTION_SAMPLE_INTERVAL_MS = 100;
        const handleMotion = (event) => {
            const now = Date.now();
            if (now - lastSampleAt < MOTION_SAMPLE_INTERVAL_MS) return;
            lastSampleAt = now;
            const acc = event.accelerationIncludingGravity || event.acceleration;
            if (!acc) return;
            motionTrackerRef.current.addReading({ x: acc.x, y: acc.y, z: acc.z });
        };

        let cancelled = false;
        const tracker = motionTrackerRef.current;
        // iOS 13+ requires an explicit, user-gesture-triggered permission
        // prompt for motion sensors; every other platform just works.
        const attach = async () => {
            try {
                if (typeof DeviceMotionEvent.requestPermission === 'function') {
                    const permission = await DeviceMotionEvent.requestPermission();
                    if (permission !== 'granted' || cancelled) return;
                }
                window.addEventListener('devicemotion', handleMotion);
            } catch {
                // Sensor unavailable/denied — motion tracker just stays "not ready" forever, which is fine.
            }
        };
        attach();

        return () => {
            cancelled = true;
            window.removeEventListener('devicemotion', handleMotion);
            tracker.reset();
        };
    }, [userProfile]);

    // ==========================================
    // AMBIENT LIGHT SENSOR (where available)
    // ==========================================
    useEffect(() => {
        // 🟩 PART 3: no longer excludes supervisors -- same liveness pipeline as employees.
        if (!userProfile) return;

        // 🟩 Feeds the *same* low-light mitigation path as the pixel-
        // brightness check (item 17) — a real lux reading can catch a dim
        // room before the user even starts scanning, instead of waiting for
        // 3 dark camera frames. Support is rare (Chrome desktop/Android
        // behind a Permissions-Policy header); createAmbientLightWatcher
        // returns null everywhere else and this effect is then a no-op.
        const watcher = createAmbientLightWatcher({
            onReading: ({ lux, isLowLight }) => {
                setSensorDiagnostics((prev) => (prev.ambientLux === lux && prev.isAmbientLowLight === isLowLight
                    ? prev
                    : { ...prev, ambientLux: lux, isAmbientLowLight: isLowLight }));

                if (isLowLight === isLowLightRef.current) return;
                isLowLightRef.current = isLowLight;
                if (isLowLight) {
                    if (webcamStreamRef.current && isTorchSupported(webcamStreamRef.current)) {
                        setTorch(webcamStreamRef.current, true).then((ok) => ok && setTorchActive(true));
                    }
                } else {
                    lowLightStreakRef.current = 0;
                    if (webcamStreamRef.current) {
                        setTorch(webcamStreamRef.current, false).then(() => setTorchActive(false));
                    }
                }
            },
        });

        return () => watcher?.stop();
    }, [userProfile]);


    // ==========================================
    // VIDEO LIFE CYCLE CONTROLLER
    // ==========================================
    useEffect(() => {
        // 🟩 PART 3: supervisors now get the same real camera-based clock-in/
        // out capability as employees, so this no longer skips them.
        if (!userProfile) return;
        let isCancelled = false;
        let stream = null;

        const startWebcam = async () => {
            setCameraStatus('loading');
            setCameraError(null);

            if (automationDetected) {
                // Don't request camera access at all for a WebDriver-
                // controlled session -- the manual "Clock In Shift" button
                // still works (it doesn't depend on the camera), only the
                // face-scan gate is blocked.
                setCameraStatus('error');
                return;
            }

            if (!navigator.mediaDevices?.getUserMedia) {
                // Very old browser, or a non-secure (http, non-localhost) context —
                // getUserMedia is unavailable entirely rather than throwing.
                setCameraStatus('error');
                setCameraError('unsupported');
                return;
            }

            try {
                stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
                if (isCancelled) {
                    stream.getTracks().forEach(track => track.stop());
                    return;
                }

                const [virtualCameraCheck, virtualCameraCheckEnabled] = await Promise.all([
                    checkVirtualCamera(),
                    isVirtualCameraCheckEnabled(),
                ]);
                if (isCancelled) { stream.getTracks().forEach(track => track.stop()); return; }
                if (virtualCameraCheck.suspicious && virtualCameraCheckEnabled) {
                    console.warn('[attendance] virtual camera driver detected:', virtualCameraCheck.matchedLabel);
                    stream.getTracks().forEach(track => track.stop());
                    setVirtualCameraDetected(true);
                    setCameraStatus('error');
                    return;
                }
                // 🟩 A supervisor can disable this check globally (Debug
                // Center > Camera & Face) -- still worth a console note when
                // it would have blocked, so the bypass isn't silent.
                if (virtualCameraCheck.suspicious && !virtualCameraCheckEnabled) {
                    console.info('[attendance] virtual camera driver detected but the check is disabled:', virtualCameraCheck.matchedLabel);
                }

                webcamStreamRef.current = stream;
                if (webcamVideoRef.current) {
                    webcamVideoRef.current.srcObject = stream;
                }
                setIsCameraReady(true);
                setCameraStatus('ready');
            } catch (error) {
                setCameraStatus('error');
                if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
                    setCameraError('denied');
                } else if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
                    setCameraError('not-found');
                } else if (error?.name === 'NotReadableError') {
                    setCameraError('busy');
                } else {
                    setCameraError('unknown');
                }
            }
        };

        startWebcam();

        return () => {
            isCancelled = true;
            if (stream) stream.getTracks().forEach(track => track.stop());
        };
    }, [userProfile, automationDetected]);

    // ==========================================
    // NEURAL MODEL ENGINE WEIGHT LOADER
    // ==========================================
    useEffect(() => {
        // 🟩 PART 3: no longer excludes supervisors -- same liveness pipeline as employees.
        if (!userProfile) return;

        async function loadModels() {
            setModelsLoadFailed(false);
            setFaceStatus('loading-models');
            setBiometricStatus(t('attendance.statusLoadingModels'));
            try {
                const faceapi = await loadFaceApiModule();
                faceapiRef.current = faceapi;
                await Promise.all([
                    faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
                    faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL),
                    faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL)
                ]);
                detectOptionsRef.current = new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.15 });
            } catch (err) {
                console.error('[attendance] Failed to load face-recognition models:', err);
                setFaceStatus('error');
                setModelsLoadFailed(true);
                setBiometricStatus(t('attendance.statusModelsUnreachable'));
                return;
            }
            const savedTemplates = parseStoredDescriptor(userProfile.face_descriptor);
            if (savedTemplates.length > 0) {
                referenceDescriptorRef.current = savedTemplates;
                setHasStoredFace(true);
                setFaceStatus('scanning');
                setBiometricStatus(t('attendance.statusAlignFace'));
            } else {
                setFaceStatus('error');
                setBiometricStatus(t('attendance.statusMissingProfile'));
            }
        }
        loadModels();
        // 🟩 `t` deliberately omitted -- this effect downloads the face-api.js
        // model weights (several MB), a one-time cost per mount that must
        // NOT re-run just because the user toggles the app language mid-load
        // (i18next's `t` reference changes on every language switch).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userProfile, disableYolo, FACE_MODEL_URL, modelLoadAttempt]);

    // 🟩 BUG FIX: the scan loop below used to list the raw `faceStatus`
    // string as an effect dependency. The very first tick that finds a
    // face match sets faceStatus to 'matched' *before* the multi-tick
    // liveness (blink) challenge is actually confirmed -- in real usage
    // (unlike the test mocks, which confirm a blink instantly on the same
    // tick) that's several ticks before the challenge completes. Because
    // faceStatus was a dependency, React tore the whole effect down the
    // moment it changed to 'matched' -- clearing the interval AND the
    // face/eye overlay boxes via the cleanup below -- and the guard then
    // refused to recreate it (faceStatus was no longer 'scanning'),
    // permanently freezing the scan mid-challenge: no more ticks ever ran,
    // so a real blink could never actually be registered. Reported live
    // repeatedly as "no box, blink never detected" specifically on
    // clock-out (which always needs a fresh multi-tick challenge; a
    // repeat clock-IN attempt could luck into finishing within the one
    // tick the interval had left before dying). Depending on this
    // derived boolean instead keeps the SAME running interval alive
    // across 'scanning' <-> 'matched' <-> 'mismatch' transitions (nothing
    // inside the tick callback below actually reads `faceStatus`
    // reactively -- it's write-only from inside the loop), while still
    // correctly starting the loop once models finish loading and
    // correctly refusing to start at all while genuinely broken.
    const scanEligible = faceStatus !== 'idle' && faceStatus !== 'loading-models' && faceStatus !== 'error';

    // ==========================================
    // ACTIVE MOTION DETECTOR SCAN ENGINE HOOK
    // ==========================================
    useEffect(() => {
        // 🟩 CLOCK-OUT VERIFICATION: this loop normally only runs before
        // clock-in (no todayRecord yet). It also runs once todayRecord
        // exists IF the user has explicitly armed clock-out verification
        // (isClockingOut) -- same scan/match/liveness pipeline, just
        // routed to handleClockOut below instead of handleClockIn.
        const clockingOutNow = isClockingOut && !!todayRecord && !todayRecord.clock_out;
        // 🟩 PART 2: mutually exclusive with Test Mode -- both loops read
        // the same webcam video element, and only one should ever be
        // driving real clock-in/out state at a time. Test Mode arming this
        // pauses the real loop; it resumes automatically once the test run
        // ends (isTestScanning flips back to false, a listed dependency).
        if (!isCameraReady || !scanEligible || !isTabVisible || isTestScanning) return;
        if (todayRecord && !clockingOutNow) return;

        borderlineStreakRef.current = 0;

        const timer = setInterval(async () => {
            if (faceScanBusyRef.current || !webcamVideoRef.current) return;
            faceScanBusyRef.current = true;

            try {
                // Any tick that completes without throwing means detection is healthy again.
                scanFailureStreakRef.current = 0;

                // 🟩 CORRECTED: Calls your deep yolo/faceapi abstraction layer wrapper directly
                const inferenceStartedAt = performance.now();
                const liveDet = await detectFaceFromImage(webcamVideoRef.current);
                latencyMonitorRef.current.record(performance.now() - inferenceStartedAt);
                const latencyStats = latencyMonitorRef.current.getStats();
                if (latencyStats.ready) {
                    // 🟩 DYNAMIC EDGE DOWNGRADE: a circuit breaker, not a
                    // toggle -- once the device has sustainedly proven it
                    // can't keep up, stays downgraded for the rest of the
                    // session rather than flip-flopping back on the moment
                    // one average dips back under budget (which would just
                    // reproduce the same lag again next tick).
                    if (latencyStats.isOverBudget) dynamicYoloDisableRef.current = true;
                    setSensorDiagnostics((prev) => (prev.latencyReady === latencyStats.ready && prev.latencyOverBudget === latencyStats.isOverBudget && prev.avgLatencyMs === Math.round(latencyStats.avgMs)
                        ? prev
                        : { ...prev, latencyReady: latencyStats.ready, latencyOverBudget: latencyStats.isOverBudget, avgLatencyMs: Math.round(latencyStats.avgMs) }));
                }

                if (liveDet) {
                    const imageWidth = webcamVideoRef.current.videoWidth;
                    const imageHeight = webcamVideoRef.current.videoHeight;

                    // Update bounding box positions for visual injection
                    if (liveDet.box) {
                        setFaceOverlayBox({
                            ...liveDet.box,
                            imageWidth,
                            imageHeight,
                            source: liveDet.source
                        });

                        // 🟩 NEW: mandatory frame-to-frame face-box motion
                        // signal -- see vision/boxMotionHeuristic.js for the
                        // full rationale and its documented limitation.
                        boxMotionTrackerRef.current.addSample(calculateBoxShiftRatio(prevFaceBoxForMotionRef.current, liveDet.box));
                        prevFaceBoxForMotionRef.current = liveDet.box;
                    }

                    // 🟩 NEW: eye boxes update every tick regardless of the
                    // quality/liveness gates below -- shows the blink is
                    // being SEEN in real time, not just once the challenge
                    // logic has already accepted it.
                    const eyeGeometry = liveDet.landmarks ? calculateEyeBoxes(liveDet.landmarks) : null;
                    if (eyeGeometry) {
                        setEyeBoxes({
                            left: { ...eyeGeometry.left, imageWidth, imageHeight },
                            right: { ...eyeGeometry.right, imageWidth, imageHeight },
                            leftClosed: isEyeClosed(liveDet.landmarks.getLeftEye()),
                            rightClosed: isEyeClosed(liveDet.landmarks.getRightEye()),
                        });
                    } else {
                        setEyeBoxes(null);
                    }

                    // 🟩 QUALITY GATES: framing/size, single-face, lighting, and
                    // detector-confidence (occlusion proxy) are all checked BEFORE
                    // trusting a match — a low-quality read shouldn't silently
                    // count toward liveness or clock-in either way.
                    let brightness = { ok: true, reason: null };
                    let lensObstruction = { ok: true, reason: null };
                    if (liveDet.box && liveDet.sourceCanvas) {
                        try {
                            const ctx = liveDet.sourceCanvas.getContext('2d');
                            const region = ctx.getImageData(liveDet.box.x, liveDet.box.y, liveDet.box.width, liveDet.box.height);
                            brightness = checkBrightness(region.data);

                            // 🟩 MICRO-MOTION LIVENESS: feeds the already-fetched face
                            // region into the pixel-variance tracker every tick a face is
                            // visible, independent of whether it ends up matching -- by the
                            // time a match is confirmed a few ticks later, the tracker's
                            // rolling window is already warm instead of starting cold.
                            microMotionTrackerRef.current.addFrame(region.data, liveDet.box.width, liveDet.box.height);
                            const microMotionTickStats = microMotionTrackerRef.current.getStats();
                            setSensorDiagnostics((prev) => (prev.microMotionReady === microMotionTickStats.ready && prev.microMotionStable === !microMotionTickStats.isSuspiciouslyFlat
                                ? prev
                                : { ...prev, microMotionReady: microMotionTickStats.ready, microMotionStable: !microMotionTickStats.isSuspiciouslyFlat }));

                            // 🟩 COLOR LIVENESS: a shaken printed photo or a phone waved
                            // around in front of the camera can pass the motion-based
                            // checks above (it's genuinely moving) -- this is a single-
                            // frame, motion-independent check of whether the sampled color
                            // actually looks like real skin with real spatial texture, not
                            // print ink or a screen's color reproduction. Runs every tick
                            // it's cheap enough for (stride-sampled, no extra canvas read).
                            const colorLiveness = checkColorLiveness(region.data, liveDet.box.width, liveDet.box.height);
                            latestColorLivenessRef.current = colorLiveness;
                            setSensorDiagnostics((prev) => (prev.colorPlausible === !colorLiveness.suspicious
                                ? prev
                                : { ...prev, colorPlausible: !colorLiveness.suspicious }));

                            // 🟩 LOW-LIGHT MITIGATION: 3 consecutive dark reads (not just
                            // one noisy frame) before reacting — flips on the enhancement
                            // filter for the *next* capture and, where the device exposes
                            // a torch, turns it on. Recovers the same way in reverse.
                            const LOW_LIGHT_STREAK_THRESHOLD = 3;
                            if (brightness.reason === 'too-dark') {
                                lowLightStreakRef.current += 1;
                                if (lowLightStreakRef.current >= LOW_LIGHT_STREAK_THRESHOLD && !isLowLightRef.current) {
                                    isLowLightRef.current = true;
                                    if (webcamStreamRef.current && isTorchSupported(webcamStreamRef.current)) {
                                        setTorch(webcamStreamRef.current, true).then((ok) => ok && setTorchActive(true));
                                    }
                                }
                            } else if (isLowLightRef.current) {
                                lowLightStreakRef.current = 0;
                                isLowLightRef.current = false;
                                if (webcamStreamRef.current) {
                                    setTorch(webcamStreamRef.current, false).then(() => setTorchActive(false));
                                }
                            } else {
                                lowLightStreakRef.current = 0;
                            }

                            // 🟩 LENS FOG/DIRT DETECTION: sampled across the *whole* frame
                            // (not just the face box) — a fogged or smudged lens blurs
                            // the background too, which is what distinguishes it from a
                            // face that's merely soft-focused or backlit. A dirty lens is
                            // a slow-changing physical condition (doesn't appear/clear
                            // within one 1.2s tick), so the full-frame getImageData + scan
                            // only actually runs every Nth tick instead of every single
                            // one — the cached verdict is reused in between, cutting this
                            // check's CPU cost by ~80% for the same responsiveness.
                            lensCheckTickRef.current += 1;
                            if (lensCheckTickRef.current % LENS_CHECK_INTERVAL_TICKS === 0) {
                                const fullFrame = ctx.getImageData(0, 0, liveDet.sourceCanvas.width, liveDet.sourceCanvas.height);
                                const lensCheckResult = checkLensObstruction(fullFrame.data, liveDet.sourceCanvas.width, liveDet.sourceCanvas.height);
                                // 🟩 BUG FIX: reported live -- a genuinely clean webcam
                                // got flagged "camera lens looks foggy or dirty" and
                                // blocked from scanning entirely, even after the
                                // percentile-based sharpness fix. One-off causes (autofocus
                                // hunting, a motion-blurred frame right as the user leans
                                // in for clock-out) can still land a single real recheck
                                // below the threshold — a physically dirty/fogged lens
                                // (the thing this is actually meant to catch) stays
                                // obstructed on every recheck, so requiring 2 CONSECUTIVE
                                // real (non-cached) failures before blocking filters out
                                // the one-off case without giving up on the real one.
                                lensObstructedStreakRef.current = lensCheckResult.ok ? 0 : lensObstructedStreakRef.current + 1;
                                lensObstruction = lensObstructedStreakRef.current >= 2 ? lensCheckResult : { ok: true, reason: null };
                                cachedLensResultRef.current = lensObstruction;
                                // Diagnostics readout only — setState bails out for free when
                                // the value hasn't actually changed (same object reference).
                                setSensorDiagnostics((prev) => (prev.lensClear === lensObstruction.ok ? prev : { ...prev, lensClear: lensObstruction.ok }));
                            } else {
                                lensObstruction = cachedLensResultRef.current;
                            }
                        } catch (_err) {
                            // getImageData can throw on a tainted canvas in some browsers — skip the check, don't crash the loop.
                        }
                    }
                    const framing = checkFraming(liveDet.box, imageWidth, imageHeight);
                    const singleFace = checkSingleFace(liveDet.faceCount ?? 1, liveDet.isAmbiguous);
                    const occlusion = checkOcclusion(liveDet.detection?.score);
                    const qualityIssue = !singleFace.ok ? singleFace : !framing.ok ? framing : !brightness.ok ? brightness : !lensObstruction.ok ? lensObstruction : !occlusion.ok ? occlusion : null;

                    // 🟩 BUG FIX: closing your eyes mid-blink is itself a
                    // transient partial-occlusion pattern -- the detector's
                    // confidence score can dip below checkOcclusion's
                    // threshold for exactly the one frame a blink
                    // transition needed to be seen. Bailing out on that
                    // single tick meant the state machine below never
                    // even got a chance to register "eyes closed," so a
                    // real blink could look completely invisible to it.
                    // Debounced like the low-light streak above -- only
                    // this specific reason gets tolerance (a genuinely
                    // absent/badly-framed/multi-face frame should still
                    // stop processing immediately, same as before).
                    let qualityIssueTolerated = false;
                    if (qualityIssue) {
                        if (qualityIssue.reason === 'low-confidence' && qualityIssueStreakRef.current < 2) {
                            qualityIssueStreakRef.current += 1;
                            qualityIssueTolerated = true;
                        }
                    }

                    // 🟩 READINESS BAR: same gates the pass/fail check above uses,
                    // just turned into a 0-100 score for the visual bar instead of
                    // a hard cutoff -- so the user sees themself approaching "green"
                    // rather than a flat "scanning..." message the whole time.
                    // occlusion is smoothed by the same tolerance above so the bar
                    // doesn't visibly jitter on a blink-shaped confidence dip that
                    // nothing else is reacting to either.
                    setScanReadiness(calculateFrameReadiness({
                        singleFace: singleFace.ok,
                        framing: framing.ok,
                        brightness: brightness.ok,
                        lensObstruction: lensObstruction.ok,
                        occlusion: occlusion.ok || qualityIssueTolerated
                    }));

                    if (qualityIssue) {
                        if (qualityIssueTolerated) {
                            // fall through -- tolerated, keep scanning below
                        } else {
                            setIsFaceVerified(false);
                            setBiometricStatus(t(QUALITY_HINT_KEYS[qualityIssue.reason] || 'attendance.statusScanning'));
                            faceScanBusyRef.current = false;
                            return;
                        }
                    } else {
                        qualityIssueStreakRef.current = 0;
                    }

                    if (referenceDescriptorRef.current && referenceDescriptorRef.current.length > 0) {
                        // 🟩 MULTI-TEMPLATE MATCHING: compares against every angle
                        // captured at enrollment and keeps the best (lowest-distance)
                        // result — meaningfully more robust day-to-day than a single
                        // frontal snapshot (lighting, angle, expression all vary).
                        const { distance: dist } = matchAgainstTemplates(
                            liveDet.descriptor,
                            referenceDescriptorRef.current,
                            faceapiRef.current.euclideanDistance
                        );
                        // 🟩 ADAPTIVE THRESHOLD: personalizes the match cutoff per
                        // employee based on their own recent successful-match
                        // distances (see vision/descriptorStaleness.js) --
                        // strictly one-directional (can only loosen, capped at a
                        // small margin), so this can reduce false-reject friction
                        // for someone whose naturally higher variance keeps landing
                        // them near the fixed threshold, but can never make matching
                        // more permissive than that small cap or stricter than the
                        // global default.
                        const adaptiveThreshold = getAdaptiveThreshold(userProfile.id, FACE_MATCH_THRESHOLD);
                        const matchTier = classifyMatch(dist, adaptiveThreshold);
                        setFaceMatchDistance(dist);
                        setFaceDetectionMode(liveDet.source || 'faceapi');

                        // Both confident and borderline distances count as a match —
                        // the liveness challenge below is the real extra confirmation
                        // step, so this doesn't also need its own multi-read delay.
                        const isMatch = matchTier !== 'no-match';
                        borderlineStreakRef.current = 0;

                        setFaceStatus(isMatch ? 'matched' : 'mismatch');
                        // 🟩 FIX: isFaceVerified was read by the manual "Clock In Shift"
                        // button but its setter was never called anywhere, so the
                        // button stayed permanently disabled regardless of match status.
                        setIsFaceVerified(isMatch);

                        if (isMatch) {
                            // 🟩 LIVENESS: two independent layers, not one.
                            // 1) A mandatory, deliberate blink challenge -- the
                            //    PRIMARY signal (see the reordering comment
                            //    inside the try block below). A static photo
                            //    literally cannot blink twice on request.
                            // 2) Passive, no-action-required signals -- border-
                            //    texture uniformity (checkReplaySuspicion), the
                            //    device accelerometer where available
                            //    (motionTrackerRef -- phones/tablets only),
                            //    pixel-level micro-motion (microMotionTrackerRef
                            //    -- any camera), motion-INDEPENDENT color/
                            //    texture plausibility (colorLivenessHeuristic),
                            //    and edge-sharpness (textureSharpnessHeuristic)
                            //    -- combined by majority VOTE (vision/
                            //    livenessFusion.js). Still runs WHILE the blink
                            //    challenge is pending (catches a spoofing
                            //    attempt before it ever blinks), but real-user
                            //    reports of it false-tripping mid-blink meant
                            //    it no longer gates the clock-in once the
                            //    challenge is actually confirmed.
                            const guardRef = clockingOutNow ? clockOutGuardRef : autoClockInGuardRef;
                            // 🟩 BUG FIX: this was the one place in the file
                            // that checked `work_mode === 'WFO'` (exact
                            // match) instead of the `(work_mode || 'WFO')
                            // === 'WFO'` fail-safe pattern used everywhere
                            // else (lines 555, 571, 651, 1503, 1938...) --
                            // any value other than the literal string 'WFO'
                            // (null/undefined, or an unvalidated CSV-import
                            // value like "Onsite") skipped the geofence
                            // block entirely instead of requiring it.
                            // 🟩 REVERTED (2026-08-16): supervisors are
                            // exempt from the geofence unconditionally again
                            // -- see the geofence-effect comment above for why.
                            if (!clockingOutNow && userProfile.role !== 'supervisor' && (userProfile.work_mode || 'WFO') === 'WFO' && !isInRange) {
                                setBiometricStatus(t('attendance.statusAccessDenied'));
                            } else if (!guardRef.current) {
                                let livenessSuspicious = false;
                                let challengeConfirmed = false;
                                let handCheck = { suspicious: false };
                                let handEdgeCheck = { suspicious: false };
                                let deviceEdgeCheck = { suspicious: false };
                                let screenGlareCheck = { suspicious: false };
                                let pulseStats = { ready: false };
                                try {
                                    const ctx = liveDet.sourceCanvas.getContext('2d');
                                    // 🟩 rPPG: fed by the separate fast sampling loop above (see
                                    // "PULSE SAMPLING LOOP") -- only counts as a vote once its
                                    // buffer has actually accumulated enough of a window to make
                                    // a call either way (~2s), same "don't vote on an incomplete
                                    // read" treatment as the device/pixel-motion trackers. Always
                                    // computed (cheap stat read, no canvas work) since the
                                    // mandatory pulse gate further below needs it either way.
                                    pulseStats = pulseDetectorRef.current.getStats();

                                    // 🟩 SIMPLIFIED (2026-08-12): same reordering as
                                    // LoginPage.jsx -- the deliberate blink challenge is
                                    // evaluated FIRST and is the PRIMARY liveness signal.
                                    if (livenessChallengeRef.current.isExpired()) {
                                        livenessChallengeRef.current.reset();
                                    }
                                    challengeConfirmed = livenessChallengeRef.current.registerFrame(liveDet.landmarks);

                                    // 🟩 SECURITY FIX (reported live): this used to only run
                                    // (and only ever block/reset) while `!challengeConfirmed`
                                    // -- meaning the exact tick where the blink challenge
                                    // FINALLY confirms was never checked for a hand/phone/
                                    // device-edge in frame at all, since that's precisely the
                                    // tick someone spoofing would still be holding the thing
                                    // up. Now runs every tick regardless; the existing
                                    // debounce below (passiveSuspicionStreakRef, unchanged)
                                    // still tolerates a single blink-transition false trip the
                                    // same as before -- this only closes the "never even
                                    // looked" gap on a SUSTAINED hand/phone/device-edge signal.
                                    {
                                        const marginX = Math.round(liveDet.box.width * 0.15);
                                        const marginY = Math.round(liveDet.box.height * 0.15);
                                        const borderRegion = ctx.getImageData(
                                            Math.max(0, liveDet.box.x - marginX),
                                            Math.max(0, liveDet.box.y - marginY),
                                            liveDet.box.width + marginX * 2,
                                            liveDet.box.height + marginY * 2
                                        );
                                        const borderSuspicious = checkReplaySuspicion(borderRegion.data).suspicious;
                                        const deviceMotionStats = motionTrackerRef.current.getStats();
                                        const microMotionStats = microMotionTrackerRef.current.getStats();
                                        const deviceFlat = deviceMotionStats.ready && deviceMotionStats.isSuspiciouslyFlat;
                                        const pixelFlat = microMotionStats.ready && microMotionStats.isSuspiciouslyFlat;
                                        const colorSuspicious = latestColorLivenessRef.current.suspicious;
                                        const textureSuspicious = checkTextureSharpness(borderRegion.data, borderRegion.width, borderRegion.height).suspicious;
                                        const pulseSuspicious = pulseStats.ready && !pulseStats.hasPlausiblePulse;
                                        // 🟩 SECURITY: hand/device-edge checks -- see
                                        // vision/handRegionHeuristic.js and vision/deviceEdgeHeuristic.js.
                                        deviceEdgeCheck = checkDeviceEdges(borderRegion.data, borderRegion.width, borderRegion.height);
                                        const fullFrame = ctx.getImageData(0, 0, liveDet.sourceCanvas.width, liveDet.sourceCanvas.height);
                                        handCheck = checkHandInFrame(fullFrame.data, liveDet.sourceCanvas.width, liveDet.sourceCanvas.height, liveDet.box);
                                        // 🟩 SECURITY FIX (reported live): checkHandInFrame's
                                        // surround band only reaches a modest margin past the
                                        // face box itself -- misses fingers gripping a phone/
                                        // photo near the outer edges of the whole camera frame,
                                        // especially once the "face" it matched is actually a
                                        // small photo on that phone's screen (its own margin
                                        // shrinks along with it). See handRegionHeuristic.js's
                                        // own comment on why this samples a DIFFERENT region.
                                        handEdgeCheck = checkHandNearFrameEdges(fullFrame.data, liveDet.sourceCanvas.width, liveDet.sourceCanvas.height, liveDet.box);
                                        // 🟩 SECURITY: a phone/tablet screen displaying a photo
                                        // EMITS its own backlight, unlike real skin (or a printed
                                        // photo) which only ever reflects ambient room light -- see
                                        // vision/screenGlareHeuristic.js.
                                        screenGlareCheck = checkScreenGlare(fullFrame.data, liveDet.sourceCanvas.width, liveDet.sourceCanvas.height, liveDet.box);

                                        setSensorDiagnostics((prev) => (prev.motionReady === deviceMotionStats.ready && prev.motionStable === !deviceMotionStats.isSuspiciouslyFlat
                                            && prev.microMotionReady === microMotionStats.ready && prev.microMotionStable === !microMotionStats.isSuspiciouslyFlat
                                            ? prev
                                            : {
                                                ...prev,
                                                motionReady: deviceMotionStats.ready,
                                                motionStable: !deviceMotionStats.isSuspiciouslyFlat,
                                                microMotionReady: microMotionStats.ready,
                                                microMotionStable: !microMotionStats.isSuspiciouslyFlat,
                                            }));

                                        livenessSuspicious = evaluatePassiveLiveness({
                                            borderUniform: borderSuspicious,
                                            deviceFlat: deviceMotionStats.ready ? deviceFlat : null,
                                            pixelFlat: microMotionStats.ready ? pixelFlat : null,
                                            colorSuspicious,
                                            textureFlat: textureSuspicious,
                                            deviceEdgeSuspicious: deviceEdgeCheck.suspicious,
                                            handSuspicious: handCheck.suspicious,
                                            handEdgeSuspicious: handEdgeCheck.suspicious,
                                            screenGlareSuspicious: screenGlareCheck.suspicious,
                                            pulseSuspicious: pulseStats.ready ? pulseSuspicious : null,
                                        }).suspicious;
                                    }
                                } catch (_err) {
                                    // Non-critical signal — a read failure (tainted canvas, out-of-bounds region) shouldn't block a real clock-in.
                                }

                                // 🟩 BUG FIX: a blink's closing eyelid/eyelash creates a
                                // brief, real luminance edge right in the border region this
                                // samples -- easily mistaken for deviceEdgeSuspicious (or
                                // nudging color/texture past their own thresholds) for
                                // exactly the one frame a blink transition needed.
                                // 🟩 LOOSENED FURTHER (2026-08-12, real-user report): holding
                                // still to blink deliberately on request reads as
                                // "suspiciously static" to the pixel-motion/border-uniformity
                                // checks, which want incidental fidgety motion as their OWN
                                // liveness signal -- directly in tension with "hold still and
                                // blink on cue." Since the deliberate blink challenge is
                                // already the PRIMARY liveness proof (a photo literally cannot
                                // blink on request), a much longer tolerance here costs little
                                // real security -- a genuine photo/replay still can never blink
                                // at all, so it can never progress past the challenge
                                // regardless of how long this tolerates. `treatAsSuspicious`
                                // (not the raw `livenessSuspicious`) drives every branch below
                                // so a tolerated blink-shaped blip can't fall through into the
                                // clock-in branch by accident. Pulse is no longer authoritative
                                // here either (see livenessFusion.js) -- every vote, including
                                // pulse, now shares the same debounce tolerance.
                                let treatAsSuspicious = false;
                                if (livenessSuspicious) {
                                    // 🟩 Lower raw tick count than LoginPage's equivalent (8) --
                                    // this view's scan interval (FACE_SCAN_INTERVAL_MS, 1.8s) is
                                    // already ~5x slower per tick than Login's (350ms), so the
                                    // same wall-clock tolerance needs proportionally fewer ticks.
                                    if (passiveSuspicionStreakRef.current < 3) {
                                        passiveSuspicionStreakRef.current += 1;
                                    } else {
                                        passiveSuspicionStreakRef.current = 0;
                                        treatAsSuspicious = true;
                                    }
                                } else {
                                    passiveSuspicionStreakRef.current = 0;
                                }

                                const motionStats = boxMotionTrackerRef.current.getStats();
                                const motionOk = motionStats.ready && motionStats.hasNaturalMovement && !motionStats.isErratic;

                                if (treatAsSuspicious) {
                                    // Don't lock in or clock in this tick -- keep scanning. A
                                    // live person's signals normally clear within a tick or
                                    // two as the rolling window updates; a genuine static
                                    // replay stays flagged indefinitely instead of ever
                                    // sneaking through.
                                    livenessChallengeRef.current.reset();
                                    setChallengeGlyph(null);
                                    setBiometricStatus(t((handCheck.suspicious || handEdgeCheck.suspicious) ? 'attendance.statusHandDetected' : deviceEdgeCheck.suspicious ? 'attendance.statusDeviceDetected' : screenGlareCheck.suspicious ? 'attendance.statusScreenDetected' : 'attendance.statusLivenessSuspicious'));
                                    toast(t('attendance.antiReplayWarning'), { icon: '⚠️' });
                                } else if (livenessSuspicious) {
                                    // Tolerated (within debounce) -- nothing is reset and no
                                    // alarming message shown; just wait for the next tick.
                                } else if (!challengeConfirmed) {
                                    const suffix = CHALLENGE_INSTRUCTION_SUFFIX[livenessChallengeRef.current.challengeType];
                                    setChallengeGlyph(CHALLENGE_DIRECTION_GLYPH[livenessChallengeRef.current.challengeType]);
                                    setBiometricStatus(t(`attendance.statusAwaiting${suffix}`, {
                                        step: livenessChallengeRef.current.stepIndex + 1,
                                        totalSteps: livenessChallengeRef.current.totalSteps,
                                    }));
                                } else if (!motionOk) {
                                    // 🟩 SECURITY (2026-08-12): mandatory frame-to-frame face-box
                                    // motion gate, replacing the old mandatory rPPG pulse gate --
                                    // see vision/boxMotionHeuristic.js for the full rationale and
                                    // its documented limitation (a hand-held photo also wobbles;
                                    // this is a SUPPLEMENT to the blink challenge, not a
                                    // replacement for it). The challenge stays confirmed
                                    // (registerFrame caches it, won't re-prompt) -- this tick
                                    // just waits for the motion window to fill/settle.
                                    setBiometricStatus(t('attendance.statusAwaitingMotion'));
                                } else {
                                    guardRef.current = true;
                                    livenessChallengeRef.current.reset();
                                    pulseDetectorRef.current.reset();
                                    boxMotionTrackerRef.current.reset();
                                    prevFaceBoxForMotionRef.current = null;
                                    setChallengeGlyph(null);
                                    clearInterval(timer);

                                    if (clockingOutNow) {
                                        setBiometricStatus(t('attendance.statusClockOutVerified'));
                                        const clockOutOk = await handleClockOut();
                                        setIsClockingOut(false);
                                        // 🟩 BUG FIX: guardRef was set to `true` above and never reset
                                        // on failure -- a failed clock-out (network blip, DB error)
                                        // left clockOutGuardRef permanently `true`, so re-arming
                                        // clock-out later would silently never trigger again (the
                                        // `!guardRef.current` check above would just always be false)
                                        // with zero explanation to the user. handleClockOut already
                                        // returns a boolean for exactly this purpose.
                                        if (!clockOutOk) {
                                            guardRef.current = false;
                                        }
                                    } else {
                                        setBiometricStatus(t('attendance.statusMatchVerified'));

                                        // 🟩 STALENESS REMINDER: track whether recent matches keep
                                        // coming in close to the threshold rather than confidently.
                                        const staleness = recordMatchDistance(userProfile.id, dist, adaptiveThreshold);
                                        if (staleness.shouldSuggestReEnrollment) {
                                            toast(t('attendance.reEnrollSuggestion'), { icon: '🔄', duration: 6000 });
                                        }

                                        reportDeviceHealthSnapshot();
                                        const clockInOk = await handleClockIn('face-match');
                                        // 🟩 BUG FIX: same as clock-out above, but this one was worse
                                        // for clock-in -- `faceStatus` was set to 'matched' a few lines
                                        // above and `todayRecord` stays undefined on failure, so
                                        // resetting faceStatus back to 'scanning' alone is NOT reliable:
                                        // both the 'matched' and 'scanning' writes land in the same
                                        // state-update batch, and React bails out of re-rendering (so
                                        // the scan-loop effect never re-runs) when a state variable's
                                        // net value across a batch is unchanged -- which "scanning" ->
                                        // "matched" -> "scanning" is, from React's point of view.
                                        // clockInRetryNonce (a plain incrementing counter, immune to
                                        // that collapse-to-no-op case) is what actually, reliably
                                        // forces the effect to re-run and spin up a fresh interval.
                                        if (!clockInOk) {
                                            guardRef.current = false;
                                            setFaceStatus('scanning');
                                            setClockInRetryNonce((n) => n + 1);
                                        }
                                    }
                                }
                            }
                        } else {
                            livenessChallengeRef.current.reset(); // not the enrolled face -- don't let a stray blink count toward a different person's clock-in
                            pulseDetectorRef.current.reset(); // don't mix pulse samples across different faces either
                            setChallengeGlyph(null);
                            const bucketExhausted = !mismatchBucketRef.current.tryConsume();
                            setBiometricStatus(bucketExhausted ? t('attendance.statusTooManyAttempts') : t('attendance.statusNotRecognized'));
                        }
                    }
                } else {
                    setFaceOverlayBox(null);
                    setEyeBoxes(null);
                    setFaceMatchDistance(null);
                    setIsFaceVerified(false);
                    setScanReadiness(0);
                    microMotionTrackerRef.current.reset(); // face gone -- don't compare the next face's frames against a stale/unrelated buffer
                    boxMotionTrackerRef.current.reset();
                    prevFaceBoxForMotionRef.current = null;
                    latestColorLivenessRef.current = { suspicious: false };
                    livenessChallengeRef.current.reset();
                    pulseDetectorRef.current.reset();
                    setChallengeGlyph(null);
                    setBiometricStatus(t('attendance.statusScanning'));
                }
            } catch (err) {
                console.error(err);
                // 🟩 MITIGATION: a repeatedly-throwing scan loop (WebGL
                // context lost, tab backgrounded/restored in a bad state,
                // out-of-memory) previously failed completely silently --
                // console-only, the scan panel just sitting frozen with no
                // explanation. Surface it after a sustained run of failures
                // (not a single blip) instead of staying quiet forever.
                scanFailureStreakRef.current += 1;
                if (scanFailureStreakRef.current >= 5) {
                    setBiometricStatus(t('attendance.statusScanRepeatedlyFailing'));
                }
            }
            faceScanBusyRef.current = false;
        }, 1200);

        return () => {
            clearInterval(timer);
            setFaceOverlayBox(null);
            setEyeBoxes(null);
        };
        // Intentional: detectFaceFromImage and handleClockIn are redefined every
        // render (not memoized), so listing them here would tear down and
        // recreate the scan interval on every render instead of letting it run
        // steadily. userProfile.work_mode is read fresh via closure each tick;
        // work_mode changes are rare enough that a full remount isn't needed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isCameraReady, scanEligible, isInRange, todayRecord, disableYolo, isTabVisible, isClockingOut, isTestScanning, clockInRetryNonce]);

    // ==========================================
    // PART 2: TEST BIOMETRIC SCAN LOOP
    // Independent orchestration of the SAME detection functions the real
    // clock-in/out loop above uses (detectFaceFromImage, matchAgainstTemplates,
    // evaluatePassiveLiveness, calculateBoxShiftRatio) -- genuinely the same
    // pipeline, not a mock -- but with its own liveness-challenge/box-motion
    // tracker instances and NO call anywhere in this effect to performClockIn,
    // performClockOut, handleClockIn, handleClockOut, or any repository/
    // notification/webhook. Concludes with a pass/fail + reason instead of
    // running forever, bounded by TEST_SCAN_TIMEOUT_MS.
    // ==========================================
    useEffect(() => {
        if (!isTestScanning || !isCameraReady || !isTabVisible) return;

        testScanStartedAtRef.current = Date.now();
        let lastBlockReason = 'no-face';

        const timer = setInterval(async () => {
            if (testScanBusyRef.current || !webcamVideoRef.current) return;
            testScanBusyRef.current = true;

            try {
                if (Date.now() - testScanStartedAtRef.current > TEST_SCAN_TIMEOUT_MS) {
                    clearInterval(timer);
                    setTestScanResult({ status: 'fail', reason: lastBlockReason });
                    setIsTestScanning(false);
                    return;
                }

                const liveDet = await detectFaceFromImage(webcamVideoRef.current);
                if (!liveDet || !liveDet.box) {
                    lastBlockReason = 'no-face';
                    setFaceOverlayBox(null);
                    setEyeBoxes(null);
                    setChallengeGlyph(null);
                    setBiometricStatus(t('attendance.statusScanning'));
                    return;
                }

                const imageWidth = webcamVideoRef.current.videoWidth;
                const imageHeight = webcamVideoRef.current.videoHeight;

                // 🟩 BUG FIX: draw the same live face/eye boxes the real
                // clock-in/out loop draws, unconditional on the quality/
                // match/liveness gates below -- Test Mode previously never
                // touched these at all, so the panel showed nothing (or a
                // stale box from before the test started) for the entire
                // scan. Same "update every tick regardless of gates"
                // treatment as the main loop's own comment on eye boxes.
                setFaceOverlayBox({ ...liveDet.box, imageWidth, imageHeight, source: liveDet.source });
                const eyeGeometry = liveDet.landmarks ? calculateEyeBoxes(liveDet.landmarks) : null;
                setEyeBoxes(eyeGeometry ? {
                    left: { ...eyeGeometry.left, imageWidth, imageHeight },
                    right: { ...eyeGeometry.right, imageWidth, imageHeight },
                    leftClosed: isEyeClosed(liveDet.landmarks.getLeftEye()),
                    rightClosed: isEyeClosed(liveDet.landmarks.getRightEye()),
                } : null);

                const framing = checkFraming(liveDet.box, imageWidth, imageHeight);
                const singleFace = checkSingleFace(liveDet.faceCount ?? 1, liveDet.isAmbiguous);
                const occlusion = checkOcclusion(liveDet.detection?.score);
                if (!singleFace.ok || !framing.ok || !occlusion.ok) {
                    lastBlockReason = 'poor-quality';
                    setChallengeGlyph(null);
                    setBiometricStatus(t('attendance.statusScanning'));
                    return;
                }

                testBoxMotionTrackerRef.current.addSample(calculateBoxShiftRatio(testPrevFaceBoxRef.current, liveDet.box));
                testPrevFaceBoxRef.current = liveDet.box;

                if (!referenceDescriptorRef.current || referenceDescriptorRef.current.length === 0) {
                    lastBlockReason = 'no-enrolled-face';
                    setChallengeGlyph(null);
                    setBiometricStatus(t('attendance.statusScanning'));
                    return;
                }

                const { distance: dist } = matchAgainstTemplates(liveDet.descriptor, referenceDescriptorRef.current, faceapiRef.current.euclideanDistance);
                const adaptiveThreshold = getAdaptiveThreshold(userProfile.id, FACE_MATCH_THRESHOLD);
                if (classifyMatch(dist, adaptiveThreshold) === 'no-match') {
                    lastBlockReason = 'no-match';
                    setChallengeGlyph(null);
                    setBiometricStatus(t('attendance.statusScanning'));
                    return;
                }

                if (testLivenessChallengeRef.current.isExpired()) {
                    testLivenessChallengeRef.current.reset();
                }
                const challengeConfirmed = testLivenessChallengeRef.current.registerFrame(liveDet.landmarks);
                if (!challengeConfirmed) {
                    lastBlockReason = 'no-blink';
                    const suffix = CHALLENGE_INSTRUCTION_SUFFIX[testLivenessChallengeRef.current.challengeType];
                    setChallengeGlyph(CHALLENGE_DIRECTION_GLYPH[testLivenessChallengeRef.current.challengeType]);
                    setBiometricStatus(t(`attendance.statusAwaiting${suffix}`, {
                        step: testLivenessChallengeRef.current.stepIndex + 1,
                        totalSteps: testLivenessChallengeRef.current.steps,
                    }));
                    return;
                }
                setChallengeGlyph(null);
                setBiometricStatus(t('attendance.statusMatchVerified'));

                // 🟩 Passive fusion vote reuses the SAME rolling trackers the
                // real loop feeds (motionTrackerRef/microMotionTrackerRef/
                // latestColorLivenessRef/pulseDetectorRef) -- these are pure
                // signal accumulators with no attendance side effects, safe
                // to share; only the ACTIVE challenge/box-motion state that
                // directly gates a real clock-in stays test-scoped above.
                let ctx = null;
                try { ctx = liveDet.sourceCanvas?.getContext('2d'); } catch { /* tainted canvas -- skip passive read */ }
                if (ctx) {
                    const marginX = Math.round(liveDet.box.width * 0.15);
                    const marginY = Math.round(liveDet.box.height * 0.15);
                    const borderRegion = ctx.getImageData(
                        Math.max(0, liveDet.box.x - marginX),
                        Math.max(0, liveDet.box.y - marginY),
                        liveDet.box.width + marginX * 2,
                        liveDet.box.height + marginY * 2
                    );
                    const deviceMotionStats = motionTrackerRef.current.getStats();
                    const microMotionStats = microMotionTrackerRef.current.getStats();
                    const pulseStats = pulseDetectorRef.current.getStats();
                    // 🟩 BUG FIX: hand-in-frame was hardcoded to `false` here
                    // (never actually checked) instead of calling
                    // checkHandInFrame like the real clock-in/out loop does --
                    // Test Mode's whole point is validating the same pipeline
                    // a real scan runs, so a spoof someone holding a phone/
                    // photo up close would pass Test Mode clean while still
                    // getting (correctly) flagged by the real scan. Needs the
                    // FULL frame (not just the border region) same as the
                    // real loop, since it samples the band immediately
                    // surrounding the face box.
                    const fullFrame = ctx.getImageData(0, 0, liveDet.sourceCanvas.width, liveDet.sourceCanvas.height);
                    const handCheck = checkHandInFrame(fullFrame.data, liveDet.sourceCanvas.width, liveDet.sourceCanvas.height, liveDet.box);
                    const handEdgeCheck = checkHandNearFrameEdges(fullFrame.data, liveDet.sourceCanvas.width, liveDet.sourceCanvas.height, liveDet.box);
                    const screenGlareCheck = checkScreenGlare(fullFrame.data, liveDet.sourceCanvas.width, liveDet.sourceCanvas.height, liveDet.box);
                    const livenessSuspicious = evaluatePassiveLiveness({
                        borderUniform: checkReplaySuspicion(borderRegion.data).suspicious,
                        deviceFlat: deviceMotionStats.ready ? deviceMotionStats.isSuspiciouslyFlat : null,
                        pixelFlat: microMotionStats.ready ? microMotionStats.isSuspiciouslyFlat : null,
                        colorSuspicious: latestColorLivenessRef.current.suspicious,
                        textureFlat: checkTextureSharpness(borderRegion.data, borderRegion.width, borderRegion.height).suspicious,
                        deviceEdgeSuspicious: checkDeviceEdges(borderRegion.data, borderRegion.width, borderRegion.height).suspicious,
                        handSuspicious: handCheck.suspicious,
                        handEdgeSuspicious: handEdgeCheck.suspicious,
                        screenGlareSuspicious: screenGlareCheck.suspicious,
                        pulseSuspicious: pulseStats.ready ? !pulseStats.hasPlausiblePulse : null,
                    }).suspicious;
                    if (livenessSuspicious) {
                        lastBlockReason = 'liveness-suspicious';
                        testLivenessChallengeRef.current.reset();
                        return;
                    }
                }

                const motionStats = testBoxMotionTrackerRef.current.getStats();
                if (!motionStats.ready || !motionStats.hasNaturalMovement || motionStats.isErratic) {
                    lastBlockReason = 'no-motion';
                    return;
                }

                clearInterval(timer);
                setTestScanResult({ status: 'pass', reason: null });
                setIsTestScanning(false);
            } catch (err) {
                console.error('[attendance] test scan tick failed:', err);
            } finally {
                testScanBusyRef.current = false;
            }
        }, FACE_SCAN_INTERVAL_MS);

        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isTestScanning, isCameraReady, isTabVisible]);

    const handleStartTestScan = () => {
        if (isTestScanning || isClockingOut) return;
        if (cameraError) {
            setTestScanResult({ status: 'fail', reason: 'camera-error' });
            return;
        }
        if (!referenceDescriptorRef.current || referenceDescriptorRef.current.length === 0) {
            setTestScanResult({ status: 'fail', reason: 'no-enrolled-face' });
            return;
        }
        testLivenessChallengeRef.current = new RandomLivenessChallenge({ challengeType: CHALLENGE_TYPES.BLINK, steps: 1 });
        testBoxMotionTrackerRef.current = createBoxMotionTracker();
        testPrevFaceBoxRef.current = null;
        testScanBusyRef.current = false;
        setTestScanResult(null);
        // 🟩 BUG FIX: the main scan loop pauses entirely while Test Mode
        // runs (see its own `isTestScanning` guard above), so whatever
        // biometricStatus/challengeGlyph/faceOverlayBox/eyeBoxes it last
        // left on screen just stayed frozen there for the whole test --
        // reported live as a Test Scan showing an old, unrelated "blink"
        // prompt with no face/eye box the entire time. Same class of bug
        // as the clock-out stale-state fix above; start from a clean slate.
        setBiometricStatus(t('attendance.statusScanning'));
        setChallengeGlyph(null);
        setFaceOverlayBox(null);
        setEyeBoxes(null);
        setIsTestScanning(true);
    };

    const handleCancelTestScan = () => {
        setIsTestScanning(false);
        setTestScanResult(null);
        setBiometricStatus(t('attendance.statusScanning'));
        setChallengeGlyph(null);
        setFaceOverlayBox(null);
        setEyeBoxes(null);
    };

    // Keeps latestFaceBoxRef in sync with the box the main scan loop above
    // (or the enrollment loop below) just computed, so the fast pulse
    // sampling loop always reads a current box without restarting itself
    // every time it changes (see pulseDetectorRef's declaration comment).
    useEffect(() => {
        latestFaceBoxRef.current = faceOverlayBox;
    }, [faceOverlayBox]);

    // ==========================================
    // rPPG PULSE SAMPLING LOOP (~20Hz)
    // Deliberately separate from the ~1.2s main scan tick above -- resolving
    // a 42-210 BPM signal needs sampling well above that rate. Only reads a
    // small, already-known face-box crop (no face detection, no matching)
    // so it stays cheap enough to run continuously. Skipped on constrained
    // devices (same disableYolo signal the main loop already uses to shed
    // load). 🟩 PART 3: no longer skipped for supervisors -- they now run
    // the same scan loop employees do.
    // ==========================================
    useEffect(() => {
        if (!isCameraReady || !isTabVisible || disableYolo) return;

        const PULSE_SAMPLE_INTERVAL_MS = 50; // ~20Hz -- well above the Nyquist rate for a <=3.5Hz (210 BPM) signal
        const timer = setInterval(() => {
            const box = latestFaceBoxRef.current;
            const video = webcamVideoRef.current;
            if (!box || !video || video.readyState < 2) return;

            try {
                if (!pulseCanvasRef.current) {
                    pulseCanvasRef.current = document.createElement('canvas');
                    pulseCanvasRef.current.width = 24;
                    pulseCanvasRef.current.height = 24;
                }
                const canvas = pulseCanvasRef.current;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                // Center forehead/upper-cheek region of the box -- standard
                // rPPG ROI choice (large, relatively motion-still, well-
                // vascularized skin, avoids eyes/mouth movement artifacts).
                // The source-rectangle drawImage overload crops AND
                // downscales to the small canvas in one cheap GPU-backed call.
                const sx = box.x + box.width * 0.25;
                const sy = box.y + box.height * 0.15;
                const sw = box.width * 0.5;
                const sh = box.height * 0.3;
                if (sw <= 0 || sh <= 0) return;
                ctx.drawImage(video, sx, sy, sw, sh, 0, 0, 24, 24);
                const region = ctx.getImageData(0, 0, 24, 24);
                const avgGreen = calculateAverageGreenChannel(region.data);
                pulseDetectorRef.current.addSample(avgGreen, Date.now());

                const pulseStats = pulseDetectorRef.current.getStats();
                setSensorDiagnostics((prev) => (prev.pulseReady === pulseStats.ready && prev.pulsePlausible === pulseStats.hasPlausiblePulse && prev.pulseBpm === pulseStats.estimatedBpm
                    ? prev
                    : { ...prev, pulseReady: pulseStats.ready, pulsePlausible: pulseStats.hasPlausiblePulse, pulseBpm: pulseStats.estimatedBpm }));
            } catch (_err) {
                // getImageData can throw on a tainted canvas in some browsers -- non-critical signal, skip this tick.
            }
        }, PULSE_SAMPLE_INTERVAL_MS);

        return () => clearInterval(timer);
    }, [isCameraReady, isTabVisible, disableYolo, userProfile.role]);

    // ==========================================
    // MULTI-ANGLE ENROLLMENT WIZARD SCAN LOOP
    // Runs only while the wizard is active (enrollmentStepIndex >= 0),
    // separate from the main clock-in scan loop above. Just tracks
    // yaw/pitch and keeps the latest detection ready for the manual
    // "Capture" button — no matching, no liveness challenge, no clock-in.
    // ==========================================
    useEffect(() => {
        if (enrollmentStepIndex < 0 || !isCameraReady || !isTabVisible) return;

        const currentPose = ENROLLMENT_POSES[enrollmentStepIndex];
        const timer = setInterval(async () => {
            if (enrollmentScanBusyRef.current || !webcamVideoRef.current) return;
            enrollmentScanBusyRef.current = true;

            try {
                const det = await detectFaceFromImage(webcamVideoRef.current);
                if (det?.landmarks) {
                    const yaw = calculateHeadTurnRatio(det.landmarks);
                    const pitch = calculatePitchRatio(det.landmarks);
                    latestEnrollmentDetectionRef.current = det;
                    setEnrollmentPoseReading({ yaw, pitch, achieved: isPoseAchieved(currentPose, yaw, pitch) });
                    // 🟩 FACE BOX DURING ENROLLMENT: previously only the main
                    // clock-in loop drew the bounding box, so enrollment gave
                    // no visual confirmation a face was actually being seen —
                    // easy to mistake for "not scanning" when it was working.
                    if (det.box) {
                        setFaceOverlayBox({
                            ...det.box,
                            imageWidth: webcamVideoRef.current.videoWidth,
                            imageHeight: webcamVideoRef.current.videoHeight,
                            source: det.source
                        });
                    }
                } else {
                    latestEnrollmentDetectionRef.current = null;
                    setEnrollmentPoseReading({ yaw: 0, pitch: 0, achieved: false });
                    setFaceOverlayBox(null);
                }
            } catch (err) {
                console.error(err);
            }
            enrollmentScanBusyRef.current = false;
        }, 500);

        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enrollmentStepIndex, isCameraReady, isTabVisible]);

    // 🟩 AUTO-CAPTURE: once the readiness bar hits green (pose achieved),
    // capture automatically instead of waiting for a manual button press —
    // matches the "like a YouTube buffer bar" behavior asked for. Waits
    // briefly for the pose to hold steady first so a fleeting, jittery
    // "achieved" frame right at the threshold doesn't grab a blurry
    // mid-motion capture; if the pose slips back out of range before that,
    // the timer is cleared and nothing fires. The manual "Capture This
    // Angle" button is left in place as a fallback either way.
    useEffect(() => {
        if (enrollmentStepIndex < 0 || !enrollmentPoseReading.achieved || isEnrolling) return;
        const timer = setTimeout(() => {
            handleCaptureEnrollmentPose();
        }, 600);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enrollmentPoseReading.achieved, enrollmentStepIndex, isEnrolling]);

    // ==========================================
    // MATHEMATICAL MATRIX POSITION CALCULATOR
    // ==========================================
    const getFaceOverlayStyle = () => calculateFaceOverlayStyle({ box: faceOverlayBox, videoEl: webcamVideoRef.current });
    const getEyeOverlayStyle = (eyeBox) => calculateFaceOverlayStyle({ box: eyeBox, videoEl: webcamVideoRef.current });

    // 🟩 FLEET HEALTH: reports one snapshot of this session's already-
    // computed local diagnostics (see EdgeDiagnosticsPanel.jsx -- nothing
    // new is measured here, this just persists a summary of state that
    // already existed purely client-side) right at the moment a real
    // clock-in succeeds -- a natural "session summary" point, and avoids
    // spamming an insert every scan tick. Fire-and-forget: a reporting
    // failure must never block or surface as an error on top of a real
    // clock-in succeeding.
    const reportDeviceHealthSnapshot = () => {
        deviceHealthRepository.insert({
            employee_id: userProfile.id,
            avg_latency_ms: sensorDiagnostics.latencyReady ? sensorDiagnostics.avgLatencyMs : null,
            model_tier: (disableYolo || dynamicYoloDisableRef.current) ? 'reduced' : 'full',
            network_effective_type: networkBatteryDiagnostics.networkEffectiveType ?? null,
            is_slow_network: networkBatteryDiagnostics.isSlowNetwork ?? null,
            battery_level: networkBatteryDiagnostics.batteryLevel ?? null,
            is_charging: networkBatteryDiagnostics.isCharging ?? null,
            lens_clear: sensorDiagnostics.lensClear,
            motion_stable: sensorDiagnostics.microMotionReady ? sensorDiagnostics.microMotionStable : null,
            ambient_lux: sensorDiagnostics.ambientLux ?? null,
        }).catch((err) => console.error('reportDeviceHealthSnapshot failed:', err.message));
    };

    // 🟩 Delegates to domain/attendanceClockIn.js -- the same shared
    // transaction App.jsx's clock-in-on-login shortcut now also calls, so
    // the geofence gate, already-clocked-in guard, and server-clock-sourced
    // punctuality decision can never quietly drift between the two entry
    // points. This wrapper just owns the loading state and toast/i18n UI.
    const handleClockIn = async (source = 'manual') => {
        setIsLoading(true);
        try {
            const result = await performClockIn({ userProfile, coords: currentCoords, isInRange, today, source });

            if (!result.success) {
                switch (result.reason) {
                    case 'gps-waiting':
                        toast.error(t('attendance.gpsWaiting'));
                        break;
                    case 'out-of-range':
                        toast.error(t('attendance.geofenceRejection'));
                        break;
                    case 'already-clocked-in':
                        toast.error(t('attendance.alreadyClockedInToday'));
                        await fetchAttendance();
                        break;
                    case 'db-error':
                        showUserError('errors.recordAttendance', result.error);
                        break;
                    default:
                        break;
                }
                return false;
            }

            setClockInAt(result.time);
            setClockInSource(result.source);
            await fetchAttendance();
            return true;
        } finally {
            setIsLoading(false);
        }
    };

    // 🟩 Delegates to domain/attendanceClockIn.js's performClockOut -- see
    // that module's comment for why this used to be a raw inline update
    // (privacy: no location captured at clock-out) and is now shared with
    // the PIN clock-out path below instead of a second copy of it.
    const handleClockOut = async (source = 'face-match') => {
        setIsLoading(true);
        try {
            const result = await performClockOut({ attendanceRowId: todayRecord.id, source });
            if (!result.success) {
                showUserError('errors.recordAttendanceOut', result.error);
                return false;
            }
            await fetchAttendance();
            return true;
        } finally {
            setIsLoading(false);
        }
    };

    // --- PIN + GEOFENCE CLOCK-IN/OUT (camera-free alternative) ---
    // Reuses the exact same geofence verdict (isInRange) the face-scan flow
    // computes continuously above -- WFO still requires being physically in
    // range, WFH still bypasses it. Only the identity-verification step
    // differs (PIN instead of a live face match).
    const [showPinModal, setShowPinModal] = useState(false);
    const [pinInput, setPinInput] = useState('');
    const [isVerifyingPin, setIsVerifyingPin] = useState(false);

    const handlePinClockAction = async () => {
        if (!pinInput) return;
        setIsVerifyingPin(true);
        try {
            const rateLimit = await checkRateLimit('pin-clock-attempt', { maxRequests: 5, windowSeconds: 60 });
            if (!rateLimit.allowed) {
                toast.error(formatRateLimitMessage(rateLimit.retryAfterMs));
                return;
            }

            const { data: isValid, error: verifyError } = await supabase.rpc('verify_clock_pin', { pin: pinInput });
            if (verifyError) { showUserError('errors.verifyClockPin', verifyError); return; }
            if (!isValid) { toast.error(t('attendance.pinIncorrect')); return; }

            if (!todayRecord) {
                // 🟩 REVERTED (2026-08-16): supervisors are exempt from the
                // geofence unconditionally again -- see the geofence-effect
                // comment further up this file for why.
                const requiresLocationGate = userProfile.role !== 'supervisor' && (userProfile.work_mode || 'WFO') === 'WFO';
                if (requiresLocationGate && !isInRange) { toast.error(t('attendance.geofenceRejection')); return; }
                const result = await performClockIn({ userProfile, coords: currentCoords, isInRange, today, source: 'pin' });
                if (!result.success) {
                    if (result.reason === 'already-clocked-in') { toast.error(t('attendance.alreadyClockedInToday')); await fetchAttendance(); }
                    else showUserError('errors.recordAttendance', result.error);
                    return;
                }
                setClockInAt(result.time);
                setClockInSource('pin');
                toast.success(t('attendance.pinClockInSuccess'));
            } else if (!todayRecord.clock_out) {
                const result = await performClockOut({ attendanceRowId: todayRecord.id, source: 'pin' });
                if (!result.success) { showUserError('errors.recordAttendanceOut', result.error); return; }
                toast.success(t('attendance.pinClockOutSuccess'));
            } else {
                toast.error(t('attendance.alreadyClockedInToday'));
                return;
            }

            setPinInput('');
            setShowPinModal(false);
            await fetchAttendance();
        } finally {
            setIsVerifyingPin(false);
        }
    };

    const handleToggleWorkMode = async (employeeId, currentMode) => {
        const nextMode = currentMode === 'WFH' ? 'WFO' : 'WFH';
        await supabase.from('profiles').update({ work_mode: nextMode }).eq('id', employeeId);
        window.location.reload(); 
    };

    // 🟩 FIX + HARDENED: "View Map Location" previously did nothing visible
    // when the browser silently blocked the popup (no feedback at all --
    // reported as "the button just doesn't work") and never validated its
    // input. This is also the one place in the app that intentionally sends
    // an intern's precise coordinates to a third party (Google), so it's
    // treated carefully:
    //  - Access is already supervisor-only (this button only renders inside
    //    the supervisor's team table, gated at the JSX level above and
    //    backed by the attendance RLS policy server-side either way).
    //  - Coordinates are validated as real, in-range numbers before ever
    //    being sent anywhere -- corrupted/placeholder DB values (e.g. a
    //    stray "0,0") won't silently open a bogus, misleading map link.
    //  - `noopener,noreferrer` on the new tab: `noopener` closes the
    //    "tabnabbing" hole (the opened Google Maps tab can't reach back into
    //    this app via `window.opener`), and `noreferrer` stops this app's
    //    own URL from being sent to Google in the Referer header -- an
    //    unrelated-looking but real leak, since that URL alone can reveal
    //    which company/system is looking someone up.
    //  - If the popup still gets blocked, the user now gets an explicit
    //    error instead of a silently dead button.
    const openMap = (lat, lng) => {
        const latNum = Number(lat);
        const lngNum = Number(lng);
        const isValidCoord = Number.isFinite(latNum) && Number.isFinite(lngNum)
            && Math.abs(latNum) <= 90 && Math.abs(lngNum) <= 180
            && !(latNum === 0 && lngNum === 0); // (0,0) is "Null Island" -- always a bad/missing reading, never a real office or home

        if (!isValidCoord) {
            toast.error(t('attendance.mapLocationUnavailable'));
            return;
        }

        const mapWindow = window.open(
            `https://www.google.com/maps/search/?api=1&query=${latNum},${lngNum}`,
            '_blank',
            'noopener,noreferrer'
        );
        if (!mapWindow) {
            toast.error(t('attendance.mapPopupBlocked'));
        }
    };

    const FACE_CONSENT_KEY = `face_enrollment_consent_${userProfile.id}`;

    // 🟩 CONSENT GATE: face descriptors are sensitive biometric personal data —
    // require an explicit, informed opt-in the first time a user enrolls,
    // rather than silently capturing and storing it on first click.
    const handleEnrollFaceFromStream = () => {
        if (!webcamVideoRef.current || isEnrolling || enrollmentStepIndex >= 0) return;

        let hasConsented = false;
        try { hasConsented = localStorage.getItem(FACE_CONSENT_KEY) === 'true'; } catch { /* localStorage unavailable — treat as not yet consented */ }

        if (!hasConsented) {
            setShowConsentModal(true);
            return;
        }
        startEnrollmentWizard();
    };

    const handleConsentAccept = () => {
        try { localStorage.setItem(FACE_CONSENT_KEY, 'true'); } catch { /* consent just won't persist across sessions */ }
        setShowConsentModal(false);
        startEnrollmentWizard();
    };

    const startEnrollmentWizard = () => {
        // 🟩 INTERRUPTION RECOVERY: a closed tab, dropped camera, or accidental
        // navigation mid-wizard previously threw away every pose already
        // captured — resume from localStorage-backed progress if any exists
        // for this user instead of forcing a full restart.
        const saved = loadEnrollmentProgress(userProfile.id);
        setEnrollmentPoseReading({ yaw: 0, pitch: 0, achieved: false });
        latestEnrollmentDetectionRef.current = null;
        if (saved) {
            setEnrollmentCaptures(saved.captures);
            setEnrollmentStepIndex(saved.stepIndex);
            toast.success(t('attendance.enrollResumedProgress', { step: saved.stepIndex + 1, total: ENROLLMENT_POSES.length }));
        } else {
            setEnrollmentCaptures([]);
            setEnrollmentStepIndex(0);
        }
    };

    const cancelEnrollmentWizard = () => {
        setEnrollmentStepIndex(-1);
        setEnrollmentCaptures([]);
        latestEnrollmentDetectionRef.current = null;
        clearEnrollmentProgress(userProfile.id);
    };

    // 🟩 MULTI-ANGLE ENROLLMENT: captures one descriptor per pose (center,
    // left, right, up, down) instead of a single frontal snapshot, and
    // stores all of them as one JSON array in the same face_descriptor
    // column — no schema change, matching (multiTemplateMatcher.js) just
    // compares a live scan against every stored angle and keeps the best.
    const handleCaptureEnrollmentPose = async () => {
        const det = latestEnrollmentDetectionRef.current;
        if (!det || !enrollmentPoseReading.achieved || isEnrolling) return;

        // 🟩 ENROLLMENT QUALITY GATE: reject a blurry or badly-lit capture up
        // front — a poor reference descriptor causes every future clock-in
        // to be unreliable, and that's much harder to diagnose after the fact.
        if (det.box && det.sourceCanvas) {
            try {
                const ctx = det.sourceCanvas.getContext('2d');
                const region = ctx.getImageData(det.box.x, det.box.y, det.box.width, det.box.height);
                const quality = checkEnrollmentQuality(region.data, det.box.width, det.box.height);
                if (!quality.ok) {
                    toast.error(t(ENROLL_QUALITY_HINT_KEYS[quality.reason] || 'attendance.faceDetectFailed'));
                    return;
                }
            } catch (_err) {
                // Quality sampling failed (tainted canvas, etc.) — proceed rather than block enrollment entirely on a non-critical check.
            }
        }

        const capturedTemplate = Array.from(det.descriptor);
        const nextCaptures = [...enrollmentCaptures, capturedTemplate];

        if (enrollmentStepIndex + 1 < ENROLLMENT_POSES.length) {
            setEnrollmentCaptures(nextCaptures);
            setEnrollmentStepIndex(enrollmentStepIndex + 1);
            setEnrollmentPoseReading({ yaw: 0, pitch: 0, achieved: false });
            latestEnrollmentDetectionRef.current = null;
            saveEnrollmentProgress(userProfile.id, enrollmentStepIndex + 1, nextCaptures);
            toast.success(t('attendance.enrollPoseCaptured', { step: enrollmentStepIndex + 1, total: ENROLLMENT_POSES.length }));
            return;
        }

        // Final pose captured — save every angle at once.
        setIsEnrolling(true);
        try {
            const { error } = await supabase
                .from('profiles')
                .update({ face_descriptor: JSON.stringify(nextCaptures) })
                .eq('id', userProfile.id);

            if (error) {
                // Keep the saved progress on failure — the captures are still
                // good, only the final profile write failed, so let them
                // retry finalization without re-scanning every pose.
                showUserError('errors.enrollFace', error);
            } else {
                clearStalenessCounter(userProfile.id);
                clearEnrollmentProgress(userProfile.id);
                toast.success(t('attendance.faceEnrolled'));
                fetchProfile?.();
                setEnrollmentStepIndex(-1);
                setEnrollmentCaptures([]);
            }
        } finally {
            setIsEnrolling(false);
        }
    };

    const handleResetEnrolledFace = async () => {
        if (isEnrolling) return;
        setIsEnrolling(true);
        try {
            await supabase.from('profiles').update({ face_descriptor: null }).eq('id', userProfile.id);
            toast.success(t('attendance.faceCleared'));
            fetchProfile?.();
        } finally {
            setIsEnrolling(false);
        }
    };

    const statusBadge = (status, clockOut, date) => {
        if (!clockOut && date !== today) {
            return <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">{t('attendance.incomplete')}</span>;
        }
        if (!clockOut) {
            return <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 animate-pulse">{t('attendance.inProgress')}</span>;
        }
        const styles = status === 'Present' 
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' 
            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20';
        return <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${styles}`}>{status}</span>;
    };

    return (
        // 🟩 CONTRAST FIX: this view is styled as a dark "ops monitoring"
        // panel (bg-slate-800/900, near-white text, neon accent borders)
        // with no light-mode counterparts — every slate/white color below
        // now has a matching light-mode base class with the original as its
        // dark: variant, matching the same bg-white dark:bg-gray-800 pattern
        // already used throughout LeaveView/TasksView/PerformanceReviewView,
        // so this renders correctly in both themes instead of only ever
        // looking right in dark mode.
        <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6 text-gray-800 dark:text-slate-100">
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center border-b border-gray-200 dark:border-slate-800 pb-5 gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
                        {userProfile.role === 'supervisor' ? t('attendance.supervisorTitle') : t('attendance.employeeTitle')}
                    </h1>
                    <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
                        {userProfile.role === 'supervisor' ? t('attendance.supervisorSubtitle') : t('attendance.employeeSubtitle')}
                    </p>
                </div>
                {userProfile.role === 'supervisor' && (
                    <div className="flex items-center gap-2">
                        <select
                            value={exportEmployeeId}
                            onChange={(e) => setExportEmployeeId(e.target.value)}
                            className="text-xs font-bold bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 rounded-lg px-2 py-2 focus:outline-none focus:border-blue-500"
                        >
                            <option value="all">{t('attendance.allEmployees')}</option>
                            {processedInterns.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                        </select>
                        <ExportButton data={exportDataFiltered} filename={exportEmployeeId === 'all' ? "Outsourcing_Staff_Attendance_Roster" : `Attendance_${processedInterns.find(e => e.id === exportEmployeeId)?.name || 'Employee'}`} label={t('attendance.exportCleanSheet')} />
                        <button
                            type="button"
                            onClick={() => generateTablePdf({
                                title: userProfile.role === 'supervisor' ? t('attendance.supervisorTitle') : t('attendance.employeeTitle'),
                                subtitle: exportEmployeeId === 'all' ? t('attendance.allEmployees') : processedInterns.find(e => e.id === exportEmployeeId)?.name || '',
                                columns: [
                                    { key: 'Date', label: t('attendance.date') },
                                    { key: 'Employee', label: t('attendance.employee') },
                                    { key: 'Institution', label: t('attendance.institution') },
                                    { key: 'Assigned Mode', label: t('attendance.assignedMode') },
                                    { key: 'Status', label: t('attendance.status') },
                                    { key: 'Check In', label: t('attendance.checkIn') },
                                    { key: 'Check Out', label: t('attendance.checkOut') },
                                ],
                                rows: exportDataFiltered,
                                filename: exportEmployeeId === 'all' ? 'Attendance_Roster' : `Attendance_${processedInterns.find(e => e.id === exportEmployeeId)?.name || 'Employee'}`,
                            })}
                            className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg shadow-sm transition-all text-sm border border-red-700"
                            title={t('common.exportPdf')}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            {t('common.exportPdf')}
                        </button>
                    </div>
                )}
            </div>

            {/* 🟩 PART 3: this used to be an exclusive ternary -- supervisors
                got ONLY the roster/monitoring view below, employees got ONLY
                the clock-in/out panel further down. Now additive: a
                supervisor gets BOTH (roster first, then their own clock-in/
                out panel using the exact same JSX employees already use) --
                see the closing `)}`/unconditional block below instead of the
                old `) : (`. The monitoring view's own content is completely
                unchanged, just no longer mutually exclusive with the
                clock-in panel. */}
            {userProfile.role === 'supervisor' && (
                <div className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                        <div className="bg-white dark:bg-slate-800/40 border border-gray-200 dark:border-slate-700/50 rounded-2xl p-5 shadow-xl backdrop-blur-md">
                            <div className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase tracking-widest">{t('attendance.totalRegisteredStaff')}</div>
                            <div className="text-4xl font-black text-gray-900 dark:text-white mt-2 flex items-baseline gap-2">
                                {activeEmployees.length} <span className="text-xs font-bold text-gray-400 dark:text-slate-500 uppercase font-sans">{t('attendance.officers')}</span>
                            </div>
                        </div>
                        <div className="bg-gradient-to-br from-blue-600/20 to-indigo-600/10 border border-blue-500/30 rounded-2xl p-5 shadow-xl backdrop-blur-md">
                            <div className="text-xs font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest">{t('attendance.activeClockedInToday')}</div>
                            <div className="text-4xl font-black text-blue-600 dark:text-blue-400 mt-2 flex items-baseline gap-2">
                                {clockedInTodayCount} <span className="text-xs font-bold text-blue-700 dark:text-blue-500 uppercase font-sans animate-pulse">{t('attendance.liveNow')}</span>
                            </div>
                        </div>
                        <div className="bg-white dark:bg-slate-800/40 border border-gray-200 dark:border-slate-700/50 rounded-2xl p-5 shadow-xl backdrop-blur-md flex flex-col justify-center">
                            <div className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase tracking-widest mb-2">{t('attendance.dutyModeDistribution')}</div>
                            <div className="flex gap-2">
                                <span className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 px-3 py-1 rounded-xl text-[10px] font-bold uppercase tracking-wider">🏢 {wfoAssignmentCount} WFO</span>
                                <span className="bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 px-3 py-1 rounded-xl text-[10px] font-bold uppercase tracking-wider">🏠 {wfhAssignmentCount} WFH</span>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 bg-white dark:bg-slate-800/40 p-4 rounded-2xl border border-gray-200 dark:border-slate-700/50 shadow-inner">
                        <div>
                            <label htmlFor="att-search" className="block text-[10px] font-black text-gray-500 dark:text-slate-400 uppercase tracking-widest mb-1.5">{t('attendance.searchStaff')}</label>
                            <input
                                id="att-search"
                                type="text"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                placeholder={t('attendance.searchPlaceholder')}
                                className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/60 rounded-xl focus:outline-none focus:border-blue-500 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-slate-500 font-medium"
                            />
                        </div>
                        <div>
                            <label htmlFor="att-source" className="block text-[10px] font-black text-gray-500 dark:text-slate-400 uppercase tracking-widest mb-1.5">{t('attendance.originInstitution')}</label>
                            <select id="att-source" value={filterSource} onChange={(e) => setFilterSource(e.target.value)} className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/60 rounded-xl focus:outline-none focus:border-blue-500 text-gray-900 dark:text-white font-bold">
                                <option value="all">{t('attendance.allInstitutions')}</option>
                                {uniqueSources.map(src => <option key={src} value={src}>{src}</option>)}
                            </select>
                        </div>
                        <div>
                            <label htmlFor="att-mode" className="block text-[10px] font-black text-gray-500 dark:text-slate-400 uppercase tracking-widest mb-1.5">{t('attendance.assignedMode')}</label>
                            <select id="att-mode" value={filterMode} onChange={(e) => setFilterMode(e.target.value)} className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/60 rounded-xl focus:outline-none focus:border-blue-500 text-gray-900 dark:text-white font-bold">
                                <option value="all">{t('attendance.allModes')}</option>
                                <option value="WFO">{t('attendance.officeWFO')}</option>
                                <option value="WFH">{t('attendance.remoteWFH')}</option>
                            </select>
                        </div>
                        <div>
                            <label htmlFor="att-status" className="block text-[10px] font-black text-gray-500 dark:text-slate-400 uppercase tracking-widest mb-1.5">{t('attendance.rosterState')}</label>
                            <select id="att-status" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/60 rounded-xl focus:outline-none focus:border-blue-500 text-gray-900 dark:text-white font-bold">
                                <option value="all">{t('attendance.allStatuses')}</option>
                                <option value="clocked_in">{t('attendance.activeClockedIn')}</option>
                                <option value="not_clocked_in">{t('attendance.inactiveNotIn')}</option>
                            </select>
                        </div>
                        <div>
                            <label htmlFor="att-sort" className="block text-[10px] font-black text-gray-500 dark:text-slate-400 uppercase tracking-widest mb-1.5">{t('attendance.sortConfiguration')}</label>
                            <select id="att-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/60 rounded-xl focus:outline-none focus:border-blue-500 text-gray-900 dark:text-white font-bold">
                                <option value="name-az">{t('attendance.nameAZ')}</option>
                                <option value="name-za">{t('attendance.nameZA')}</option>
                                <option value="status-active">{t('attendance.clockedInFirst')}</option>
                            </select>
                        </div>
                    </div>

                    <div className="bg-gray-50 dark:bg-slate-800/20 rounded-2xl border border-gray-200 dark:border-slate-800 shadow-2xl overflow-hidden backdrop-blur-sm">
                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                                <thead className="bg-gray-100 dark:bg-slate-800/60 border-b border-gray-200 dark:border-slate-700/60 text-[11px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-widest">
                                    <tr>
                                        <SortableTh label={t('attendance.colStaffName')} sortKey="name" sortConfig={columnSort} onSort={toggleColumnSort} />
                                        <SortableTh label={t('attendance.colInstitution')} sortKey="institution" sortConfig={columnSort} onSort={toggleColumnSort} />
                                        <SortableTh label={t('attendance.colDutyMode')} sortKey="mode" sortConfig={columnSort} onSort={toggleColumnSort} />
                                        <SortableTh label={t('attendance.colTodayStatus')} sortKey="status" sortConfig={columnSort} onSort={toggleColumnSort} />
                                        <th className="p-4 text-right">{t('attendance.colActions')}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100 dark:divide-slate-800/60 text-xs font-semibold text-gray-700 dark:text-slate-200">
                                    {processedInterns.map(emp => {
                                        const empToday = attendance.find(a => a.employee_id === emp.id && a.date === today);
                                        return (
                                            <tr key={emp.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/30 transition-all duration-150">
                                                <td className="p-4 font-bold text-gray-900 dark:text-white">
                                                    <div className="flex items-center gap-3">
                                                        <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center font-black text-white text-xs border border-blue-400/20">
                                                            {emp.name?.charAt(0).toUpperCase()}
                                                        </div>
                                                        <span>{emp.name}</span>
                                                        {onlineUserIds.has(String(emp.id)) && (
                                                            <span
                                                                className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)] animate-pulse"
                                                                title={t('attendance.onlineNow')}
                                                            />
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="p-4">
                                                    <span className="bg-white dark:bg-slate-900/80 text-gray-500 dark:text-slate-400 border border-gray-200 dark:border-slate-700/60 px-2.5 py-1 rounded-lg text-[10px] uppercase font-mono tracking-wide">
                                                        {emp.source || emp.university || 'President University'}
                                                    </span>
                                                </td>
                                                <td className="p-4">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleToggleWorkMode(emp.id, emp.work_mode || 'WFO')}
                                                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-xl font-bold border text-[10px] uppercase tracking-wider ${
                                                            emp.work_mode === 'WFH' ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20'
                                                        }`}
                                                    >
                                                        {emp.work_mode === 'WFH' ? t('attendance.wfhRemote') : t('attendance.wfoOnSite')}
                                                    </button>
                                                </td>
                                                <td className="p-4">
                                                    {empToday ? (
                                                        <div className="flex flex-col items-start gap-1">
                                                            {statusBadge(empToday.status, empToday.clock_out, empToday.date)}
                                                            <span className="text-[10px] font-bold text-gray-400 dark:text-slate-500 font-mono">IN: {getRecordClockInTime(empToday)}</span>
                                                        </div>
                                                    ) : (
                                                        <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-white dark:bg-slate-900 text-gray-500 dark:text-slate-600 border border-gray-200 dark:border-slate-800">{t('attendance.notClockedIn')}</span>
                                                    )}
                                                </td>
                                                <td className="p-4 text-right">
                                                    {empToday?.latitude && (
                                                        <button type="button" onClick={() => openMap(empToday.latitude, empToday.longitude)} className="text-xs font-bold px-3 py-1.5 border border-gray-200 dark:border-slate-700 rounded-xl bg-gray-50 dark:bg-slate-900/60 text-gray-600 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white hover:bg-white dark:hover:bg-slate-800 shadow-md transition">
                                                            {t('attendance.viewClockInLocation')}
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
            {(
                <>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 font-bold text-gray-500 dark:text-slate-400 text-xs tracking-wider">
                        <div className="bg-gradient-to-br from-blue-600 to-indigo-800 rounded-2xl p-5 text-white shadow-xl">
                            <p className="text-blue-200 text-xs font-black uppercase tracking-widest mb-1">{t('attendance.myPunctuality')}</p>
                            <h3 className="text-4xl font-black tracking-tight">{punctualityScore}%</h3>
                        </div>
                        <div className="bg-white dark:bg-slate-800/40 border border-gray-200 dark:border-slate-700/50 rounded-2xl p-5 shadow-xl backdrop-blur-md">
                            <p className="mb-1 text-gray-500 dark:text-slate-400">{t('attendance.totalPresentDays')}</p>
                            <h3 className="text-4xl font-black text-gray-900 dark:text-white mt-1">{totalDays} <span className="text-xs font-bold text-gray-400 dark:text-slate-500 uppercase">{t('attendance.days')}</span></h3>
                        </div>
                        <div className="bg-white dark:bg-slate-800/40 border border-gray-200 dark:border-slate-700/50 rounded-2xl p-5 shadow-xl backdrop-blur-md">
                            <p className="mb-1 text-gray-500 dark:text-slate-400">{t('attendance.lateArrivals')}</p>
                            <h3 className={`text-4xl font-black ${lateDays > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-white'} mt-1`}>{lateDays} <span className="text-xs font-bold text-gray-400 dark:text-slate-500 uppercase">{t('attendance.days')}</span></h3>
                        </div>
                    </div>

                    <div className="bg-white dark:bg-slate-800/40 p-5 rounded-2xl border border-gray-200 dark:border-slate-700/50 shadow-xl flex flex-col md:flex-row justify-between items-center gap-4 backdrop-blur-md">
                         <div className="flex items-center gap-4">
                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-2xl ${isInRange ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 animate-pulse'}`}>
                                {(userProfile.work_mode || 'WFO') === 'WFO' ? '🏢' : '🏠'}
                            </div>
                            <div>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <h2 className="text-base font-bold text-gray-900 dark:text-white">{t('attendance.assignedDutyProfile', { mode: (userProfile.work_mode || 'WFO') === 'WFO' ? t('attendance.officeBoundary') : t('attendance.remoteHome') })}</h2>
                                    {isWeekend(today) && (
                                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-50 text-violet-600 dark:bg-violet-950/30 dark:text-violet-300">
                                            {t('attendance.weekendOptional')}
                                        </span>
                                    )}
                                </div>
                                <p className={`text-xs font-bold uppercase font-mono mt-0.5 tracking-wider ${isInRange ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                    {userProfile.role === 'supervisor'
                                        ? t('attendance.supervisorGeofenceBypass')
                                        : (userProfile.work_mode || 'WFO') === 'WFO'
                                        ? (liveDistance !== null ? t('attendance.coordinatesTracked', { distance: liveDistance.toFixed(0) }) : t('attendance.capturingGps'))
                                        : t('attendance.remoteGeofenceBypass')}
                                </p>
                            </div>
                         </div>

                         <div className="flex gap-3 w-full md:w-auto">
                            {!todayRecord && (
                                <button
                                    type="button"
                                    onClick={() => handleClockIn('manual')}
                                    disabled={isLoading || !isInRange || !isCameraReady || !isFaceVerified}
                                    className={`w-full md:w-auto px-8 py-3 rounded-xl font-bold text-slate-900 transition-all shadow-lg ${isLoading || !isInRange || !isCameraReady || !isFaceVerified ? 'bg-gray-200 dark:bg-slate-700 text-gray-400 dark:text-slate-500 cursor-not-allowed border border-gray-300 dark:border-slate-600' : 'bg-gradient-to-r from-yellow-400 to-amber-500 hover:from-yellow-300 hover:to-amber-400 hover:-translate-y-0.5 font-black uppercase text-xs tracking-widest'}`}
                                >
                                    {isLoading
                                        ? t('attendance.processing')
                                        : (isFaceVerified ? t('attendance.clockInShift') : t('attendance.verifyBiometrics'))}
                                </button>
                            )}
                            {/* 🟩 SECURITY: clock-out now requires the same live face
                                verification as clock-in -- the button just arms scanning
                                (reusing the camera panel below) instead of clocking out
                                on a bare click, closing a gap where anyone at a shared
                                device could clock someone else out with no identity check. */}
                            {todayRecord && !todayRecord.clock_out && !isClockingOut && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        clockOutGuardRef.current = false;
                                        livenessChallengeRef.current.reset();
                                        // 🟩 BUG FIX: a successful clock-IN earlier in this same
                                        // page session sets faceStatus to 'matched' and nothing
                                        // ever reset it back afterward -- the main scan-loop
                                        // effect's own guard (`faceStatus !== 'scanning'` ->
                                        // return early, never creating the detection interval)
                                        // then silently blocked clock-out from ever running a
                                        // single tick: no face box, no eye box, no blink read,
                                        // reported live as "muka gak kedetect pas clock out".
                                        // Clock-in's own failure-retry path already does this
                                        // exact reset (see clockInRetryNonce's comment further
                                        // down); clock-out just never had an equivalent because
                                        // it had no prior 'matched' write of its own to undo.
                                        setFaceStatus('scanning');
                                        // 🟩 BUG FIX (follow-up): the loop-running fix above wasn't
                                        // enough by itself -- biometricStatus/challengeGlyph/
                                        // faceOverlayBox/eyeBoxes are ALL left holding whatever
                                        // they were at the moment of that earlier clock-in (e.g.
                                        // still showing "Step 1/1: blink..." with its glyph), and
                                        // nothing overwrites them until the new scan loop's first
                                        // tick actually finds and matches a face again. Reported
                                        // live as the panel looking "frozen" on stale text with no
                                        // box while re-scanning genuinely hadn't found anything
                                        // yet. Clearing them here makes a freshly-armed clock-out
                                        // start from the exact same clean slate a fresh page
                                        // mount would, same as the trackers/refs it already reset.
                                        setBiometricStatus(t('attendance.statusScanning'));
                                        setChallengeGlyph(null);
                                        setFaceOverlayBox(null);
                                        setEyeBoxes(null);
                                        setIsFaceVerified(false);
                                        pulseDetectorRef.current.reset();
                                        boxMotionTrackerRef.current.reset();
                                        prevFaceBoxForMotionRef.current = null;
                                        microMotionTrackerRef.current.reset();
                                        lensObstructedStreakRef.current = 0;
                                        setIsClockingOut(true);
                                    }}
                                    disabled={isLoading || !isCameraReady || isTestScanning}
                                    className="w-full md:w-auto px-8 py-3 rounded-xl font-black text-white bg-red-600 hover:bg-red-500 transition-all shadow-md hover:-translate-y-0.5 uppercase text-xs tracking-widest disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                                >
                                    {t('attendance.clockOutShift')}
                                </button>
                            )}
                            {todayRecord && !todayRecord.clock_out && isClockingOut && (
                                <div className="flex items-center gap-2 w-full md:w-auto">
                                    <div className="flex-1 px-6 py-3 rounded-xl font-black text-white bg-red-600/80 text-center text-[10px] uppercase tracking-widest animate-pulse">
                                        {t('attendance.clockOutScanning')}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setIsClockingOut(false)}
                                        className="px-4 py-3 rounded-xl border border-gray-300 dark:border-slate-700 text-[10px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-widest hover:bg-gray-50 dark:hover:bg-slate-800"
                                    >
                                        {t('attendance.cancel')}
                                    </button>
                                </div>
                            )}
                            {todayRecord && todayRecord.clock_out && (
                                <div className="w-full md:w-auto px-8 py-3 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 text-gray-400 dark:text-slate-500 font-extrabold rounded-xl text-xs uppercase tracking-widest text-center">{t('attendance.shiftCompleted')}</div>
                            )}
                            {/* 🟩 PIN + geofence: camera-free alternative, gated the same
                                way as the face flow (geofence still enforced for WFO) --
                                see handlePinClockAction above and migrations/
                                20260810_add_clock_pin.sql. Only offered once there's
                                something left to do today. */}
                            {(!todayRecord || !todayRecord.clock_out) && userProfile.clock_pin_hash && (
                                <button
                                    type="button"
                                    onClick={() => setShowPinModal(true)}
                                    className="w-full md:w-auto px-4 py-3 rounded-xl border border-gray-300 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 font-bold text-[10px] uppercase tracking-widest transition-all"
                                >
                                    {t('attendance.usePinInstead')}
                                </button>
                            )}
                         </div>
                    </div>

                    {/* 🟩 PART 2: TEST BIOMETRIC SCAN -- deliberately styled in
                        purple/indigo (distinct from the yellow "clock in" and
                        red "clock out" buttons above) and clearly labeled, so
                        nobody mistakes this for actually clocking in/out.
                        Available to both roles; never calls performClockIn/
                        performClockOut/handleClockIn/handleClockOut -- see
                        the dedicated test-scan effect above. */}
                    <div className="bg-indigo-50 dark:bg-indigo-950/20 rounded-2xl border-2 border-dashed border-indigo-300 dark:border-indigo-800 p-5">
                        <div className="flex items-center justify-between gap-4 flex-wrap">
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-indigo-600 text-white">{t('attendance.testModeBadge')}</span>
                                    <h3 className="text-sm font-bold text-indigo-900 dark:text-indigo-200">{t('attendance.testModeTitle')}</h3>
                                </div>
                                <p className="text-[11px] text-indigo-700/80 dark:text-indigo-300/70 mt-1 max-w-md">{t('attendance.testModeDescription')}</p>
                            </div>
                            {!isTestScanning ? (
                                <button
                                    type="button"
                                    onClick={handleStartTestScan}
                                    disabled={isClockingOut || !isCameraReady}
                                    className="shrink-0 px-5 py-2.5 rounded-xl font-bold text-xs uppercase tracking-widest bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                                >
                                    {t('attendance.testModeStart')}
                                </button>
                            ) : (
                                <div className="flex items-center gap-2 shrink-0">
                                    <span className="text-[10px] font-bold text-indigo-700 dark:text-indigo-300 uppercase tracking-widest animate-pulse">{t('attendance.testModeScanning')}</span>
                                    <button
                                        type="button"
                                        onClick={handleCancelTestScan}
                                        className="px-3 py-2 rounded-lg border border-indigo-300 dark:border-indigo-700 text-[10px] font-bold text-indigo-600 dark:text-indigo-300 uppercase tracking-widest hover:bg-indigo-100 dark:hover:bg-indigo-900/40"
                                    >
                                        {t('attendance.cancel')}
                                    </button>
                                </div>
                            )}
                        </div>

                        {testScanResult && (
                            <div className={`mt-4 p-3 rounded-xl flex items-start gap-3 text-xs font-bold ${testScanResult.status === 'pass' ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300' : 'bg-red-100 dark:bg-red-950/40 text-red-800 dark:text-red-300'}`}>
                                <span className="text-base leading-none" aria-hidden="true">{testScanResult.status === 'pass' ? '✅' : '❌'}</span>
                                <div>
                                    <p>{testScanResult.status === 'pass' ? t('attendance.testModePassTitle') : t('attendance.testModeFailTitle')}</p>
                                    {testScanResult.reason && (
                                        <p className="font-medium mt-0.5 opacity-90">{t(`attendance.testModeReason_${testScanResult.reason.replace(/-/g, '_')}`)}</p>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="bg-white dark:bg-slate-800/40 rounded-2xl border border-gray-200 dark:border-slate-700/50 shadow-xl overflow-hidden backdrop-blur-md">
                        <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-700/60 bg-gray-50 dark:bg-slate-800/20">
                            <h3 className="text-sm font-bold text-gray-900 dark:text-white">{t('attendance.liveVerificationGate')}</h3>
                            <p className="text-[11px] text-gray-500 dark:text-slate-400 mt-0.5">{t('attendance.liveVerificationDescription')}</p>
                        </div>
                        <div className="p-5 flex flex-col items-center">
                            {/* LIVE VIDEO FRAME HOUSING WITH RESTORED OVERLAY MAPPERS */}
                            <div className="relative w-full max-w-md aspect-video bg-gray-50 dark:bg-slate-950 border border-gray-200 dark:border-slate-800 rounded-2xl overflow-hidden group shadow-2xl">
                                <video
                                    ref={webcamVideoRef}
                                    autoPlay
                                    playsInline
                                    muted
                                    className="absolute inset-0 w-full h-full object-cover"
                                    style={{ transform: 'scaleX(-1)' }}
                                />

                                {/* 🟩 PART 2: visible on the video feed itself (not just the panel
                                    above) so it's unmistakable in a screen-share/screenshot too --
                                    a corner banner, not a full block, since the whole point of Test
                                    Mode is watching your own scan happen. */}
                                {isTestScanning && (
                                    <div className="absolute top-2 left-2 z-20 px-2.5 py-1 rounded-lg bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest shadow-lg animate-pulse">
                                        {t('attendance.testModeBadge')}
                                    </div>
                                )}

                                {/* 🟩 ANTI-AUTOMATION: a WebDriver-controlled session gets a clear,
                                    specific block instead of a stuck camera prompt -- manual clock-in
                                    (doesn't need the camera) is still available. */}
                                {automationDetected && (
                                    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-white dark:bg-slate-950/95 text-center p-6">
                                        <span className="text-3xl" aria-hidden="true">🤖🚫</span>
                                        <h4 className="text-sm font-bold text-gray-900 dark:text-white">{t('attendance.automationBlockedTitle')}</h4>
                                        <p className="text-[11px] text-gray-500 dark:text-slate-400 max-w-xs leading-relaxed">{t('attendance.automationBlockedBody')}</p>
                                    </div>
                                )}

                                {/* 🟩 SECURITY: virtual/software camera driver detected -- see
                                    vision/virtualCameraDetector.js. */}
                                {virtualCameraDetected && (
                                    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-white dark:bg-slate-950/95 text-center p-6">
                                        <span className="text-3xl" aria-hidden="true">📹🚫</span>
                                        <h4 className="text-sm font-bold text-gray-900 dark:text-white">{t('attendance.virtualCameraBlockedTitle')}</h4>
                                        <p className="text-[11px] text-gray-500 dark:text-slate-400 max-w-xs leading-relaxed">{t('attendance.virtualCameraBlockedBody')}</p>
                                    </div>
                                )}

                                {/* 🟩 CAMERA FALLBACK: covers the (empty/black) video element with an
                                    actionable message instead of leaving the panel silently stuck. */}
                                {cameraError && (
                                    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-white dark:bg-slate-950/95 text-center p-6">
                                        <span className="text-3xl" aria-hidden="true">📷🚫</span>
                                        <h4 className="text-sm font-bold text-gray-900 dark:text-white">{t(CAMERA_ERROR_I18N_KEYS[cameraError].title)}</h4>
                                        <p className="text-[11px] text-gray-500 dark:text-slate-400 max-w-xs leading-relaxed">
                                            {t(CAMERA_ERROR_I18N_KEYS[cameraError].body)}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => window.location.reload()}
                                            className="mt-1 px-4 py-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 border border-gray-200 dark:border-slate-700 text-[11px] font-bold text-gray-700 dark:text-slate-200 uppercase tracking-wider transition-colors"
                                        >
                                            {t('attendance.cameraErrorReload')}
                                        </button>
                                    </div>
                                )}

                                {/* 🟩 MODEL LOAD FALLBACK: same idea as the camera fallback above, for
                                    when the face-recognition model weights themselves fail to
                                    download -- "Retry" re-runs the loader in place instead of
                                    forcing a full page reload. */}
                                {!cameraError && modelsLoadFailed && (
                                    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-white dark:bg-slate-950/95 text-center p-6">
                                        <span className="text-3xl" aria-hidden="true">🧠🚫</span>
                                        <h4 className="text-sm font-bold text-gray-900 dark:text-white">{t('attendance.modelsErrorTitle')}</h4>
                                        <p className="text-[11px] text-gray-500 dark:text-slate-400 max-w-xs leading-relaxed">
                                            {t('attendance.modelsErrorBody')}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => setModelLoadAttempt((n) => n + 1)}
                                            className="mt-1 px-4 py-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 border border-gray-200 dark:border-slate-700 text-[11px] font-bold text-gray-700 dark:text-slate-200 uppercase tracking-wider transition-colors"
                                        >
                                            {t('attendance.retryLoadingModels')}
                                        </button>
                                    </div>
                                )}

                                {torchActive && (
                                    <div className="absolute top-2 right-2 z-30 flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-700 dark:text-amber-300 text-[10px] font-bold uppercase tracking-wider">
                                        <span aria-hidden="true">🔦</span> {t('attendance.torchActiveLabel')}
                                    </div>
                                )}

                                {/* 🟩 RESTORED: Pure geometric YOLO-style HTML wireframe bounding box */}
                                {faceOverlayBox && isCameraReady && (
                                    <div
                                        className={`absolute border-2 rounded-xl z-20 pointer-events-none transition-all duration-75 ${
                                            (faceStatus === 'matched' || (enrollmentStepIndex >= 0 && enrollmentPoseReading.achieved)) ? 'border-emerald-400 bg-emerald-500/10 shadow-[0_0_15px_rgba(52,211,153,0.3)]' : 'border-blue-400 bg-blue-500/10 shadow-[0_0_15px_rgba(96,165,250,0.3)]'
                                        }`}
                                        style={getFaceOverlayStyle() || { display: 'none' }}
                                    >
                                        <div className={`absolute -top-6 left-0 text-[9px] font-black tracking-widest px-2 py-0.5 rounded-md text-white font-mono uppercase shadow-md ${
                                            faceStatus === 'matched' ? 'bg-emerald-500' : 'bg-blue-500'
                                        }`}>
                                            {faceOverlayBox.source === 'yolo' ? '⚡ YOLOv8 FACE' : '🔍 FACE-API'}
                                        </div>
                                    </div>
                                )}

                                {/* 🟩 NEW: a box drawn around each eye that lights up the
                                    moment a blink closes it -- real-time visual proof the
                                    scan is actually reading your eyes, not just a status
                                    message the user has to trust. Only meaningful during
                                    the main clock-in scan (not the enrollment wizard,
                                    which doesn't run the liveness challenge at all). */}
                                {eyeBoxes && isCameraReady && enrollmentStepIndex < 0 && (
                                    <>
                                        <div
                                            aria-hidden="true"
                                            className={`absolute border-2 rounded-md z-20 pointer-events-none transition-all duration-75 ${
                                                eyeBoxes.leftClosed ? 'border-emerald-400 bg-emerald-500/20 shadow-[0_0_10px_rgba(52,211,153,0.5)]' : 'border-cyan-300/70'
                                            }`}
                                            style={getEyeOverlayStyle(eyeBoxes.left) || { display: 'none' }}
                                        />
                                        <div
                                            aria-hidden="true"
                                            className={`absolute border-2 rounded-md z-20 pointer-events-none transition-all duration-75 ${
                                                eyeBoxes.rightClosed ? 'border-emerald-400 bg-emerald-500/20 shadow-[0_0_10px_rgba(52,211,153,0.5)]' : 'border-cyan-300/70'
                                            }`}
                                            style={getEyeOverlayStyle(eyeBoxes.right) || { display: 'none' }}
                                        />
                                    </>
                                )}

                            </div>

                            {/* 🟩 UI: directional challenge arrow, shown ABOVE the readiness bar
                                (not cramped inside the panel overlay) -- big and prominent since
                                it's the primary "what do I do right now" cue. */}
                            {challengeGlyph && (
                                <div className="mt-3 w-full max-w-md flex items-center justify-center h-9">
                                    <span className="text-3xl animate-pulse" aria-hidden="true">{challengeGlyph}</span>
                                </div>
                            )}

                            {/* 🟩 SCAN READINESS BAR: live clock-in scan only (enrollment wizard has its own, pose-specific bar above) */}
                            {isCameraReady && hasStoredFace && !todayRecord && enrollmentStepIndex < 0 && (
                                <div className="mt-3 w-full max-w-md">
                                    <ScanReadinessBar readiness={scanReadiness} label={t('attendance.scanReadinessLabel')} />
                                </div>
                            )}

                            {/* 🟩 UI: instruction/status text now lives below the bar, separate
                                from the camera panel entirely, so a longer 2-step challenge
                                instruction never overflows/clips inside the panel overlay. */}
                            <p aria-live="polite" className="mt-2 text-[11px] font-bold text-blue-600 dark:text-blue-400 tracking-wide text-center max-w-md uppercase px-2">
                                {biometricStatus}
                            </p>

                            <div className="mt-4 flex flex-wrap gap-2 w-full max-w-md text-[10px] font-black uppercase tracking-widest font-mono">
                                <button type="button" onClick={handleEnrollFaceFromStream} disabled={!isCameraReady || hasStoredFace || isEnrolling || enrollmentStepIndex >= 0} className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white shadow-md disabled:bg-white dark:disabled:bg-slate-800 disabled:text-gray-500 dark:disabled:text-slate-600 transition-all">{isEnrolling ? t('attendance.enrolling') : t('attendance.enrollFacialMatrix')}</button>
                                <button type="button" onClick={handleResetEnrolledFace} disabled={isEnrolling || enrollmentStepIndex >= 0} className="px-4 py-2 rounded-xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-all disabled:opacity-50">{t('attendance.resetMatrix')}</button>
                            </div>

                            {/* 🟩 MULTI-ANGLE ENROLLMENT WIZARD */}
                            {enrollmentStepIndex >= 0 && (
                                <div className="mt-3 w-full max-w-md bg-white dark:bg-slate-900/80 border border-blue-500/30 rounded-2xl p-4 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] font-black uppercase tracking-widest text-blue-600 dark:text-blue-400">
                                            {t('attendance.enrollStepProgress', { step: enrollmentStepIndex + 1, total: ENROLLMENT_POSES.length })}
                                        </span>
                                        <button type="button" onClick={cancelEnrollmentWizard} className="text-[10px] font-bold uppercase text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300">
                                            {t('common.close')}
                                        </button>
                                    </div>
                                    <p className="text-sm font-bold text-gray-900 dark:text-white">
                                        {t(`attendance.enrollPoseInstruction_${ENROLLMENT_POSES[enrollmentStepIndex]}`)}
                                    </p>
                                    <ScanReadinessBar
                                        readiness={calculatePoseReadiness(
                                            ENROLLMENT_POSES[enrollmentStepIndex],
                                            enrollmentPoseReading.yaw,
                                            enrollmentPoseReading.pitch,
                                            CENTER_YAW_THRESHOLD,
                                            CENTER_PITCH_THRESHOLD
                                        )}
                                        label={t('attendance.enrollPoseReady')}
                                    />
                                    <div className="flex items-center gap-3 text-[10px] font-mono text-gray-500 dark:text-slate-400">
                                        <span>yaw: {enrollmentPoseReading.yaw.toFixed(2)}</span>
                                        <span>pitch: {enrollmentPoseReading.pitch.toFixed(2)}</span>
                                        <span className={enrollmentPoseReading.achieved ? 'text-emerald-600 dark:text-emerald-400 font-bold' : ''}>
                                            {enrollmentPoseReading.achieved ? t('attendance.enrollPoseReady') : t('attendance.enrollPoseAdjust')}
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={handleCaptureEnrollmentPose}
                                        disabled={!enrollmentPoseReading.achieved || isEnrolling}
                                        className="w-full py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black uppercase tracking-widest text-[10px] shadow-md disabled:bg-white dark:disabled:bg-slate-800 disabled:text-gray-500 dark:disabled:text-slate-600 transition-all"
                                    >
                                        {isEnrolling ? t('attendance.enrolling') : t('attendance.enrollCapturePose')}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="rounded-2xl border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/40 p-4 shadow-inner">
                        <div className="flex items-center justify-between mb-4">
                            <span id="personal-clock-log-label" className="text-[11px] font-black uppercase tracking-widest text-gray-500 dark:text-slate-400">{t('attendance.personalClockLog')}</span>
                            <select
                                aria-labelledby="personal-clock-log-label"
                                value={historyStatusFilter}
                                onChange={(e) => setHistoryStatusFilter(e.target.value)}
                                className="text-[10px] font-bold uppercase tracking-wider bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-500"
                            >
                                <option value="all">{t('attendance.allRecords')}</option>
                                <option value="Present">{t('attendance.onTimeOnly')}</option>
                                <option value="Late">{t('attendance.lateOnly')}</option>
                            </select>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {filteredMyHistory.slice(0, 9).map(record => (
                                <div key={record.id} className="rounded-xl border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60 p-3 flex flex-col justify-between shadow-sm">
                                    <div className="flex items-center justify-between mb-1.5 border-b border-gray-200 dark:border-slate-800 pb-1.5">
                                        <span className="text-[11px] font-bold text-gray-900 dark:text-white font-mono">{record.date}</span>
                                        <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md border ${
                                            record.status === 'Late'
                                                ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20'
                                                : 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                                        }`}>
                                            {record.status === 'Late' ? t('attendance.late') : t('attendance.onTime')}
                                        </span>
                                    </div>
                                    <div className="space-y-0.5 text-[11px] text-gray-500 dark:text-slate-400 font-mono">
                                        <div>{t('attendance.inTime')} : <span className="text-gray-900 dark:text-white font-bold">{getRecordClockInTime(record)}</span></div>
                                        <div>{t('attendance.outTime')}: <span className="text-gray-900 dark:text-white font-bold">{record.clock_out || '--:--:--'}</span></div>
                                    </div>
                                </div>
                            ))}
                            {filteredMyHistory.length === 0 && (
                                <div className="col-span-full">
                                    <EmptyState icon={Icons.CalendarDays} title={t('attendance.noMatchingRecords')} className="py-6" />
                                </div>
                            )}
                        </div>
                    </div>

                    {/* 🟩 EDGE DEVICE DIAGNOSTICS: local-only readout of the IoT/edge
                        sensor signals this scan session is already using — nothing
                        here is sent anywhere, it's just surfacing state that already
                        exists locally so the sensor-fusion work is actually visible.
                        (Component extracted to components/EdgeDiagnosticsPanel.jsx --
                        purely presentational, doesn't need to live in this file.) */}
                    <EdgeDiagnosticsPanel
                        t={t}
                        cameraError={cameraError}
                        isCameraReady={isCameraReady}
                        isInRange={isInRange}
                        sensorDiagnostics={{ ...sensorDiagnostics, ...networkBatteryDiagnostics }}
                        torchActive={torchActive}
                        disableYolo={disableYolo}
                        yoloExhausted={yoloExhaustedRef.current}
                    />
                </>
            )}

            <Modal isOpen={showConsentModal} onClose={() => setShowConsentModal(false)} title={t('attendance.consentTitle')}>
                <div className="space-y-4">
                    <p className="text-sm text-gray-700 dark:text-gray-200">{t('attendance.consentBody')}</p>
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setShowConsentModal(false)}
                            className="px-4 py-2 text-xs font-bold rounded-xl border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                        >
                            {t('confirm.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={handleConsentAccept}
                            className="px-4 py-2 text-xs font-bold rounded-xl text-white bg-blue-600 hover:bg-blue-700 shadow-sm"
                        >
                            {t('attendance.consentAccept')}
                        </button>
                    </div>
                </div>
            </Modal>

            <Modal isOpen={showPinModal} onClose={() => { setShowPinModal(false); setPinInput(''); }} title={t('attendance.pinModalTitle')}>
                <div className="space-y-4">
                    <p className="text-xs text-gray-500 dark:text-gray-400">{t('attendance.pinModalDescription')}</p>
                    <input
                        type="password"
                        inputMode="numeric"
                        maxLength={8}
                        autoFocus
                        value={pinInput}
                        onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ''))}
                        onKeyDown={(e) => { if (e.key === 'Enter') handlePinClockAction(); }}
                        placeholder="••••"
                        className="w-full p-4 text-center text-2xl tracking-[0.5em] border border-gray-200 rounded-xl dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none font-mono"
                    />
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => { setShowPinModal(false); setPinInput(''); }}
                            className="px-4 py-2 text-xs font-bold rounded-xl border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                        >
                            {t('confirm.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={handlePinClockAction}
                            disabled={!pinInput || isVerifyingPin}
                            className="px-4 py-2 text-xs font-bold rounded-xl text-white bg-blue-600 hover:bg-blue-700 shadow-sm disabled:opacity-40"
                        >
                            {isVerifyingPin ? t('attendance.processing') : t('attendance.pinModalConfirm')}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* 🟩 NEW SUBMODULES -- see the teamPunctuality/recentLateRecords
                comment near the top of this component for why these are
                appended here as a fully separate, additive-only section
                instead of following the "wrap everything in an Overview
                tab" pattern every other view in this round used. */}
            {userProfile.role === 'supervisor' && (
                <div className="mt-8 space-y-4">
                    <ModuleTabBar
                        tabs={[
                            { id: 'punctuality', label: t('attendance.tabPunctualityBreakdown'), icon: Icons.Trophy },
                            { id: 'recentLate', label: t('attendance.tabRecentLate'), icon: Icons.AlertTriangle },
                        ]}
                        activeTab={insightsTab}
                        onChange={setInsightsTab}
                    />

                    {insightsTab === 'punctuality' && (
                        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                            <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('attendance.punctualityBreakdownTitle')}</h3>
                            <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('attendance.punctualityBreakdownDescription')}</p>
                            {teamPunctuality.length === 0 ? (
                                <EmptyState icon={Icons.Trophy} title={t('attendance.noEmployeesYet')} className="py-6" />
                            ) : (
                                <ul className="divide-y divide-gray-50 dark:divide-gray-700/40">
                                    {teamPunctuality.map((row) => (
                                        <li key={row.id} className="py-3 flex items-center justify-between gap-4">
                                            <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{row.name}</span>
                                            <span className="flex items-center gap-2">
                                                {row.score === null ? (
                                                    <span className="text-[10px] text-gray-400 dark:text-gray-500">{t('attendance.noRecordsYet')}</span>
                                                ) : (
                                                    <span className={`text-[10px] font-bold px-2 py-1 rounded-lg ${
                                                        row.score >= 90
                                                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                                                            : row.score >= 70
                                                            ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                                                            : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                                                    }`}>
                                                        {row.score}%
                                                    </span>
                                                )}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {insightsTab === 'recentLate' && (
                        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                            <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('attendance.recentLateTitle')}</h3>
                            <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('attendance.recentLateDescription')}</p>
                            {recentLateRecords.length === 0 ? (
                                <EmptyState icon={Icons.ShieldCheck} title={t('attendance.noLateRecords')} className="py-6" />
                            ) : (
                                <ul className="divide-y divide-gray-50 dark:divide-gray-700/40">
                                    {recentLateRecords.map((record) => (
                                        <li key={record.id} className="py-3 flex items-center justify-between gap-4">
                                            <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{record.name}</span>
                                            <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 shrink-0">
                                                {record.date}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default AttendanceView;