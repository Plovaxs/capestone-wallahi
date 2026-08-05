import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getNetworkProfile } from '../utils/deviceAdaptive';

/**
 * A persistent, always-visible strip (not an ephemeral toast that can be
 * missed) telling the user their connection is bad -- either fully offline
 * or "connected but slow" (2g/3g/save-data, via the Network Information
 * API where it's supported). Toasts fire once per failed action; this
 * stays up for as long as the underlying condition does, so someone on a
 * weak connection understands *why* things feel slow/stale the whole time,
 * not just after the first thing fails.
 */
const NetworkStatusBanner = () => {
    const { t } = useTranslation();
    const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' && !navigator.onLine);
    const [isSlow, setIsSlow] = useState(() => getNetworkProfile().isSlow);

    useEffect(() => {
        const handleOnline = () => setIsOffline(false);
        const handleOffline = () => setIsOffline(true);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        const updateSlow = () => setIsSlow(getNetworkProfile().isSlow);
        connection?.addEventListener?.('change', updateSlow);

        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
            connection?.removeEventListener?.('change', updateSlow);
        };
    }, []);

    if (!isOffline && !isSlow) return null;

    return (
        <div
            role="status"
            className={`no-print flex items-center justify-center gap-2 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-center ${
                isOffline
                    ? 'bg-red-600 text-white'
                    : 'bg-amber-500 text-slate-900'
            }`}
        >
            <span aria-hidden="true">{isOffline ? '📴' : '🐢'}</span>
            {isOffline ? t('offline.bannerOffline') : t('offline.bannerSlow')}
        </div>
    );
};

export default NetworkStatusBanner;
