import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';
import { runAllConnectivityChecks } from '../utils/connectivityChecks';
import { clientErrorLogsRepository } from '../data/repositories/clientErrorLogsRepository';
import { debugDiagnosticRunsRepository } from '../data/repositories/debugDiagnosticRunsRepository';
import { showUserError } from '../utils/errorHandling';
import { supabase } from '../supabaseClient';
import { idbGet } from '../offline/indexedDbCache';
import { calculateEyeBoxes, isEyeClosed } from '../vision/livenessDetector';
import { calculateFaceOverlayStyle } from '../vision/faceOverlayGeometry';
import { profilesRepository } from '../data/repositories/profilesRepository';

// 🟩 Same lazy-load-once-and-cache pattern AttendanceView.jsx/LoginPage.jsx
// each already have their own copy of -- a third independent copy here
// (rather than refactoring either of those, which this feature has no
// reason to touch) so this diagnostic runs face-api.js standalone, without
// depending on either page's enrollment/liveness state.
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

const FACE_MODEL_URL = import.meta.env.VITE_FACE_MODEL_URL || '/models';
const OFFLINE_QUEUE_KEY = 'offline_mutation_queue';

const formatTimestamp = (date) => (date ? date.toLocaleTimeString() : null);

const StatusPill = ({ ok, label }) => (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-wider shrink-0 ${
        ok ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
    }`}>
        <span className="h-3 w-3 inline-flex">{ok ? Icons.CheckCircle : Icons.AlertTriangle}</span>
        {label}
    </span>
);

const LastRunLabel = ({ ranAt, t }) => (
    ranAt ? <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{t('debugCenter.lastRun', { time: formatTimestamp(ranAt) })}</p> : null
);

// ============================================================
// SUBMODULE 1: SYSTEM CONNECTIVITY
// ============================================================
const ConnectivitySubmodule = ({ results, setResults, ranAt, setRanAt, userProfile }) => {
    const { t } = useTranslation();
    const [isRunning, setIsRunning] = useState(false);

    const runChecks = async () => {
        setIsRunning(true);
        try {
            const outcome = await runAllConnectivityChecks();
            setResults(outcome);
            setRanAt(new Date());
            // 🟩 Fire-and-forget: persisted for the History tab's trend
            // view and the DB trigger that alerts every supervisor the
            // first time the Hugging Face CDN check fails (see
            // migrations/20260812_add_debug_diagnostic_runs.sql). Never
            // blocks or fails the on-screen result -- a supervisor still
            // sees their check outcome even if this write itself fails.
            debugDiagnosticRunsRepository.insert(userProfile.id, outcome).catch(() => {});
        } finally {
            setIsRunning(false);
        }
    };

    const LABEL_KEYS = {
        supabase: 'debugCenter.checkSupabase',
        'supabase-realtime': 'debugCenter.checkSupabaseRealtime',
        'huggingface-cdn': 'debugCenter.checkHuggingFace',
        'face-api-models': 'debugCenter.checkFaceApiModels',
    };

    return (
        <Card className="p-6">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('debugCenter.connectivityTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 max-w-md">{t('debugCenter.connectivityDescription')}</p>
                    <LastRunLabel ranAt={ranAt} t={t} />
                </div>
                <Button size="sm" onClick={runChecks} loading={isRunning}>{t('debugCenter.runChecks')}</Button>
            </div>

            {!results ? (
                <EmptyState icon={Icons.ShieldCheck} title={t('debugCenter.noChecksYetTitle')} description={t('debugCenter.noChecksYetDescription')} />
            ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                    {results.map((r) => (
                        <li key={r.label} className="flex items-center justify-between gap-3 py-3">
                            <div>
                                <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{t(LABEL_KEYS[r.label] || r.label)}</p>
                                {!r.ok && <p className="text-[11px] text-red-500 dark:text-red-400 mt-0.5">{r.error === 'timeout' ? t('debugCenter.reasonTimeout') : r.error}</p>}
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                                <span className="text-[10px] font-mono text-gray-400">{r.latencyMs}ms</span>
                                <StatusPill ok={r.ok} label={r.ok ? t('debugCenter.reachable') : t('debugCenter.unreachable')} />
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
};

// ============================================================
// SUBMODULE 2: CAMERA & FACE-RECOGNITION PIPELINE
// ============================================================
const CAMERA_ERROR_REASON = {
    NotAllowedError: 'denied', SecurityError: 'denied',
    NotFoundError: 'not-found', OverconstrainedError: 'not-found',
    NotReadableError: 'busy',
};

const PipelineStepRow = ({ step }) => (
    <li className="flex items-start justify-between gap-3 py-3">
        <div>
            <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{step.label}</p>
            {step.detail && <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{step.detail}</p>}
        </div>
        <StatusPill ok={step.ok} label={step.ok ? '✓' : '✕'} />
    </li>
);

// 🟩 LIVE DIAGNOSTIC OVERLAY: how often the live loop below runs a
// detection tick, and how often (at minimum) it's allowed to fire the
// identify_face_by_descriptor RPC -- ticking every 500ms but only
// identifying every 1.5s keeps the face/eye/blink overlay responsive
// without hammering the database with a request per frame. Same
// FACE_MATCH_THRESHOLD AttendanceView.jsx uses for a real clock-in match.
const LIVE_TICK_MS = 500;
const IDENTIFY_THROTTLE_MS = 1500;
const FACE_MATCH_THRESHOLD = 0.5;

const CameraPipelineSubmodule = ({ steps, setSteps, ranAt, setRanAt }) => {
    const { t } = useTranslation();
    const [isRunning, setIsRunning] = useState(false);
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const faceapiRef = useRef(null);
    const detectOptionsRef = useRef(null);

    // 🟩 LIVE DIAGNOSTIC OVERLAY (this round's feature): after a successful
    // pipeline run, keeps polling the still-live camera the same way
    // Login/Attendance do -- draws a box around the detected face and each
    // eye, lights an eye box up on blink, counts blinks, and (throttled)
    // asks the database who the live descriptor best matches via
    // identify_face_by_descriptor -- purely for supervisors to visually
    // confirm face/eye/blink detection AND identity matching are actually
    // working on this device, without needing a real clock-in attempt.
    const [isLiveScanning, setIsLiveScanning] = useState(false);
    const [liveFaceBox, setLiveFaceBox] = useState(null);
    const [liveEyeBoxes, setLiveEyeBoxes] = useState(null);
    const [blinkCount, setBlinkCount] = useState(0);
    const [identity, setIdentity] = useState({ status: 'idle' });
    const tickBusyRef = useRef(false);
    const identifyInFlightRef = useRef(false);
    const lastIdentifyAtRef = useRef(0);
    const eyesWereOpenRef = useRef(true);
    const runLiveTickRef = useRef(() => {});

    const stopStream = () => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
    };

    const resetLiveOverlay = () => {
        setIsLiveScanning(false);
        setLiveFaceBox(null);
        setLiveEyeBoxes(null);
        setBlinkCount(0);
        setIdentity({ status: 'idle' });
        eyesWereOpenRef.current = true;
    };

    // 🟩 BUG FIX: the camera used to die the instant a test run finished --
    // runPipelineTest previously called stopStream() again right after a
    // successful pass, unlike Login/Attendance where the preview stays live
    // continuously. Cleanup now only happens when the user actually leaves
    // this submodule (unmount) or starts a fresh run, not after every
    // successful test.
    useEffect(() => stopStream, []);

    runLiveTickRef.current = async () => {
        const video = videoRef.current;
        const faceapi = faceapiRef.current;
        if (!video || !faceapi || video.readyState < 2 || tickBusyRef.current) return;
        tickBusyRef.current = true;
        try {
            const detection = await faceapi
                .detectSingleFace(video, detectOptionsRef.current)
                .withFaceLandmarks()
                .withFaceDescriptor();

            if (!detection) {
                setLiveFaceBox(null);
                setLiveEyeBoxes(null);
                return;
            }

            const box = detection.detection.box;
            setLiveFaceBox({ x: box.x, y: box.y, width: box.width, height: box.height });

            const leftEye = detection.landmarks.getLeftEye();
            const rightEye = detection.landmarks.getRightEye();
            const leftClosed = isEyeClosed(leftEye);
            const rightClosed = isEyeClosed(rightEye);
            const geometry = calculateEyeBoxes(detection.landmarks);
            setLiveEyeBoxes(geometry ? { ...geometry, leftClosed, rightClosed } : null);

            const bothClosed = leftClosed && rightClosed;
            if (bothClosed && eyesWereOpenRef.current) {
                setBlinkCount((count) => count + 1);
                eyesWereOpenRef.current = false;
            } else if (!leftClosed && !rightClosed) {
                eyesWereOpenRef.current = true;
            }

            // 🟩 SECURITY: identifyFaceByDescriptor goes through runQuery,
            // which dedupes purely by RPC label (see apiClient.js) -- firing
            // a second call before the first resolves would let it adopt
            // the first call's in-flight promise and silently return a
            // match for a DIFFERENT (stale) descriptor. The in-flight guard
            // below, not just the time throttle, is what prevents that.
            const now = Date.now();
            if (!identifyInFlightRef.current && now - lastIdentifyAtRef.current >= IDENTIFY_THROTTLE_MS) {
                identifyInFlightRef.current = true;
                lastIdentifyAtRef.current = now;
                setIdentity((prev) => ({ ...prev, status: 'identifying' }));
                try {
                    const rows = await profilesRepository.identifyFaceByDescriptor(
                        Array.from(detection.descriptor),
                        FACE_MATCH_THRESHOLD
                    );
                    const best = rows?.[0];
                    // 🟩 BUG FIX: the RPC used to hard-filter to only rows
                    // under the match threshold, so a live capture that
                    // landed even slightly above it (different lighting/
                    // angle/detector warm-up than a real login attempt --
                    // reported live by a supervisor whose face matches fine
                    // at actual login) came back as an undifferentiated "no
                    // match", with zero visibility into how close the real
                    // nearest match was. The RPC now always returns the
                    // single closest match (if anyone in the system has an
                    // enrolled face at all) with its real distance -- this
                    // is what actually distinguishes "confident match",
                    // "found someone but not confidently enough" (still
                    // useful for testing/tuning), and "nobody enrolled at
                    // all" here.
                    // 🟩 BUG FIX (live crash): euclidean_distance_jsonb
                    // returns SQL NULL (-> JS null here) when a profile's
                    // stored template array doesn't match the live
                    // descriptor's length -- e.g. corrupted/legacy
                    // enrollment data. `null <= threshold` is TRUE in JS
                    // (null coerces to 0 in relational comparisons), which
                    // used to misclassify a null distance as a confident
                    // "identified" match and then crash on
                    // `identity.distance.toFixed(3)` in the render below.
                    // Every distance is validated as a finite number before
                    // it's trusted for comparison or display.
                    const hasValidDistance = typeof best?.distance === 'number' && Number.isFinite(best.distance);
                    if (!best) {
                        setIdentity({ status: 'noEnrollments' });
                    } else if (!hasValidDistance) {
                        setIdentity({ status: 'error', detail: 'invalid-distance' });
                    } else if (best.distance <= best.threshold) {
                        setIdentity({ status: 'identified', name: best.profile_name, role: best.profile_role, distance: best.distance });
                    } else {
                        setIdentity({ status: 'closeGuess', name: best.profile_name, role: best.profile_role, distance: best.distance, threshold: best.threshold });
                    }
                } catch (error) {
                    setIdentity({ status: 'error', detail: error?.message });
                } finally {
                    identifyInFlightRef.current = false;
                }
            }
        } catch (_error) {
            // Transient per-tick detection failure -- next tick just retries.
        } finally {
            tickBusyRef.current = false;
        }
    };

    useEffect(() => {
        if (!isLiveScanning) return undefined;
        // 🟩 Fires one tick immediately instead of waiting a full
        // LIVE_TICK_MS before the very first face/eye/identity read --
        // otherwise the overlay sits empty for half a second right after
        // the user (or the auto-start below) turns it on for no reason.
        runLiveTickRef.current();
        const intervalId = setInterval(() => { runLiveTickRef.current(); }, LIVE_TICK_MS);
        return () => clearInterval(intervalId);
    }, [isLiveScanning]);

    const runPipelineTest = async () => {
        setIsRunning(true);
        setSteps([]);
        stopStream();
        resetLiveOverlay();
        const collected = [];
        const push = (step) => { collected.push(step); setSteps([...collected]); };

        if (!navigator.mediaDevices?.getUserMedia) {
            push({ label: t('debugCenter.stepCamera'), ok: false, detail: t('debugCenter.cameraUnsupported') });
            setRanAt(new Date());
            setIsRunning(false);
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
            streamRef.current = stream;
            if (videoRef.current) videoRef.current.srcObject = stream;
            push({ label: t('debugCenter.stepCamera'), ok: true });
        } catch (error) {
            const reason = CAMERA_ERROR_REASON[error?.name] || 'unknown';
            push({ label: t('debugCenter.stepCamera'), ok: false, detail: t(`debugCenter.cameraReason_${reason}`) });
            setRanAt(new Date());
            setIsRunning(false);
            return;
        }

        let faceapi;
        try {
            faceapi = await loadFaceApiModule();
            await Promise.all([
                faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
                faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL),
                faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL),
            ]);
            faceapiRef.current = faceapi;
            detectOptionsRef.current = new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.3 });
            push({ label: t('debugCenter.stepModels'), ok: true });
        } catch (error) {
            push({ label: t('debugCenter.stepModels'), ok: false, detail: error?.message });
            stopStream();
            setRanAt(new Date());
            setIsRunning(false);
            return;
        }

        // 🟩 Deliberately no YOLO-reachability step here -- AttendanceView.jsx's
        // YOLO "revolver" (see YOLO_MODEL_CANDIDATES there) currently has no
        // confirmed-working candidate and always falls through to face-api.js,
        // so this pipeline test mirrors what actually happens on a real scan:
        // camera -> face-api.js models -> detection. General Hugging Face
        // reachability is still checked on the Connectivity tab.
        const video = videoRef.current;
        const deadline = Date.now() + 4000;
        while (video && video.readyState < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (!video || video.readyState < 2) {
            push({ label: t('debugCenter.stepDetection'), ok: false, detail: t('debugCenter.videoNotReady') });
        } else {
            try {
                const detection = await faceapi
                    .detectSingleFace(video, detectOptionsRef.current)
                    .withFaceLandmarks();
                push({
                    label: t('debugCenter.stepDetection'),
                    ok: !!detection,
                    detail: detection
                        ? t('debugCenter.detectionFoundFace', { score: Math.round((detection.detection.score || 0) * 100) })
                        : t('debugCenter.detectionNoFace'),
                });
            } catch (error) {
                push({ label: t('debugCenter.stepDetection'), ok: false, detail: error?.message });
            }
        }

        setRanAt(new Date());
        setIsRunning(false);
        // 🟩 Auto-start the live overlay the moment camera + models are both
        // confirmed working (both already returned early above on failure),
        // matching the user's ask to see face/eye/blink/identity detection
        // continuously the same way Login/Attendance do, not a one-shot
        // pass/fail line.
        setIsLiveScanning(true);
    };

    const getFaceOverlayStyle = () => calculateFaceOverlayStyle({ box: liveFaceBox, videoEl: videoRef.current });
    const getEyeOverlayStyle = (eyeBox) => calculateFaceOverlayStyle({ box: eyeBox, videoEl: videoRef.current });
    const formatRole = (role) => (role ? role.charAt(0).toUpperCase() + role.slice(1) : '');

    return (
        <Card className="p-6">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('debugCenter.cameraTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 max-w-md">{t('debugCenter.cameraDescription')}</p>
                    <LastRunLabel ranAt={ranAt} t={t} />
                </div>
                <div className="flex items-center gap-2">
                    {streamRef.current && faceapiRef.current && !isRunning && (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => (isLiveScanning ? resetLiveOverlay() : setIsLiveScanning(true))}
                        >
                            {isLiveScanning ? t('debugCenter.stopLivePreview') : t('debugCenter.startLivePreview')}
                        </Button>
                    )}
                    <Button size="sm" onClick={runPipelineTest} loading={isRunning}>{t('debugCenter.runTest')}</Button>
                </div>
            </div>

            <div className="relative w-full max-w-xs mb-4">
                <video ref={videoRef} autoPlay playsInline muted className="w-full rounded-xl bg-gray-100 dark:bg-gray-900" style={{ transform: 'scaleX(-1)' }} />

                {liveFaceBox && isLiveScanning && (
                    <div
                        className="absolute border-2 rounded-xl z-20 pointer-events-none transition-all duration-75 border-blue-400 bg-blue-500/10 shadow-[0_0_15px_rgba(96,165,250,0.3)]"
                        style={getFaceOverlayStyle() || { display: 'none' }}
                    >
                        <div className="absolute -top-6 left-0 text-[9px] font-black tracking-widest px-2 py-0.5 rounded-md text-white font-mono uppercase shadow-md bg-blue-500">
                            {t('debugCenter.liveFaceBoxLabel')}
                        </div>
                    </div>
                )}

                {liveEyeBoxes && isLiveScanning && (
                    <>
                        <div
                            aria-hidden="true"
                            className={`absolute border-2 rounded-md z-20 pointer-events-none transition-all duration-75 ${
                                liveEyeBoxes.leftClosed ? 'border-emerald-400 bg-emerald-500/20 shadow-[0_0_10px_rgba(52,211,153,0.5)]' : 'border-cyan-300/70'
                            }`}
                            style={getEyeOverlayStyle(liveEyeBoxes.left) || { display: 'none' }}
                        />
                        <div
                            aria-hidden="true"
                            className={`absolute border-2 rounded-md z-20 pointer-events-none transition-all duration-75 ${
                                liveEyeBoxes.rightClosed ? 'border-emerald-400 bg-emerald-500/20 shadow-[0_0_10px_rgba(52,211,153,0.5)]' : 'border-cyan-300/70'
                            }`}
                            style={getEyeOverlayStyle(liveEyeBoxes.right) || { display: 'none' }}
                        />
                    </>
                )}
            </div>

            {isLiveScanning && (
                <div className="mb-4 p-3 rounded-xl bg-gray-50 dark:bg-gray-900/30 border border-gray-100 dark:border-gray-700 space-y-2">
                    <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="font-bold text-gray-700 dark:text-gray-200">{t('debugCenter.liveBlinkCount', { count: blinkCount })}</span>
                        <div className="flex items-center gap-1.5">
                            <StatusPill ok={!!liveEyeBoxes && !liveEyeBoxes.leftClosed} label={`${t('debugCenter.leftEyeLabel')}: ${liveEyeBoxes?.leftClosed ? t('debugCenter.eyeStatusClosed') : t('debugCenter.eyeStatusOpen')}`} />
                            <StatusPill ok={!!liveEyeBoxes && !liveEyeBoxes.rightClosed} label={`${t('debugCenter.rightEyeLabel')}: ${liveEyeBoxes?.rightClosed ? t('debugCenter.eyeStatusClosed') : t('debugCenter.eyeStatusOpen')}`} />
                        </div>
                    </div>
                    <div className="text-xs">
                        {identity.status === 'idle' && <span className="text-gray-400 dark:text-gray-500">{t('debugCenter.identityIdle')}</span>}
                        {identity.status === 'identifying' && <span className="text-gray-400 dark:text-gray-500 animate-pulse">{t('debugCenter.identityIdentifying')}</span>}
                        {identity.status === 'identified' && (
                            <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                                {t('debugCenter.identityIdentifiedAs', { name: identity.name, role: formatRole(identity.role) })}
                                {' '}
                                <span className="text-gray-400 dark:text-gray-500 font-normal">({t('debugCenter.identityDistanceLabel', { distance: identity.distance?.toFixed?.(3) ?? '?' })})</span>
                            </span>
                        )}
                        {identity.status === 'closeGuess' && (
                            <span className="text-amber-600 dark:text-amber-400 font-bold">
                                {t('debugCenter.identityCloseGuess', { name: identity.name, role: formatRole(identity.role) })}
                                {' '}
                                <span className="text-gray-400 dark:text-gray-500 font-normal">
                                    ({t('debugCenter.identityDistanceLabel', { distance: identity.distance?.toFixed?.(3) ?? '?' })}, {t('debugCenter.identityAboveThreshold', { threshold: identity.threshold })})
                                </span>
                            </span>
                        )}
                        {identity.status === 'noEnrollments' && <span className="text-amber-600 dark:text-amber-400 font-bold">{t('debugCenter.identityUnknown')}</span>}
                        {identity.status === 'error' && <span className="text-red-600 dark:text-red-400 font-bold">{t('debugCenter.identityError')}</span>}
                    </div>
                </div>
            )}

            {steps.length === 0 ? (
                <EmptyState icon={Icons.ShieldCheck} title={t('debugCenter.noTestYetTitle')} description={t('debugCenter.noTestYetDescription')} />
            ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                    {steps.map((step, i) => <PipelineStepRow key={i} step={step} />)}
                </ul>
            )}
        </Card>
    );
};

// ============================================================
// SUBMODULE 3: BROWSER & DEVICE CAPABILITIES
// ============================================================
const CapabilitiesSubmodule = () => {
    const { t } = useTranslation();
    const capabilities = [
        { label: t('debugCenter.capCamera'), ok: !!navigator.mediaDevices?.getUserMedia },
        { label: t('debugCenter.capDeviceMotion'), ok: typeof DeviceMotionEvent !== 'undefined' },
        { label: t('debugCenter.capGeolocation'), ok: !!navigator.geolocation },
        { label: t('debugCenter.capServiceWorker'), ok: 'serviceWorker' in navigator },
        { label: t('debugCenter.capIndexedDb'), ok: typeof indexedDB !== 'undefined' },
        { label: t('debugCenter.capWebLocks'), ok: !!navigator.locks },
        { label: t('debugCenter.capNetworkInfo'), ok: !!(navigator.connection || navigator.mozConnection || navigator.webkitConnection) },
        { label: t('debugCenter.capBattery'), ok: typeof navigator.getBattery === 'function' },
    ];

    return (
        <Card className="p-6">
            <div className="mb-6">
                <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('debugCenter.capabilitiesTitle')}</h3>
                <p className="text-xs text-gray-400 dark:text-gray-500 max-w-md">{t('debugCenter.capabilitiesDescription')}</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {capabilities.map((cap) => (
                    <div key={cap.label} className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-gray-50 dark:bg-gray-900/30 border border-gray-100 dark:border-gray-700">
                        <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{cap.label}</span>
                        <StatusPill ok={cap.ok} label={cap.ok ? t('debugCenter.supported') : t('debugCenter.unsupported')} />
                    </div>
                ))}
            </div>
            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-4 italic break-all">{t('debugCenter.userAgentLabel')}: {navigator.userAgent}</p>
        </Card>
    );
};

// ============================================================
// SUBMODULE 5: STORAGE & OFFLINE
// ============================================================
const StorageSubmodule = ({ results, setResults, ranAt, setRanAt }) => {
    const { t } = useTranslation();
    const [isRunning, setIsRunning] = useState(false);

    const runChecks = async () => {
        setIsRunning(true);
        const out = {};

        try {
            const testKey = '__debug_center_probe__';
            localStorage.setItem(testKey, '1');
            localStorage.removeItem(testKey);
            out.localStorage = { ok: true };
        } catch (error) {
            out.localStorage = { ok: false, detail: error?.message };
        }

        try {
            const pendingQueue = (await idbGet(OFFLINE_QUEUE_KEY)) || [];
            out.offlineQueue = { ok: true, count: pendingQueue.length, oldest: pendingQueue[0]?.queuedAt || null };
        } catch (error) {
            out.offlineQueue = { ok: false, detail: error?.message };
        }

        try {
            if ('serviceWorker' in navigator) {
                const registration = await navigator.serviceWorker.getRegistration();
                out.serviceWorker = registration
                    ? { ok: true, state: registration.active?.state || registration.waiting?.state || registration.installing?.state || 'unknown' }
                    : { ok: false, detail: t('debugCenter.swNotRegistered') };
            } else {
                out.serviceWorker = { ok: false, detail: t('debugCenter.unsupported') };
            }
        } catch (error) {
            out.serviceWorker = { ok: false, detail: error?.message };
        }

        try {
            if ('caches' in window) {
                const names = await caches.keys();
                out.cacheStorage = { ok: true, cacheCount: names.length };
            } else {
                out.cacheStorage = { ok: false, detail: t('debugCenter.unsupported') };
            }
        } catch (error) {
            out.cacheStorage = { ok: false, detail: error?.message };
        }

        try {
            if (navigator.storage?.estimate) {
                const estimate = await navigator.storage.estimate();
                out.quota = { ok: true, usageMb: Math.round((estimate.usage || 0) / 1024 / 1024 * 10) / 10, quotaMb: Math.round((estimate.quota || 0) / 1024 / 1024) };
            } else {
                out.quota = { ok: false, detail: t('debugCenter.unsupported') };
            }
        } catch (error) {
            out.quota = { ok: false, detail: error?.message };
        }

        setResults(out);
        setRanAt(new Date());
        setIsRunning(false);
    };

    return (
        <Card className="p-6">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('debugCenter.storageTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 max-w-md">{t('debugCenter.storageDescription')}</p>
                    <LastRunLabel ranAt={ranAt} t={t} />
                </div>
                <Button size="sm" onClick={runChecks} loading={isRunning}>{t('debugCenter.runChecks')}</Button>
            </div>

            {!results ? (
                <EmptyState icon={Icons.Inbox} title={t('debugCenter.noChecksYetTitle')} description={t('debugCenter.storageEmptyDescription')} />
            ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                    <li className="flex items-center justify-between gap-3 py-3">
                        <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{t('debugCenter.storageLocalStorage')}</p>
                        <StatusPill ok={results.localStorage.ok} label={results.localStorage.ok ? t('debugCenter.working') : t('debugCenter.broken')} />
                    </li>
                    <li className="flex items-center justify-between gap-3 py-3">
                        <div>
                            <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{t('debugCenter.storageOfflineQueue')}</p>
                            {results.offlineQueue.ok && <p className="text-[11px] text-gray-400 mt-0.5">{t('debugCenter.pendingCount', { count: results.offlineQueue.count })}</p>}
                        </div>
                        <StatusPill ok={results.offlineQueue.ok} label={results.offlineQueue.ok ? t('debugCenter.readable') : t('debugCenter.broken')} />
                    </li>
                    <li className="flex items-center justify-between gap-3 py-3">
                        <div>
                            <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{t('debugCenter.storageServiceWorker')}</p>
                            {!results.serviceWorker.ok && <p className="text-[11px] text-gray-400 mt-0.5">{results.serviceWorker.detail}</p>}
                            {results.serviceWorker.ok && <p className="text-[11px] text-gray-400 mt-0.5">{results.serviceWorker.state}</p>}
                        </div>
                        <StatusPill ok={results.serviceWorker.ok} label={results.serviceWorker.ok ? t('debugCenter.active') : t('debugCenter.inactive')} />
                    </li>
                    <li className="flex items-center justify-between gap-3 py-3">
                        <div>
                            <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{t('debugCenter.storageCacheStorage')}</p>
                            {results.cacheStorage.ok && <p className="text-[11px] text-gray-400 mt-0.5">{t('debugCenter.cacheCount', { count: results.cacheStorage.cacheCount })}</p>}
                        </div>
                        <StatusPill ok={results.cacheStorage.ok} label={results.cacheStorage.ok ? t('debugCenter.available') : t('debugCenter.unsupported')} />
                    </li>
                    <li className="flex items-center justify-between gap-3 py-3">
                        <div>
                            <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{t('debugCenter.storageQuota')}</p>
                            {results.quota.ok && <p className="text-[11px] text-gray-400 mt-0.5">{t('debugCenter.quotaUsage', { used: results.quota.usageMb, total: results.quota.quotaMb })}</p>}
                        </div>
                        <StatusPill ok={results.quota.ok} label={results.quota.ok ? t('debugCenter.available') : t('debugCenter.unsupported')} />
                    </li>
                </ul>
            )}
        </Card>
    );
};

// ============================================================
// SUBMODULE 6: SESSION & AUTH
// ============================================================
const maskEmail = (email) => {
    if (!email || !email.includes('@')) return email || '';
    const [local, domain] = email.split('@');
    return `${local.slice(0, 2)}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
};

