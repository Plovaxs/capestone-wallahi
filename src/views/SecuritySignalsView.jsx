import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { detectImpossibleTravel } from '../domain/impossibleTravelDetector';
import { knownDevicesRepository } from '../data/repositories/knownDevicesRepository';
import { showUserError } from '../utils/errorHandling';

const NEW_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * VIEW: SecuritySignalsView
 * PURPOSE: One supervisor-facing panel for the two anomaly-detection
 * signals this app surfaces beyond individual liveness checks --
 * impossible-travel between clock-ins (domain/impossibleTravelDetector.js)
 * and new/unrecognized device sign-ins (migrations/20260810_add_device_trust.sql).
 * Both are advisory-only: a genuine statistical/behavioral irregularity
 * worth a look, not proof of wrongdoing (stale GPS fixes, a new laptop, a
 * browser reinstall can all produce either flag legitimately).
 */
const SecuritySignalsView = ({ userProfile, allUsers = [], attendance = [] }) => {
    const { t } = useTranslation();
    const [devices, setDevices] = useState([]);
    const [isLoadingDevices, setIsLoadingDevices] = useState(true);

    const usersById = useMemo(() => {
        const map = new Map();
        for (const u of allUsers) map.set(String(u.id), u);
        return map;
    }, [allUsers]);
    const getUserName = (id) => usersById.get(String(id))?.name || t('securitySignals.unknownUser');

    useEffect(() => {
        (async () => {
            try {
                const data = await knownDevicesRepository.listAll();
                setDevices(data || []);
            } catch (err) {
                showUserError('errors.fetchKnownDevices', err);
            } finally {
                setIsLoadingDevices(false);
            }
        })();
    }, []);

    const travelFlags = useMemo(() => detectImpossibleTravel(attendance), [attendance]);

    const recentNewDevices = useMemo(() => {
        const now = Date.now();
        return devices
            .filter((d) => now - new Date(d.first_seen_at).getTime() < NEW_DEVICE_WINDOW_MS)
            .sort((a, b) => new Date(b.first_seen_at) - new Date(a.first_seen_at));
    }, [devices]);

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('securitySignals.supervisorOnly')}
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('securitySignals.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('securitySignals.subtitle')}</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* --- IMPOSSIBLE TRAVEL --- */}
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                    <div className="p-5 pb-3">
                        <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('securitySignals.travelTitle')}</h2>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">{t('securitySignals.travelDescription')}</p>
                    </div>
                    {travelFlags.length === 0 ? (
                        <p className="text-center text-xs text-gray-400 py-10 dark:text-gray-500 italic">{t('securitySignals.noTravelFlags')}</p>
                    ) : (
                        <div className="divide-y divide-gray-50 dark:divide-gray-700/40 max-h-96 overflow-y-auto">
                            {travelFlags.map((flag, idx) => (
                                <div key={`${flag.employee_id}-${idx}`} className="p-4">
                                    <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{getUserName(flag.employee_id)}</p>
                                    <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                                        {t('securitySignals.travelFlagDetail', {
                                            distance: flag.distanceKm,
                                            hours: flag.hoursElapsed,
                                            speed: flag.impliedSpeedKmh,
                                            from: flag.fromDate,
                                            to: flag.toDate,
                                        })}
                                    </p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* --- NEW DEVICE SIGN-INS --- */}
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                    <div className="p-5 pb-3">
                        <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('securitySignals.devicesTitle')}</h2>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">{t('securitySignals.devicesDescription')}</p>
                    </div>
                    {isLoadingDevices ? (
                        <p className="text-center text-xs text-gray-400 py-10 dark:text-gray-500">{t('securitySignals.loading')}</p>
                    ) : recentNewDevices.length === 0 ? (
                        <p className="text-center text-xs text-gray-400 py-10 dark:text-gray-500 italic">{t('securitySignals.noNewDevices')}</p>
                    ) : (
                        <div className="divide-y divide-gray-50 dark:divide-gray-700/40 max-h-96 overflow-y-auto">
                            {recentNewDevices.map((d) => (
                                <div key={d.id} className="p-4 flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{getUserName(d.user_id)}</p>
                                        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{d.label || t('securitySignals.unknownDevice')}</p>
                                    </div>
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 shrink-0">
                                        {new Date(d.first_seen_at).toLocaleString()}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default SecuritySignalsView;
