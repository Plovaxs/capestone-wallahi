import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { encodeBadgePayload, decodeBadgePayload } from '../utils/employeeBadge';
import Skeleton from '../components/Skeleton';
import ModuleTabBar from '../components/ModuleTabBar';
import { Icons } from '../components/Icons';

/**
 * VIEW: IdBadgeView
 * PURPOSE: Generates a scannable QR ID badge for the logged-in user --
 * downloadable/printable, for physical/visual identity verification (see
 * BadgeScannerView.jsx). Deliberately NOT wired into clock-in or any
 * authentication path -- see utils/employeeBadge.js for why.
 */
const IdBadgeView = ({ userProfile }) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState('overview');
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

    // 🟩 NEW SUBMODULE: Payload Details -- round-trips the badge's own
    // encode/decode functions (encodeBadgePayload/decodeBadgePayload,
    // already in utils/employeeBadge.js and already exercised by
    // BadgeScannerView.jsx on the scanning side) so the badge owner can see
    // EXACTLY what a scanner will read back, instead of trusting the QR
    // image blindly. Zero new backend calls -- purely a client-side
    // round-trip over data already in userProfile.
    const rawPayload = encodeBadgePayload(userProfile);
    const decoded = decodeBadgePayload(rawPayload);

    // 🟩 NEW SUBMODULE: Print Layout -- a print-optimized, larger
    // presentation of the same already-generated QR (dataUrl), since the
    // compact on-screen card isn't sized for actually printing a physical
    // badge. Reuses window.print() -- no new dependency.
    const tabs = [
        { id: 'overview', label: t('idBadge.tabOverview'), icon: Icons.UserCircle },
        { id: 'details', label: t('idBadge.tabDetails'), icon: Icons.ClipboardCheck },
        { id: 'print', label: t('idBadge.tabPrint'), icon: Icons.QrCode },
    ];

    return (
        <div className="p-4 md:p-8 max-w-md mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('idBadge.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('idBadge.subtitle')}</p>
            </div>

            <ModuleTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'overview' && (
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
            )}

            {activeTab === 'details' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6 space-y-4">
                    <div>
                        <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('idBadge.detailsTitle')}</h3>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{t('idBadge.detailsDescription')}</p>
                    </div>
                    {decoded ? (
                        <ul className="divide-y divide-gray-100 dark:divide-gray-700 text-xs">
                            <li className="flex items-center justify-between py-2">
                                <span className="text-gray-400 dark:text-gray-500">{t('idBadge.fieldProfileId')}</span>
                                <span className="font-mono font-bold text-gray-700 dark:text-gray-200 break-all text-right ml-4">{decoded.id}</span>
                            </li>
                            <li className="flex items-center justify-between py-2">
                                <span className="text-gray-400 dark:text-gray-500">{t('idBadge.fieldName')}</span>
                                <span className="font-bold text-gray-700 dark:text-gray-200">{decoded.name || t('dashboard.notSet')}</span>
                            </li>
                        </ul>
                    ) : (
                        <p className="text-xs text-red-500">{t('idBadge.decodeError')}</p>
                    )}
                    <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
                        <p className="text-[10px] text-gray-400 dark:text-gray-500 mb-1 uppercase tracking-wider font-bold">{t('idBadge.rawPayloadLabel')}</p>
                        <pre className="text-[10px] font-mono bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3 overflow-x-auto text-gray-600 dark:text-gray-300">{rawPayload}</pre>
                    </div>
                </div>
            )}

            {activeTab === 'print' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6 space-y-4">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div>
                            <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('idBadge.printTitle')}</h3>
                            <p className="text-xs text-gray-400 dark:text-gray-500 max-w-xs">{t('idBadge.printDescription')}</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => window.print()}
                            disabled={!dataUrl}
                            className="bg-blue-600 text-white font-bold py-2 px-4 rounded-xl hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all text-xs shrink-0"
                        >
                            {t('idBadge.printAction')}
                        </button>
                    </div>
                    <div className="flex flex-col items-center text-center border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-2xl p-8">
                        {dataUrl ? (
                            <img src={dataUrl} alt={t('idBadge.title')} className="w-[220px] h-[220px] rounded-xl border border-gray-100 dark:border-gray-700 mb-4" />
                        ) : (
                            <Skeleton className="w-[220px] h-[220px] rounded-xl mb-4" />
                        )}
                        <p className="font-black text-lg text-gray-800 dark:text-gray-100">{userProfile.name}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">
                            {userProfile.position || t('dashboard.notSet')} &middot; {userProfile.department || t('dashboard.notSet')}
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};

export default IdBadgeView;
