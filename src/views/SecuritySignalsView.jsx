import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { detectImpossibleTravel } from '../domain/impossibleTravelDetector';
import { knownDevicesRepository } from '../data/repositories/knownDevicesRepository';
import { showUserError } from '../utils/errorHandling';
import EmptyState from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { Icons } from '../components/Icons';
import ModuleTabBar from '../components/ModuleTabBar';

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
    const [activeTab, setActiveTab] = useState('overview');
    const [devices, setDevices] = useState([]);
    const [isLoadingDevices, setIsLoadingDevices] = useState(true);

    const usersById = useMemo(() => {
        const map = new Map();
        for (const u of allUsers) map.set(String(u.id), u);
        return map;
    }, [allUsers]);
    const getUserName = useCallback((id) => usersById.get(String(id))?.name || t('securitySignals.unknownUser'), [usersById, t]);

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

    // 🟩 NEW SUBMODULE: All Known Devices -- knownDevicesRepository.listAll()
    // already fetches EVERY known device, but the overview above only ever
    // showed the last-24h subset. This surfaces the full history (sorted
    // newest-first) instead of discarding everything older than a day.
    const allDevicesSorted = useMemo(
        () => [...devices].sort((a, b) => new Date(b.first_seen_at) - new Date(a.first_seen_at)),
        [devices]
    );

    // 🟩 NEW SUBMODULE: By Employee -- consolidates both signals
    // (travelFlags + devices, both already fetched/computed above) into
    // one per-employee summary, so a supervisor can see "does this SAME
    // person have both a travel flag AND multiple devices" at a glance
    // instead of cross-referencing two separate panels manually.
    const byEmployeeStats = useMemo(() => {
        const byEmployee = new Map();
        const ensure = (id) => {
            if (!byEmployee.has(id)) byEmployee.set(id, { employeeId: id, name: getUserName(id), travelFlagCount: 0, deviceCount: 0 });
            return byEmployee.get(id);
        };
        travelFlags.forEach((flag) => { ensure(flag.employee_id).travelFlagCount += 1; });
        devices.forEach((d) => { ensure(d.user_id).deviceCount += 1; });
        return Array.from(byEmployee.values())
            .filter((row) => row.travelFlagCount > 0 || row.deviceCount > 1)
            .sort((a, b) => (b.travelFlagCount - a.travelFlagCount) || (b.deviceCount - a.deviceCount));
    }, [travelFlags, devices, getUserName]);

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('securitySignals.supervisorOnly')}
            </div>
        );
    }

    const tabs = [
        { id: 'overview', label: t('securitySignals.tabOverview'), icon: Icons.ShieldCheck },
        { id: 'allDevices', label: t('securitySignals.tabAllDevices'), icon: Icons.Smartphone },
        { id: 'byEmployee', label: t('securitySignals.tabByEmployee'), icon: Icons.UsersGroup },
    ];

    return (
        <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('securitySignals.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('securitySignals.subtitle')}</p>
            </div>

            <ModuleTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'overview' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* --- IMPOSSIBLE TRAVEL --- */}
                    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                        <div className="p-5 pb-3">
                            <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('securitySignals.travelTitle')}</h2>
                            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">{t('securitySignals.travelDescription')}</p>
                        </div>
                        {travelFlags.length === 0 ? (
                            <EmptyState icon={Icons.ShieldCheck} title={t('securitySignals.noTravelFlags')} />
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
                            <SkeletonList count={3} />
                        ) : recentNewDevices.length === 0 ? (
                            <EmptyState icon={Icons.Smartphone} title={t('securitySignals.noNewDevices')} />
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
            )}

            {activeTab === 'allDevices' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                    <div className="p-5 pb-3">
                        <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('securitySignals.allDevicesTitle')}</h2>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">{t('securitySignals.allDevicesDescription')}</p>
                    </div>
                    {isLoadingDevices ? (
                        <SkeletonList count={5} />
                    ) : allDevicesSorted.length === 0 ? (
                        <EmptyState icon={Icons.Smartphone} title={t('securitySignals.noNewDevices')} />
                    ) : (
                        <div className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {allDevicesSorted.map((d) => (
                                <div key={d.id} className="p-4 flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{getUserName(d.user_id)}</p>
                                        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{d.label || t('securitySignals.unknownDevice')}</p>
                                    </div>
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-900/40 dark:text-gray-300 shrink-0">
                                        {new Date(d.first_seen_at).toLocaleString()}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'byEmployee' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('securitySignals.byEmployeeTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('securitySignals.byEmployeeDescription')}</p>
                    {byEmployeeStats.length === 0 ? (
                        <EmptyState icon={Icons.ShieldCheck} title={t('securitySignals.noEmployeeFlags')} />
                    ) : (
                        <ul className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {byEmployeeStats.map((row) => (
                                <li key={row.employeeId} className="py-3 flex items-center justify-between gap-4">
                                    <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{row.name}</span>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {row.travelFlagCount > 0 && (
                                            <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300">
                                                {t('securitySignals.travelFlagCount', { count: row.travelFlagCount })}
                                            </span>
                                        )}
                                        <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                                            {t('securitySignals.deviceCount', { count: row.deviceCount })}
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
};

export default SecuritySignalsView;