const SessionSubmodule = ({ results, setResults, ranAt, setRanAt }) => {
    const { t } = useTranslation();
    const [isRunning, setIsRunning] = useState(false);

    const runChecks = async () => {
        setIsRunning(true);
        const out = {};
        try {
            const { data: { session }, error } = await supabase.auth.getSession();
            if (error || !session) {
                out.session = { ok: false, detail: error?.message || t('debugCenter.noActiveSession') };
            } else {
                const expiresInSec = session.expires_at ? session.expires_at - Math.floor(Date.now() / 1000) : null;
                out.session = {
                    ok: true,
                    email: maskEmail(session.user.email),
                    expiresInMin: expiresInSec !== null ? Math.max(0, Math.round(expiresInSec / 60)) : null,
                };
            }
        } catch (error) {
            out.session = { ok: false, detail: error?.message };
        }

        try {
            const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
            out.mfa = error ? { ok: false, detail: error.message } : { ok: true, level: data.currentLevel };
        } catch (error) {
            out.mfa = { ok: false, detail: error?.message };
        }

        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) {
                out.rlsSelfRead = { ok: false, detail: t('debugCenter.noActiveSession') };
            } else {
                const { error } = await supabase.from('profiles').select('id').eq('id', user.id).maybeSingle();
                out.rlsSelfRead = error ? { ok: false, detail: error.message } : { ok: true };
            }
        } catch (error) {
            out.rlsSelfRead = { ok: false, detail: error?.message };
        }

        setResults(out);
        setRanAt(new Date());
        setIsRunning(false);
    };

    return (
        <Card className="p-6">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('debugCenter.sessionTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 max-w-md">{t('debugCenter.sessionDescription')}</p>
                    <LastRunLabel ranAt={ranAt} t={t} />
                </div>
                <Button size="sm" onClick={runChecks} loading={isRunning}>{t('debugCenter.runChecks')}</Button>
            </div>

            {!results ? (
                <EmptyState icon={Icons.Lock} title={t('debugCenter.noChecksYetTitle')} description={t('debugCenter.sessionEmptyDescription')} />
            ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                    <li className="flex items-center justify-between gap-3 py-3">
                        <div>
                            <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{t('debugCenter.sessionActive')}</p>
                            {results.session.ok
                                ? <p className="text-[11px] text-gray-400 mt-0.5">{results.session.email} · {t('debugCenter.expiresIn', { minutes: results.session.expiresInMin })}</p>
                                : <p className="text-[11px] text-red-500 mt-0.5">{results.session.detail}</p>}
                        </div>
                        <StatusPill ok={results.session.ok} label={results.session.ok ? t('debugCenter.active') : t('debugCenter.inactive')} />
                    </li>
                    <li className="flex items-center justify-between gap-3 py-3">
                        <div>
                            <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{t('debugCenter.sessionMfaLevel')}</p>
                            {results.mfa.ok && <p className="text-[11px] text-gray-400 mt-0.5">{results.mfa.level}</p>}
                        </div>
                        <StatusPill ok={results.mfa.ok} label={results.mfa.ok ? t('debugCenter.readable') : t('debugCenter.broken')} />
                    </li>
                    <li className="flex items-center justify-between gap-3 py-3">
                        <div>
                            <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{t('debugCenter.sessionRlsCheck')}</p>
                            {!results.rlsSelfRead.ok && <p className="text-[11px] text-red-500 mt-0.5">{results.rlsSelfRead.detail}</p>}
                        </div>
                        <StatusPill ok={results.rlsSelfRead.ok} label={results.rlsSelfRead.ok ? t('debugCenter.working') : t('debugCenter.broken')} />
                    </li>
                </ul>
            )}
        </Card>
    );
};

