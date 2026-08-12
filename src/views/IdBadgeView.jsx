import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { encodeBadgePayload } from '../utils/employeeBadge';
import Skeleton from '../components/Skeleton';

/**
 * VIEW: IdBadgeView
 * PURPOSE: Generates a scannable QR ID badge for the logged-in user --
 * downloadable/printable, for physical/visual identity verification (see
 * BadgeScannerView.jsx). Deliberately NOT wired into clock-in or any
 * authentication path -- see utils/employeeBadge.js for why.
 */
const IdBadgeView = ({ userProfile }) => {
    const { t } = useTranslation();
    const [dataUrl, setDataUrl] = useState(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { default: QRCode } = await import('qrcode');
                const payload = encodeBadgePayload(userProfile);
                const url = await QRCode.toDataURL(payload, { width: 280, margin: 2, color: { dark: '#1e293b', light: '#ffffff' } });
                if (!cancelled) setDataUrl(url);
            } catch {
                if (!cancelled) setError(true);
            }
        })();
        return () => { cancelled = true; };
    }, [userProfile]);

    const handleDownload = () => {
        if (!dataUrl) return;
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `badge_${(userProfile.name || 'employee').replace(/\s+/g, '_')}.png`;
        link.click();
    };

    return (
        <div className="p-4 md:p-8 max-w-md mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('idBadge.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('idBadge.subtitle')}</p>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6 flex flex-col items-center text-center">
                <div className="w-16 h-16 rounded-full bg-blue-50 dark:bg-blue-950/30 overflow-hidden mb-3 flex items-center justify-center text-2xl font-extrabold text-blue-600 dark:text-blue-400">
                    {userProfile.avatar_url ? (
                        <img src={userProfile.avatar_url} alt="" className="w-full h-full object-cover" />
                    ) : (userProfile.name?.charAt(0))}
                </div>
                <p className="font-bold text-gray-800 dark:text-gray-100">{userProfile.name}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-5">
                    {userProfile.position || t('dashboard.notSet')} &middot; {userProfile.department || t('dashboard.notSet')}
                </p>

                {error ? (
                    <p className="text-xs text-red-500">{t('idBadge.generateError')}</p>
                ) : dataUrl ? (
                    <img src={dataUrl} alt={t('idBadge.title')} className="rounded-xl border border-gray-100 dark:border-gray-700" />
                ) : (
                    <Skeleton className="w-[280px] h-[280px] rounded-xl" />
                )}

                <button
                    type="button"
                    onClick={handleDownload}
                    disabled={!dataUrl}
                    className="mt-5 w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all text-xs"
                >
                    {t('idBadge.download')}
                </button>
                <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-4 leading-relaxed">{t('idBadge.disclaimer')}</p>
            </div>
        </div>
    );
};

export default IdBadgeView;
