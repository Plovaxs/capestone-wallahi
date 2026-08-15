import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { decodeBadgePayload } from '../utils/employeeBadge';
import ModuleTabBar from '../components/ModuleTabBar';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';

/**
 * VIEW: BadgeScannerView
 * PURPOSE: Supervisor-facing "verify who this badge belongs to" kiosk --
 * scans the QR badge from IdBadgeView.jsx via the device camera (jsQR
 * decoding raw video frames, no server round trip) and looks the decoded
 * id up in the already-fetched roster. Read-only identity lookup, NOT an
 * attendance or authentication action -- see utils/employeeBadge.js.
 */
const BadgeScannerView = ({ userProfile, allUsers = [] }) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState('scanner');
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const streamRef = useRef(null);
    const rafRef = useRef(null);
    const [scanning, setScanning] = useState(false);
    const [cameraError, setCameraError] = useState(null);
    const [matchedEmployee, setMatchedEmployee] = useState(null);
    const [notFound, setNotFound] = useState(false);
    // 🟩 NEW SUBMODULE: Scan History -- purely in-memory, this-session-only
    // log of every scan attempt (matched or not), newest first. No new
    // backend/table -- badge scans were never persisted anywhere before,
    // and this view has no reason to be the first thing in the app that
    // starts writing scan events to the database. Solves the real gap the
    // original view had: a supervisor scanning a stack of badges at a
    // front desk had no way to see who they'd already checked.
    const [scanHistory, setScanHistory] = useState([]);
    // 🟩 NEW SUBMODULE: Manual Lookup -- a camera-free fallback search over
    // the same already-fetched `allUsers`, for when the camera isn't
    // available/practical (e.g. a badge is damaged/unreadable but the
    // supervisor still needs to confirm who someone is).
    const [lookupQuery, setLookupQuery] = useState('');

    const stopCamera = useCallback(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        }
        setScanning(false);
    }, []);

    const scanFrame = useCallback(async () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
            rafRef.current = requestAnimationFrame(scanFrame);
            return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const { default: jsQR } = await import('jsqr');
        const code = jsQR(imageData.data, imageData.width, imageData.height);

        if (code?.data) {
            const decoded = decodeBadgePayload(code.data);
            if (decoded) {
                const profile = allUsers.find((u) => u.id === decoded.id);
                if (profile) { setMatchedEmployee(profile); setNotFound(false); }
                else { setMatchedEmployee(null); setNotFound(true); }
                setScanHistory((prev) => [
                    { id: `${Date.now()}-${decoded.id}`, scannedAt: new Date(), name: profile?.name || decoded.name, matched: !!profile },
                    ...prev,
                ].slice(0, 50));
                stopCamera();
                return;
            }
        }
        rafRef.current = requestAnimationFrame(scanFrame);
    }, [allUsers, stopCamera]);

    const startCamera = async () => {
        setMatchedEmployee(null);
        setNotFound(false);
        setCameraError(null);
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                setCameraError(t('badgeScanner.unsupported'));
                return;
            }
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            setScanning(true);
            rafRef.current = requestAnimationFrame(scanFrame);
        } catch {
            setCameraError(t('badgeScanner.cameraDenied'));
        }
    };

    useEffect(() => () => stopCamera(), [stopCamera]);

    const lookupResults = useMemo(() => {
        const query = lookupQuery.trim().toLowerCase();
        if (!query) return [];
        return allUsers
            .filter((u) => u.role === 'employee' && u.name?.toLowerCase().includes(query))
            .slice(0, 20);
    }, [allUsers, lookupQuery]);

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('badgeScanner.supervisorOnly')}
            </div>
        );
    }

    const tabs = [
        { id: 'scanner', label: t('badgeScanner.tabScanner'), icon: Icons.QrCode },
        { id: 'history', label: t('badgeScanner.tabHistory'), icon: Icons.FileClock },
        { id: 'lookup', label: t('badgeScanner.tabLookup'), icon: Icons.UsersGroup },
    ];

    return (
        <div className="p-4 md:p-8 max-w-md mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('badgeScanner.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('badgeScanner.subtitle')}</p>
            </div>

            <ModuleTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'scanner' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6 space-y-4">
                    <div className="relative w-full aspect-square bg-gray-900 rounded-xl overflow-hidden">
                        <video ref={videoRef} className={`w-full h-full object-cover ${scanning ? '' : 'hidden'}`} muted playsInline />
                        <canvas ref={canvasRef} className="hidden" />
                        {!scanning && (
                            <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-xs">
                                {t('badgeScanner.idle')}
                            </div>
                        )}
                    </div>

                    {cameraError && <p className="text-xs text-red-500 text-center">{cameraError}</p>}

                    <button
                        type="button"
                        onClick={scanning ? stopCamera : startCamera}
                        className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 transition-all text-xs"
                    >
                        {scanning ? t('badgeScanner.stop') : t('badgeScanner.start')}
                    </button>

                    {matchedEmployee && (
                        <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50">
                            <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider mb-1">{t('badgeScanner.matched')}</p>
                            <p className="font-bold text-sm text-gray-800 dark:text-gray-100">{matchedEmployee.name}</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {matchedEmployee.position || t('dashboard.notSet')} &middot; {matchedEmployee.department || t('dashboard.notSet')}
                            </p>
                        </div>
                    )}
                    {notFound && (
                        <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 text-xs font-bold text-red-600 dark:text-red-400 text-center">
                            {t('badgeScanner.noMatch')}
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'history' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                    <div className="p-5 pb-3">
                        <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('badgeScanner.historyTitle')}</h2>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{t('badgeScanner.historyDescription')}</p>
                    </div>
                    {scanHistory.length === 0 ? (
                        <EmptyState icon={Icons.FileClock} title={t('badgeScanner.noScansYet')} />
                    ) : (
                        <div className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {scanHistory.map((scan) => (
                                <div key={scan.id} className="p-4 flex items-center justify-between gap-4">
                                    <div className="min-w-0">
                                        <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{scan.name || t('badgeScanner.unknownBadge')}</p>
                                        <p className="text-[10px] text-gray-400 dark:text-gray-500">{scan.scannedAt.toLocaleTimeString()}</p>
                                    </div>
                                    <span className={`text-[10px] font-bold px-2 py-1 rounded-lg shrink-0 ${
                                        scan.matched
                                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                                            : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                                    }`}>
                                        {scan.matched ? t('badgeScanner.matched') : t('badgeScanner.noMatch')}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'lookup' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6 space-y-4">
                    <div>
                        <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('badgeScanner.lookupTitle')}</h2>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{t('badgeScanner.lookupDescription')}</p>
                    </div>
                    <input
                        type="text"
                        value={lookupQuery}
                        onChange={(e) => setLookupQuery(e.target.value)}
                        placeholder={t('badgeScanner.lookupPlaceholder')}
                        className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {lookupQuery.trim() && lookupResults.length === 0 && (
                        <EmptyState icon={Icons.UsersGroup} title={t('badgeScanner.noLookupResults')} />
                    )}
                    {lookupResults.length > 0 && (
                        <div className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {lookupResults.map((emp) => (
                                <div key={emp.id} className="py-3">
                                    <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{emp.name}</p>
                                    <p className="text-[10px] text-gray-400 dark:text-gray-500">
                                        {emp.position || t('dashboard.notSet')} &middot; {emp.department || t('dashboard.notSet')}
                                    </p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default BadgeScannerView;