// ============================================================
// SUBMODULE 7: REALTIME
// ============================================================
const RealtimeSubmodule = ({ result, setResult, ranAt, setRanAt }) => {
    const { t } = useTranslation();
    const [isRunning, setIsRunning] = useState(false);

    const runCheck = async () => {
        setIsRunning(true);
        const startedAt = performance.now();
        const channel = supabase.channel(`debug-center-ping-${Date.now()}`);

        const outcome = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 6000);
            channel.subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    clearTimeout(timer);
                    resolve({ ok: true });
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    clearTimeout(timer);
                    resolve({ ok: false, reason: status });
                }
            });
        });

        await supabase.removeChannel(channel);
        setResult({ ...outcome, latencyMs: Math.round(performance.now() - startedAt) });
        setRanAt(new Date());
        setIsRunning(false);
    };

    return (
        <Card className="p-6">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('debugCenter.realtimeTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 max-w-md">{t('debugCenter.realtimeDescription')}</p>
                    <LastRunLabel ranAt={ranAt} t={t} />
                </div>
                <Button size="sm" onClick={runCheck} loading={isRunning}>{t('debugCenter.runChecks')}</Button>
            </div>

            {!result ? (
                <EmptyState icon={Icons.Bell} title={t('debugCenter.noChecksYetTitle')} description={t('debugCenter.realtimeEmptyDescription')} />
            ) : (
                <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-900/30 border border-gray-100 dark:border-gray-700">
                    <div>
                        <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{t('debugCenter.realtimeChannelTest')}</p>
                        {!result.ok && <p className="text-[11px] text-red-500 mt-0.5">{result.reason === 'timeout' ? t('debugCenter.reasonTimeout') : result.reason}</p>}
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="text-[10px] font-mono text-gray-400">{result.latencyMs}ms</span>
                        <StatusPill ok={result.ok} label={result.ok ? t('debugCenter.connected') : t('debugCenter.failed')} />
                    </div>
                </div>
            )}
        </Card>
    );
};

