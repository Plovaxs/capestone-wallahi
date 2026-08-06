import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { supabase } from '../supabaseClient';
import ExportButton from '../components/ExportButton';
import EdgeDiagnosticsPanel from '../components/EdgeDiagnosticsPanel';
import { generateTablePdf } from '../utils/generateTablePdf';
import SortableTh from '../components/SortableTh';
import { PunctualityPolicy } from '../domain/PunctualityPolicy';
import { showUserError } from '../utils/errorHandling';
import { getServerNow } from '../utils/serverTime';
import { calculateHeadTurnRatio, calculatePitchRatio } from '../vision/livenessDetector';
import { checkFraming, checkBrightness, checkOcclusion, checkSingleFace, checkLensObstruction } from '../vision/faceQuality';
import { selectPrimaryFace } from '../vision/primaryFaceSelector';
import { normalizeStoredTemplates, matchAgainstTemplates } from '../vision/multiTemplateMatcher';
import { classifyMatch } from '../vision/matchConfidence';
import { checkReplaySuspicion } from '../vision/antiReplayHeuristic';
import { recordMatchDistance, clearStalenessCounter } from '../vision/descriptorStaleness';
import { checkEnrollmentQuality } from '../vision/enrollmentQuality';
import { calculatePoseReadiness, calculateFrameReadiness } from '../vision/scanReadiness';
import ScanReadinessBar from '../components/ScanReadinessBar';
import { saveEnrollmentProgress, loadEnrollmentProgress, clearEnrollmentProgress } from '../vision/enrollmentProgress';
import { isTorchSupported, setTorch } from '../utils/torchControl';
import { createGeofenceStateMachine } from '../geo/geofenceStateMachine';
import { createMotionStabilityTracker } from '../sensors/motionStability';
import { createMicroMotionTracker } from '../vision/microMotionTracker';
import { checkColorLiveness } from '../vision/colorLivenessHeuristic';
import { calculateFaceOverlayStyle } from '../vision/faceOverlayGeometry';
import { createAmbientLightWatcher } from '../sensors/ambientLight';
import { useNetworkBatteryAdaptive } from '../hooks/useNetworkBatteryAdaptive';
import { usePageVisibility } from '../hooks/usePageVisibility';
import { getBucket } from '../utils/tokenBucket';
import Modal from '../components/Modal';

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

const determineYoloVersion = () => {
  const hardwareConcurrency = navigator.hardwareConcurrency ? parseInt(navigator.hardwareConcurrency, 10) : 0;
  const deviceMemory = parseFloat(navigator.deviceMemory);
  if (deviceMemory < 4 || hardwareConcurrency <= 4) return 'nano';
  if (deviceMemory >= 8 && hardwareConcurrency > 4) return 'medium';
  return 'nano';
};

