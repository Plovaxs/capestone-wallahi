import React, { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';
import { runAllConnectivityChecks, checkHuggingFaceCdnReachable } from '../utils/connectivityChecks';
import { clientErrorLogsRepository } from '../data/repositories/clientErrorLogsRepository';
import { debugDiagnosticRunsRepository } from '../data/repositories/debugDiagnosticRunsRepository';
import { showUserError } from '../utils/errorHandling';
import { supabase } from '../supabaseClient';
import { idbGet } from '../offline/indexedDbCache';

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

const CameraPipelineSubmodule = ({ steps, setSteps, ranAt, setRanAt }) => {
    const { t } = useTranslation();
    const [isRunning, setIsRunning] = useState(false);
    const videoRef = useRef(null);
    const streamRef = useRef(null);

    const stopStream = () => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
    };

    const runPipelineTest = async () => {
        setIsRunning(true);
        setSteps([]);
        stopStream();
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
            push({ label: t('debugCenter.stepModels'), ok: true });
        } catch (error) {
            push({ label: t('debugCenter.stepModels'), ok: false, detail: error?.message });
            stopStream();
            setRanAt(new Date());
            setIsRunning(false);
            return;
        }

        const yoloCheck = await checkHuggingFaceCdnReachable();
        push({
            label: t('debugCenter.stepYolo'),
            ok: yoloCheck.ok,
            detail: yoloCheck.ok ? undefined : t('debugCenter.yoloUnreachableHint'),
        });

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
                    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.3 }))
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

        stopStream();
        setRanAt(new Date());
        setIsRunning(false);
    };

    return (
        <Card className="p-6">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('debugCenter.cameraTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 max-w-md">{t('debugCenter.cameraDescription')}</p>
                    <LastRunLabel ranAt={ranAt} t={t} />
                </div>
                <Button size="sm" onClick={runPipelineTest} loading={isRunning}>{t('debugCenter.runTest')}</Button>
            </div>

            <video ref={videoRef} autoPlay playsInline muted className="w-full max-w-xs rounded-xl bg-gray-100 dark:bg-gray-900 mb-4" style={{ transform: 'scaleX(-1)' }} />

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