// ============================================================
// SUBMODULE 8: PERFORMANCE & DEVICE
// ============================================================
const PerformanceSubmodule = ({ results, setResults, ranAt, setRanAt }) => {
    const { t } = useTranslation();
    const [isRunning, setIsRunning] = useState(false);

    const runChecks = async () => {
        setIsRunning(true);
        const device = {
            cores: navigator.hardwareConcurrency || null,
            memoryGb: navigator.deviceMemory || null,
            viewport: `${window.innerWidth}×${window.innerHeight}`,
            pixelRatio: window.devicePixelRatio || 1,
            prefersDarkMode: window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? null,
            jsHeapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) : null,
        };

        let network = null;
        try {
            const url = `${FACE_MODEL_URL}/tiny_face_detector_model-weights_manifest.json?cachebust=${Date.now()}`;
            const startedAt = performance.now();
            const res = await fetch(url, { cache: 'no-store' });
            const blob = await res.blob();
            const elapsedSec = (performance.now() - startedAt) / 1000;
            network = { ok: true, kbps: elapsedSec > 0 ? Math.round((blob.size / 1024) / elapsedSec) : null, sizeBytes: blob.size };
        } catch (error) {
            network = { ok: false, detail: error?.message };
        }

        setResults({ device, network });
        setRanAt(new Date());
        setIsRunning(false);
    };

    return (
        <Card className="p-6">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('debugCenter.performanceTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 max-w-md">{t('debugCenter.performanceDescription')}</p>
                    <LastRunLabel ranAt={ranAt} t={t} />
                </div>
                <Button size="sm" onClick={runChecks} loading={isRunning}>{t('debugCenter.runChecks')}</Button>
            </div>

            {!results ? (
                <EmptyState icon={Icons.ScatterChart} title={t('debugCenter.noChecksYetTitle')} description={t('debugCenter.performanceEmptyDescription')} />
            ) : (
                <div className="space-y-4">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-900/30 border border-gray-100 dark:border-gray-700">
                            <p className="text-[10px] font-bold text-gray-400 uppercase">{t('debugCenter.perfCores')}</p>
                            <p className="text-sm font-bold text-gray-800 dark:text-gray-100">{results.device.cores ?? '—'}</p>
                        </div>
                        <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-900/30 border border-gray-100 dark:border-gray-700">
                            <p className="text-[10px] font-bold text-gray-400 uppercase">{t('debugCenter.perfMemory')}</p>
                            <p className="text-sm font-bold text-gray-800 dark:text-gray-100">{results.device.memoryGb ? `${results.device.memoryGb} GB` : '—'}</p>
                        </div>
                        <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-900/30 border border-gray-100 dark:border-gray-700">
                            <p className="text-[10px] font-bold text-gray-400 uppercase">{t('debugCenter.perfViewport')}</p>
                            <p className="text-sm font-bold text-gray-800 dark:text-gray-100">{results.device.viewport}</p>
                        </div>
                        <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-900/30 border border-gray-100 dark:border-gray-700">
                            <p className="text-[10px] font-bold text-gray-400 uppercase">{t('debugCenter.perfPixelRatio')}</p>
                            <p className="text-sm font-bold text-gray-800 dark:text-gray-100">{results.device.pixelRatio}×</p>
                        </div>
                        <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-900/30 border border-gray-100 dark:border-gray-700">
                            <p className="text-[10px] font-bold text-gray-400 uppercase">{t('debugCenter.perfJsHeap')}</p>
                            <p className="text-sm font-bold text-gray-800 dark:text-gray-100">{results.device.jsHeapMb ? `${results.device.jsHeapMb} MB` : '—'}</p>
                        </div>
                        <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-900/30 border border-gray-100 dark:border-gray-700">
                            <p className="text-[10px] font-bold text-gray-400 uppercase">{t('debugCenter.perfNetworkSpeed')}</p>
                            <p className="text-sm font-bold text-gray-800 dark:text-gray-100">{results.network.ok ? `~${results.network.kbps} KB/s` : '—'}</p>
                        </div>
                    </div>
                </div>
            )}
        </Card>
    );
};