const YOLO_MODEL_IDS = {
  nano: 'Xenova/yolov8n-face',
  medium: 'Xenova/yolov8n-face'
};

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
    const ATTENDANCE_TABLE = 'attendance';
    const FACE_SCAN_INTERVAL_MS = 1800;
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
    const ENROLLMENT_POSES = ['center'];
    // 🟩 LOOSENED (repeated real-user feedback: "susah bener enroll wajah
    // nya"): these required a bigger head turn/tilt than most people
    // naturally make in front of a webcam to register as "achieved" at
    // all, on top of the yaw/pitch estimate itself only being a rough 2D
    // approximation. Matches the same "usability over strictness" call
    // already made for the liveness thresholds earlier this session.
    const POSE_YAW_THRESHOLD = 0.06;
    const POSE_PITCH_THRESHOLD = 0.06;
    // Center uses its own, looser thresholds (isPoseAchieved below) since it's
    // a "stay near dead-center" gate rather than a directional-turn gate --
    // kept as named constants so the readiness bar (calculatePoseReadiness)
    // can share the exact same numbers instead of drifting out of sync.
    const CENTER_YAW_THRESHOLD = 0.08;
    const CENTER_PITCH_THRESHOLD = 0.10;
    const isPoseAchieved = (pose, yaw, pitch) => {
        switch (pose) {
            case 'center': return Math.abs(yaw) < CENTER_YAW_THRESHOLD && Math.abs(pitch) < CENTER_PITCH_THRESHOLD;
            case 'left': return yaw < -POSE_YAW_THRESHOLD;
            case 'right': return yaw > POSE_YAW_THRESHOLD;
            case 'up': return pitch < -POSE_PITCH_THRESHOLD;
            case 'down': return pitch > POSE_PITCH_THRESHOLD;
            default: return false;
        }
    };

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
    // 🟩 MITIGATION: the neural model loader below previously had no
    // try/catch at all -- a failed model fetch (flaky network, CDN hiccup)
    // threw an unhandled promise rejection with zero user-facing feedback;
    // the scan panel just sat on "Loading network weights..." forever.
    const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
    const [modelLoadAttempt, setModelLoadAttempt] = useState(0);
    const [faceStatus, setFaceStatus] = useState('idle');
    const [biometricStatus, setBiometricStatus] = useState(t('login.statusInitializing'));
    const [, setClockInAt] = useState(''); // write-only, never displayed
    const [, setClockInSource] = useState('none'); // write-only, never displayed
    const [, setCurrentModelVersion] = useState(null); // write-only, never displayed
    // 🟩 NETWORK & BATTERY ADAPTIVE (hooks/useNetworkBatteryAdaptive.js):
    // YOLO is a heavier model fetch + more CPU/battery per frame than
    // face-api's tiny detector alone -- skipped on a slow/metered
    // connection or draining battery. Employees only; supervisors never
    // run the scan loop this feeds.
    const { disableYolo, networkBatteryDiagnostics } = useNetworkBatteryAdaptive(!!userProfile && userProfile.role !== 'supervisor');
    const [faceOverlayBox, setFaceOverlayBox] = useState(null);
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
    const [torchActive, setTorchActive] = useState(false);
    // 🟩 Throttles the expensive full-frame lens-obstruction scan (see below)
    // to once every 5 ticks instead of every scan tick.
    const lensCheckTickRef = useRef(0);
    const cachedLensResultRef = useRef({ ok: true, reason: null });
    const LENS_CHECK_INTERVAL_TICKS = 5;
    // 🟩 SENSOR FUSION: fuses devicemotion's x/y/z accelerometer axes into a
    // rolling stability signal — mobile-only (desktop webcams have no
    // accelerometer, so this just never becomes `ready` there, which is the
    // correct no-op). See sensors/motionStability.js.
    const motionTrackerRef = useRef(createMotionStabilityTracker());
    const microMotionTrackerRef = useRef(createMicroMotionTracker()); // 🟩 NEW: pixel-based liveness signal that works on desktop webcams too (motionTrackerRef above needs a phone/tablet accelerometer)
    const latestColorLivenessRef = useRef({ suspicious: false }); // 🟩 NEW: latest per-tick skin-color/texture plausibility read — catches a shaken physical photo/phone that would otherwise pass the motion-only signals
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

    const today = new Date().toISOString().split('T')[0]; 
    const attendanceRows = Array.isArray(attendance) ? attendance : [];
    const todayRecord = attendanceRows.find(record => record.employee_id === userProfile.id && record.date === today);

    const WORK_START_TIME = '08:00:00'; 
    const OFFICE_LOCATION = { lat: -6.20651363, lng: 106.87604852 };
    const ALLOWED_RADIUS_METERS = 100; 

    const webcamVideoRef = useRef(null);
    const referenceDescriptorRef = useRef(null);
    const faceScanBusyRef = useRef(false);
    const scanFailureStreakRef = useRef(0); // 🟩 NEW: consecutive scan-tick exceptions -- previously only ever logged to console with zero user-facing feedback
    const yoloDetectorRef = useRef(null);
    const yoloDetectorPromiseRef = useRef(null);
    const autoClockInGuardRef = useRef(false);
    const webcamStreamRef = useRef(null);
    const borderlineStreakRef = useRef(0); // consecutive borderline-tier match reads, for confidence-tiered re-check
    // Client-side pre-throttle on repeated mismatches (NOT the security boundary —
    // trivially bypassable client-side — just avoids hammering the scan loop
    // indefinitely; per utils/tokenBucket.js's documented purpose).
    const mismatchBucketRef = useRef(getBucket(`face-scan-${userProfile.id}`, { capacity: 8, refillRatePerSec: 8 / 30 }));
    const enrollmentScanBusyRef = useRef(false);
    const latestEnrollmentDetectionRef = useRef(null);

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
        const sourceContext = sourceCanvas.getContext('2d');
        if (!sourceContext) return null;
        // 🟩 LOW-LIGHT IMAGE ENHANCEMENT: when recent frames came back too
        // dark, boost brightness/contrast on the way into the capture canvas
        // instead of just rejecting every scan until the room gets brighter.
        // Standard Canvas 2D `filter` — cheap, and only active while dark.
        sourceContext.filter = isLowLightRef.current ? 'brightness(1.6) contrast(1.15)' : 'none';
        sourceContext.drawImage(imageEl, 0, 0, width, height);
        sourceContext.filter = 'none';

        if (!disableYolo) {
            try {
                const detector = await ensureYoloFaceDetector();
                const rawDetections = await detector(sourceCanvas, { threshold: YOLO_FACE_THRESHOLD });
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
                if (import.meta.env.DEV) console.info('YOLO fallback to face-api full frame.');
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
        if (!yoloDetectorPromiseRef.current) {
            const selectedModelVersion = determineYoloVersion();
            const modelId = selectedModelVersion === 'nano' ? YOLO_MODEL_IDS.nano : YOLO_MODEL_IDS.medium;

            // 🟩 SIMPLIFIED: there's no local copy of the YOLO weights under
            // public/models/ (only the face-api.js models live there), so a
            // fallback fetch to a local YOLO path was guaranteed to 404/fail
            // right after the remote Hugging Face fetch already failed --
            // just extra latency and console noise before the caller's own
            // try/catch (detectFaceFromImage) falls back to face-api.js.
            // Clearing the cached promise on failure (rather than leaving a
            // permanently-rejected promise here) lets a later scan tick
            // retry YOLO if the network/HF rate-limit recovers mid-session.
            yoloDetectorPromiseRef.current = loadTransformersModule()
                .then(({ pipeline }) => pipeline('object-detection', modelId))
                .then(detector => {
                    yoloDetectorRef.current = detector;
                    setCurrentModelVersion(selectedModelVersion);
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
    const myHistory = attendanceRows.filter(a => a.employee_id === userProfile.id);
    const totalDays = myHistory.length;
    const lateDays = myHistory.filter(a => a.status === 'Late').length;
    const punctualityScore = PunctualityPolicy.calculate(myHistory) ?? 0;

    // 🟩 NEW: Lets an intern filter their own log by On Time / Late instead of
    // scanning every card manually.
    const filteredMyHistory = myHistory.filter(a => historyStatusFilter === 'all' || a.status === historyStatusFilter);

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

                    const earthRadius = 6371000;
                    const dLat = (OFFICE_LOCATION.lat - latitude) * Math.PI / 180;
                    const dLon = (OFFICE_LOCATION.lng - longitude) * Math.PI / 180;
                    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(latitude * Math.PI / 180) * Math.cos(OFFICE_LOCATION.lat * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
                    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                    const dist = earthRadius * c;

                    setLiveDistance(dist);

                    if (userProfile.role === 'supervisor') {
                        setIsInRange(true);
                    } else {
                        const assignedMode = userProfile.work_mode || 'WFO';
                        if (assignedMode === 'WFH') {
                            setIsInRange(true);
                        } else {
                            setIsInRange(geofenceMachine.update(dist).state === 'INSIDE');
                        }
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
    }, [userProfile, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng]);

    // ==========================================
    // SENSOR FUSION: DEVICE MOTION STABILITY
    // ==========================================
    useEffect(() => {
        if (!userProfile || userProfile.role === 'supervisor' || typeof DeviceMotionEvent === 'undefined') return;

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
        if (!userProfile || userProfile.role === 'supervisor') return;

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
        if (!userProfile || userProfile.role === 'supervisor') return;
        let isCancelled = false;
        let stream = null;

        const startWebcam = async () => {
            setCameraStatus('loading');
            setCameraError(null);

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
    }, [userProfile]);

    // ==========================================
    // NEURAL MODEL ENGINE WEIGHT LOADER
    // ==========================================
    useEffect(() => {
        if (!userProfile || userProfile.role === 'supervisor') return;

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
    }, [userProfile, disableYolo, FACE_MODEL_URL, modelLoadAttempt]);

    // ==========================================
    // ACTIVE MOTION DETECTOR SCAN ENGINE HOOK
    // ==========================================
    useEffect(() => {
        if (!isCameraReady || faceStatus !== 'scanning' || todayRecord || !isTabVisible) return;

        borderlineStreakRef.current = 0;

        const timer = setInterval(async () => {
            if (faceScanBusyRef.current || !webcamVideoRef.current) return;
            faceScanBusyRef.current = true;

            try {
                // Any tick that completes without throwing means detection is healthy again.
                scanFailureStreakRef.current = 0;

                // 🟩 CORRECTED: Calls your deep yolo/faceapi abstraction layer wrapper directly
                const liveDet = await detectFaceFromImage(webcamVideoRef.current);

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
                                lensObstruction = checkLensObstruction(fullFrame.data, liveDet.sourceCanvas.width, liveDet.sourceCanvas.height);
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

                    // 🟩 READINESS BAR: same gates the pass/fail check above uses,
                    // just turned into a 0-100 score for the visual bar instead of
                    // a hard cutoff -- so the user sees themself approaching "green"
                    // rather than a flat "scanning..." message the whole time.
                    setScanReadiness(calculateFrameReadiness({
                        singleFace: singleFace.ok,
                        framing: framing.ok,
                        brightness: brightness.ok,
                        lensObstruction: lensObstruction.ok,
                        occlusion: occlusion.ok
                    }));

                    if (qualityIssue) {
                        setIsFaceVerified(false);
                        setBiometricStatus(t(QUALITY_HINT_KEYS[qualityIssue.reason] || 'attendance.statusScanning'));
                        faceScanBusyRef.current = false;
                        return;
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
                        const matchTier = classifyMatch(dist, FACE_MATCH_THRESHOLD);
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
                            // 🟩 LIVENESS: attendance needs to be fast, so this no longer
                            // waits on an explicit blink/head-turn challenge (that's still
                            // required at login, where a few extra seconds is fine). Instead
                            // it leans on passive, no-action-required signals: border-texture
                            // uniformity (checkReplaySuspicion), the device accelerometer
                            // where available (motionTrackerRef -- phones/tablets only),
                            // pixel-level micro-motion in the face region (microMotionTrackerRef
                            // -- works on any camera, desktop webcams included), and a
                            // motion-INDEPENDENT color/texture check (colorLivenessHeuristic --
                            // catches the case someone physically shakes a printed photo or a
                            // phone showing a photo/video, which would otherwise satisfy the
                            // two motion signals above without being a real face). A genuine
                            // live person almost always clears at least one signal; requiring
                            // the border check PLUS at least one of the other three before
                            // calling it suspicious keeps common false positives (someone
                            // standing very still against a plain wall) from blocking a real
                            // clock-in, while a flat photo/screen replay — even a shaken one —
                            // still gets caught by whichever signal it fails.
                            if (userProfile.work_mode === 'WFO' && !isInRange) {
                                setBiometricStatus(t('attendance.statusAccessDenied'));
                            } else if (!autoClockInGuardRef.current) {
                                let livenessSuspicious = false;
                                try {
                                    const ctx = liveDet.sourceCanvas.getContext('2d');
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

                                    livenessSuspicious = borderSuspicious && (deviceFlat || pixelFlat || colorSuspicious);
                                } catch (_err) {
                                    // Non-critical signal — a read failure (tainted canvas, out-of-bounds region) shouldn't block a real clock-in.
                                }

                                if (livenessSuspicious) {
                                    // Don't lock in or clock in this tick -- keep scanning. A
                                    // live person's signals normally clear within a tick or
                                    // two as the rolling window updates; a genuine static
                                    // replay stays flagged indefinitely instead of ever
                                    // sneaking through.
                                    setBiometricStatus(t('attendance.statusLivenessSuspicious'));
                                    toast(t('attendance.antiReplayWarning'), { icon: '⚠️' });
                                } else {
                                    autoClockInGuardRef.current = true;
                                    setBiometricStatus(t('attendance.statusMatchVerified'));
                                    clearInterval(timer);

                                    // 🟩 STALENESS REMINDER: track whether recent matches keep
                                    // coming in close to the threshold rather than confidently.
                                    const staleness = recordMatchDistance(userProfile.id, dist, FACE_MATCH_THRESHOLD);
                                    if (staleness.shouldSuggestReEnrollment) {
                                        toast(t('attendance.reEnrollSuggestion'), { icon: '🔄', duration: 6000 });
                                    }

                                    await handleClockIn('face-match');
                                }
                            }
                        } else {
                            const bucketExhausted = !mismatchBucketRef.current.tryConsume();
                            setBiometricStatus(bucketExhausted ? t('attendance.statusTooManyAttempts') : t('attendance.statusNotRecognized'));
                        }
                    }
                } else {
                    setFaceOverlayBox(null);
                    setFaceMatchDistance(null);
                    setIsFaceVerified(false);
                    setScanReadiness(0);
                    microMotionTrackerRef.current.reset(); // face gone -- don't compare the next face's frames against a stale/unrelated buffer
                    latestColorLivenessRef.current = { suspicious: false };
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
        };
        // Intentional: detectFaceFromImage and handleClockIn are redefined every
        // render (not memoized), so listing them here would tear down and
        // recreate the scan interval on every render instead of letting it run
        // steadily. userProfile.work_mode is read fresh via closure each tick;
        // work_mode changes are rare enough that a full remount isn't needed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isCameraReady, faceStatus, isInRange, todayRecord, disableYolo, isTabVisible]);

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

    const handleClockIn = async (source = 'manual') => {
        if (userProfile.role !== 'supervisor' && !currentCoords) {
            toast.error(t('attendance.gpsWaiting'));
            return false;
        }
        if (userProfile.role !== 'supervisor' && !isInRange) {
            toast.error(t('attendance.geofenceRejection'));
            return false;
        }

        // 🟩 DOUBLE CLOCK-IN GUARD: the UI already disables this button once
        // `todayRecord` is loaded, but that state can be stale — the same
        // employee open in two browser tabs, or clocking in from a phone a
        // moment after a desktop tab, both pass that check before either
        // insert lands. Web Locks (where supported) serializes concurrent
        // attempts *within this browser* across tabs; a fresh existence
        // check right before the insert then closes most of what's left of
        // the cross-device race window (can't fully close it without a DB
        // unique constraint, which is out of scope here).
        const runClockIn = async () => {
            setIsLoading(true);
            try {
                const { data: existing, error: existingCheckError } = await supabase
                    .from(ATTENDANCE_TABLE)
                    .select('id')
                    .eq('employee_id', userProfile.id)
                    .eq('date', today)
                    .maybeSingle();

                if (existingCheckError) {
                    showUserError('errors.recordAttendance', existingCheckError);
                    return false;
                }
                if (existing) {
                    toast.error(t('attendance.alreadyClockedInToday'));
                    await fetchAttendance();
                    return false;
                }

                // 🟩 Uses the Supabase server's clock (via its response `Date`
                // header), not the device's — otherwise punctuality is decided
                // by a value the user's own OS clock controls, trivially
                // spoofable by winding the system time back before clocking in.
                const now = await getServerNow();
                const time = now.toLocaleTimeString('en-GB', { hour12: false });
                const status = time > WORK_START_TIME ? 'Late' : 'Present';

                const { error } = await supabase.from(ATTENDANCE_TABLE).insert([{
                    employee_id: userProfile.id,
                    date: today,
                    status,
                    clock_in: time,
                    latitude: currentCoords ? currentCoords.latitude : null,
                    longitude: currentCoords ? currentCoords.longitude : null,
                }]);

                if (error) {
                    showUserError('errors.recordAttendance', error);
                    return false;
                }

                setClockInAt(time);
                setClockInSource(source);
                await fetchAttendance();
                return true;
            } finally {
                setIsLoading(false);
            }
        };

        if (navigator.locks?.request) {
            return navigator.locks.request(`attendance-clock-in-${userProfile.id}`, runClockIn);
        }
        return runClockIn();
    };

    const handleClockOut = async () => {
        setIsLoading(true);
        const time = (await getServerNow()).toLocaleTimeString('en-GB', { hour12: false });
        // 🟩 PRIVACY: deliberately does NOT record location at clock-out.
        // Clock-in location is tied to the geofence/attendance-legitimacy
        // check itself, which is a defensible reason to capture it -- but
        // tracking exactly where an intern was standing when they clocked
        // OUT (e.g. their home address, end of day) has no equivalent
        // business justification and is exactly the kind of function-creep
        // that runs into data-protection/privacy-law trouble. Don't collect
        // it just because it's technically easy to.
        await supabase.from(ATTENDANCE_TABLE).update({ clock_out: time }).eq('id', todayRecord.id);
        await fetchAttendance();
        setIsLoading(false);
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

            {userProfile.role === 'supervisor' ? (
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
            ) : (
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
                                <h2 className="text-base font-bold text-gray-900 dark:text-white">{t('attendance.assignedDutyProfile', { mode: (userProfile.work_mode || 'WFO') === 'WFO' ? t('attendance.officeBoundary') : t('attendance.remoteHome') })}</h2>
                                <p className={`text-xs font-bold uppercase font-mono mt-0.5 tracking-wider ${isInRange ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                    {(userProfile.work_mode || 'WFO') === 'WFO'
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
                            {todayRecord && !todayRecord.clock_out && (
                                <button type="button" onClick={handleClockOut} disabled={isLoading} className="w-full md:w-auto px-8 py-3 rounded-xl font-black text-white bg-red-600 hover:bg-red-500 transition-all shadow-md hover:-translate-y-0.5 uppercase text-xs tracking-widest">
                                    {t('attendance.clockOutShift')}
                                </button>
                            )}
                            {todayRecord && todayRecord.clock_out && (
                                <div className="w-full md:w-auto px-8 py-3 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 text-gray-400 dark:text-slate-500 font-extrabold rounded-xl text-xs uppercase tracking-widest text-center">{t('attendance.shiftCompleted')}</div>
                            )}
                         </div>
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

                                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white dark:bg-slate-900/95 border border-blue-500/30 backdrop-blur-md text-[10px] font-mono font-bold text-blue-600 dark:text-blue-400 px-3 py-1 rounded-full uppercase tracking-widest whitespace-nowrap z-30 animate-pulse shadow-2xl">
                                    {biometricStatus}
                                </div>
                            </div>

                            {/* 🟩 SCAN READINESS BAR: live clock-in scan only (enrollment wizard has its own, pose-specific bar above) */}
                            {isCameraReady && hasStoredFace && !todayRecord && enrollmentStepIndex < 0 && (
                                <div className="mt-3 w-full max-w-md">
                                    <ScanReadinessBar readiness={scanReadiness} label={t('attendance.scanReadinessLabel')} />
                                </div>
                            )}

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
                                            ENROLLMENT_POSES[enrollmentStepIndex] === 'center' ? CENTER_YAW_THRESHOLD : POSE_YAW_THRESHOLD,
                                            ENROLLMENT_POSES[enrollmentStepIndex] === 'center' ? CENTER_PITCH_THRESHOLD : POSE_PITCH_THRESHOLD
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
                                <p className="col-span-full text-center text-xs text-gray-400 dark:text-slate-500 italic py-6">{t('attendance.noMatchingRecords')}</p>
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
        </div>
    );
};

export default AttendanceView;