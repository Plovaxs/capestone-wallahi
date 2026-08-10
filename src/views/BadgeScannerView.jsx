import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { decodeBadgePayload } from '../utils/employeeBadge';

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
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const streamRef = useRef(null);
    const rafRef = useRef(null);
    const [scanning, setScanning] = useState(false);
    const [cameraError, setCameraError] = useState(null);
    const [matchedEmployee, setMatchedEmployee] = useState(null);
    const [notFound, setNotFound] = useState(false);

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

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('badgeScanner.supervisorOnly')}
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-md mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('badgeScanner.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('badgeScanner.subtitle')}</p>
            </div>

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
        </div>
    );
};

export default BadgeScannerView;