// ============================================================
// SUBMODULE 9: DIAGNOSTIC HISTORY
// ============================================================
const CHECK_LABELS_ORDER = ['supabase', 'supabase-realtime', 'huggingface-cdn', 'face-api-models'];

const HistorySubmodule = () => {
    const { t } = useTranslation();
    const [runs, setRuns] = useState(null);
    const [isLoading, setIsLoading] = useState(false);

    const fetchHistory = async () => {
        setIsLoading(true);
        try {
            const data = await debugDiagnosticRunsRepository.listRecent();
            setRuns(data || []);
        } catch (error) {
            showUserError('errors.fetchAuditLog', error);
        } finally {
            setIsLoading(false);
        }
    };

    const LABEL_KEYS = {
        supabase: 'debugCenter.checkSupabase',
        'supabase-realtime': 'debugCenter.checkSupabaseRealtime',
        'huggingface-cdn': 'debugCenter.checkHuggingFace',
        'face-api-models': 'debugCenter.checkFaceApiModels',
    };

    // 🟩 The whole point of persisting runs: "has this been flaky?" instead
    // of only ever seeing the most recent snapshot. Computed per check
    // label across whatever's been fetched (most recent 20 runs).
    const trend = runs && runs.length > 0
        ? CHECK_LABELS_ORDER.map((label) => {
            const readings = runs
                .map((run) => (Array.isArray(run.results) ? run.results.find((r) => r.label === label) : null))
                .filter(Boolean);
            const failures = readings.filter((r) => !r.ok).length;
            return { label, failures, total: readings.length };
        })
        : [];

    return (
        <Card className="p-6">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('debugCenter.historyTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 max-w-md">{t('debugCenter.historyDescription')}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={fetchHistory} loading={isLoading}>{t('debugCenter.refresh')}</Button>
            </div>

            {runs === null ? (
                <EmptyState icon={Icons.FileClock} title={t('debugCenter.noHistoryCheckedTitle')} description={t('debugCenter.noHistoryCheckedDescription')} />
            ) : runs.length === 0 ? (
                <EmptyState icon={Icons.FileClock} title={t('debugCenter.noHistoryTitle')} description={t('debugCenter.noHistoryDescription')} />
            ) : (
                <div className="space-y-6">
                    <div>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">{t('debugCenter.historyTrend', { count: runs.length })}</h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {trend.map((item) => (
                                <div key={item.label} className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-gray-50 dark:bg-gray-900/30 border border-gray-100 dark:border-gray-700">
                                    <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{t(LABEL_KEYS[item.label])}</span>
                                    <StatusPill ok={item.failures === 0} label={t('debugCenter.failedOutOf', { failures: item.failures, total: item.total })} />
                                </div>
                            ))}
                        </div>
                    </div>

                    <div>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">{t('debugCenter.historyRuns')}</h4>
                        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                            {runs.map((run) => (
                                <li key={run.id} className="flex items-center justify-between gap-3 py-2.5">
                                    <span className="text-[11px] text-gray-500 dark:text-gray-400">{new Date(run.created_at).toLocaleString()}</span>
                                    <div className="flex items-center gap-1.5">
                                        {(Array.isArray(run.results) ? run.results : []).map((r) => (
                                            <span
                                                key={r.label}
                                                title={t(LABEL_KEYS[r.label] || r.label)}
                                                className={`h-2.5 w-2.5 rounded-full ${r.ok ? 'bg-emerald-500' : 'bg-red-500'}`}
                                            />
                                        ))}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            )}
        </Card>
    );
};

// ============================================================
// SUBMODULE 4: RECENT CLIENT ERRORS
// ============================================================
const RecentErrorsSubmodule = ({ setActiveView, entries, setEntries }) => {
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(false);

    const fetchRecent = async () => {
        setIsLoading(true);
        try {
            const data = await clientErrorLogsRepository.listRecent();
            setEntries((data || []).slice(0, 5));
        } catch (error) {
            showUserError('errors.fetchAuditLog', error);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Card className="p-6">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('debugCenter.errorsTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 max-w-md">{t('debugCenter.errorsDescription')}</p>
                </div>
                <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={fetchRecent} loading={isLoading}>{t('debugCenter.refresh')}</Button>
                    {setActiveView && (
                        <Button size="sm" variant="ghost" onClick={() => setActiveView('errorMonitor')}>{t('debugCenter.viewFullLog')}</Button>
                    )}
                </div>
            </div>

            {entries === null ? (
                <EmptyState icon={Icons.AlertTriangle} title={t('debugCenter.noErrorsCheckedTitle')} description={t('debugCenter.noErrorsCheckedDescription')} />
            ) : entries.length === 0 ? (
                <EmptyState icon={Icons.CheckCircle} title={t('debugCenter.noErrorsTitle')} />
            ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                    {entries.map((entry) => (
                        <li key={entry.id} className="py-3">
                            <p className="text-xs font-bold text-gray-700 dark:text-gray-200 truncate">{entry.message}</p>
                            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{new Date(entry.created_at).toLocaleString()}</p>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
};

// ============================================================
// MAIN VIEW
// ============================================================
const DebugCenterView = ({ setActiveView, userProfile }) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState('connectivity');

    // 🟩 Lifted (not local to each submodule) specifically so
    // handleExportReport below can bundle whatever's already been run,
    // from any tab, into one downloadable file -- a supervisor forwarding
    // a single JSON to whoever's actually debugging the reported issue,
    // instead of describing five separate screens over chat.
    const [connectivityResults, setConnectivityResults] = useState(null);
    const [connectivityRanAt, setConnectivityRanAt] = useState(null);
    const [pipelineSteps, setPipelineSteps] = useState([]);
    const [pipelineRanAt, setPipelineRanAt] = useState(null);
    const [storageResults, setStorageResults] = useState(null);
    const [storageRanAt, setStorageRanAt] = useState(null);
    const [sessionResults, setSessionResults] = useState(null);
    const [sessionRanAt, setSessionRanAt] = useState(null);
    const [realtimeResult, setRealtimeResult] = useState(null);
    const [realtimeRanAt, setRealtimeRanAt] = useState(null);
    const [performanceResults, setPerformanceResults] = useState(null);
    const [performanceRanAt, setPerformanceRanAt] = useState(null);
    const [errorEntries, setErrorEntries] = useState(null);

    const hasAnyResults = connectivityResults || pipelineSteps.length > 0 || storageResults || sessionResults || realtimeResult || performanceResults || errorEntries;

    const handleExportReport = useCallback(() => {
        const report = {
            generatedAt: new Date().toISOString(),
            appMode: import.meta.env.MODE,
            userAgent: navigator.userAgent,
            connectivity: connectivityResults,
            cameraPipeline: pipelineSteps,
            storage: storageResults,
            session: sessionResults,
            realtime: realtimeResult,
            performance: performanceResults,
            recentErrors: errorEntries,
        };
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `debug-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }, [connectivityResults, pipelineSteps, storageResults, sessionResults, realtimeResult, performanceResults, errorEntries]);

    const TABS = [
        { id: 'connectivity', label: t('debugCenter.tabConnectivity'), icon: Icons.ShieldCheck },
        { id: 'camera', label: t('debugCenter.tabCamera'), icon: Icons.CpuChip },
        { id: 'storage', label: t('debugCenter.tabStorage'), icon: Icons.Inbox },
        { id: 'session', label: t('debugCenter.tabSession'), icon: Icons.Lock },
        { id: 'realtime', label: t('debugCenter.tabRealtime'), icon: Icons.Bell },
        { id: 'performance', label: t('debugCenter.tabPerformance'), icon: Icons.ScatterChart },
        { id: 'capabilities', label: t('debugCenter.tabCapabilities'), icon: Icons.ClipboardCheck },
        { id: 'history', label: t('debugCenter.tabHistory'), icon: Icons.FileClock },
        { id: 'errors', label: t('debugCenter.tabErrors'), icon: Icons.AlertTriangle },
    ];

    return (
        <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">{t('debugCenter.title')}</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{t('debugCenter.subtitle')}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={handleExportReport} disabled={!hasAnyResults}>
                    {t('debugCenter.exportReport')}
                </Button>
            </div>

            <div className="flex gap-2 flex-wrap border-b border-gray-200 dark:border-gray-700 pb-3">
                {TABS.map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        aria-current={activeTab === tab.id ? 'page' : undefined}
                        className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-colors ${
                            activeTab === tab.id
                                ? 'bg-indigo-600 text-white'
                                : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                        }`}
                    >
                        <span className="h-4 w-4 inline-flex">{tab.icon}</span>
                        {tab.label}
                    </button>
                ))}
            </div>

            {activeTab === 'connectivity' && (
                <ConnectivitySubmodule results={connectivityResults} setResults={setConnectivityResults} ranAt={connectivityRanAt} setRanAt={setConnectivityRanAt} userProfile={userProfile} />
            )}
            {activeTab === 'camera' && (
                <CameraPipelineSubmodule steps={pipelineSteps} setSteps={setPipelineSteps} ranAt={pipelineRanAt} setRanAt={setPipelineRanAt} />
            )}
            {activeTab === 'storage' && (
                <StorageSubmodule results={storageResults} setResults={setStorageResults} ranAt={storageRanAt} setRanAt={setStorageRanAt} />
            )}
            {activeTab === 'session' && (
                <SessionSubmodule results={sessionResults} setResults={setSessionResults} ranAt={sessionRanAt} setRanAt={setSessionRanAt} />
            )}
            {activeTab === 'realtime' && (
                <RealtimeSubmodule result={realtimeResult} setResult={setRealtimeResult} ranAt={realtimeRanAt} setRanAt={setRealtimeRanAt} />
            )}
            {activeTab === 'performance' && (
                <PerformanceSubmodule results={performanceResults} setResults={setPerformanceResults} ranAt={performanceRanAt} setRanAt={setPerformanceRanAt} />
            )}
            {activeTab === 'capabilities' && <CapabilitiesSubmodule />}
            {activeTab === 'history' && <HistorySubmodule />}
            {activeTab === 'errors' && (
                <RecentErrorsSubmodule setActiveView={setActiveView} entries={errorEntries} setEntries={setErrorEntries} />
            )}
        </div>
    );
};

export default DebugCenterView;
