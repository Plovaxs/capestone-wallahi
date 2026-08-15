import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deviceHealthRepository } from '../data/repositories/deviceHealthRepository';
import { subscribeToTable } from '../realtime/subscribeToTable';
import { showUserError } from '../utils/errorHandling';
import EmptyState from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { Icons } from '../components/Icons';
import ModuleTabBar from '../components/ModuleTabBar';

/**
 * VIEW: FleetHealthView
 * PURPOSE: Aggregates the IoT/edge sensor diagnostics AttendanceView
 * already computes locally on every device (see components/
 * EdgeDiagnosticsPanel.jsx) into one supervisor-facing view of the whole
 * fleet -- previously every one of these signals (inference latency,
 * model tier, lens clarity, network/battery state) was purely local to
 * whichever device was scanning at the time. Supervisor-only, matching
 * the RLS policy on device_health_snapshots.
 */
const FleetHealthView = ({ userProfile, allUsers = [] }) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState('overview');
    const [snapshots, setSnapshots] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    const usersById = useMemo(() => {
        const map = new Map();
        for (const u of allUsers) map.set(String(u.id), u);
        return map;
    }, [allUsers]);
    const getUserName = (id) => (id ? usersById.get(String(id))?.name : null) || t('fleetHealth.unknownUser');

    const fetchSnapshots = async () => {
        try {
            const data = await deviceHealthRepository.listRecent();
            setSnapshots(data || []);
        } catch (err) {
            showUserError('errors.fetchFleetHealth', err);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchSnapshots();
        const unsubscribe = subscribeToTable('device_health_snapshots', fetchSnapshots);
        return unsubscribe;
    }, []);

    const stats = useMemo(() => {
        if (snapshots.length === 0) {
            return { total: 0, avgLatencyMs: null, reducedTierPct: null, slowNetworkPct: null, lensIssuePct: null, avgBatteryPct: null };
        }
        const withLatency = snapshots.filter((s) => typeof s.avg_latency_ms === 'number');
        const withBattery = snapshots.filter((s) => typeof s.battery_level === 'number');
        const reducedCount = snapshots.filter((s) => s.model_tier === 'reduced').length;
        const slowNetworkCount = snapshots.filter((s) => s.is_slow_network === true).length;
        const lensIssueCount = snapshots.filter((s) => s.lens_clear === false).length;

        return {
            total: snapshots.length,
            avgLatencyMs: withLatency.length > 0 ? Math.round(withLatency.reduce((sum, s) => sum + s.avg_latency_ms, 0) / withLatency.length) : null,
            reducedTierPct: Math.round((reducedCount / snapshots.length) * 100),
            slowNetworkPct: Math.round((slowNetworkCount / snapshots.length) * 100),
            lensIssuePct: Math.round((lensIssueCount / snapshots.length) * 100),
            avgBatteryPct: withBattery.length > 0 ? Math.round((withBattery.reduce((sum, s) => sum + s.battery_level, 0) / withBattery.length) * 100) : null,
        };
    }, [snapshots]);

    // 🟩 NEW SUBMODULE: Per-Device Breakdown -- the fleet-wide stats above
    // average everything together; this groups the SAME already-fetched
    // `snapshots` by employee_id so a supervisor can spot which specific
    // device/person is dragging the fleet average down instead of only
    // seeing one blended number.
    const perDeviceStats = useMemo(() => {
        const byEmployee = new Map();
        snapshots.forEach((s) => {
            const key = s.employee_id || 'unknown';
            if (!byEmployee.has(key)) byEmployee.set(key, []);
            byEmployee.get(key).push(s);
        });
        return Array.from(byEmployee.entries()).map(([employeeId, rows]) => {
            const withLatency = rows.filter((s) => typeof s.avg_latency_ms === 'number');
            const issueCount = rows.filter((s) => s.model_tier === 'reduced' || s.is_slow_network === true || s.lens_clear === false).length;
            return {
                employeeId,
                name: (usersById.get(String(employeeId))?.name) || t('fleetHealth.unknownUser'),
                snapshotCount: rows.length,
                avgLatencyMs: withLatency.length > 0 ? Math.round(withLatency.reduce((sum, s) => sum + s.avg_latency_ms, 0) / withLatency.length) : null,
                issueCount,
                lastSeen: rows.reduce((latest, s) => (!latest || new Date(s.created_at) > new Date(latest)) ? s.created_at : latest, null),
            };
        }).sort((a, b) => b.issueCount - a.issueCount);
    }, [snapshots, usersById, t]);

    // 🟩 NEW SUBMODULE: Issues Only -- a focused subset of the same
    // `snapshots` filtered down to rows that actually flagged a problem
    // (reduced model tier, slow network, or an obstructed lens), so a
    // supervisor doesn't have to scroll the full 100-row recent table
    // looking for the ones that matter.
    const issueSnapshots = useMemo(
        () => snapshots.filter((s) => s.model_tier === 'reduced' || s.is_slow_network === true || s.lens_clear === false),
        [snapshots]
    );

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('fleetHealth.supervisorOnly')}
            </div>
        );
    }

    const tabs = [
        { id: 'overview', label: t('fleetHealth.tabOverview'), icon: Icons.CpuChip },
        { id: 'perDevice', label: t('fleetHealth.tabPerDevice'), icon: Icons.UsersGroup },
        { id: 'issues', label: t('fleetHealth.tabIssues'), icon: Icons.AlertTriangle },
    ];

    return (
        <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('fleetHealth.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('fleetHealth.subtitle')}</p>
            </div>

            <ModuleTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'overview' && (
                <>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('fleetHealth.statTotal')}</p>
                            <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.total}</p>
                        </div>
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('fleetHealth.statAvgLatency')}</p>
                            <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.avgLatencyMs !== null ? `${stats.avgLatencyMs}ms` : '—'}</p>
                        </div>
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('fleetHealth.statReducedTier')}</p>
                            <p className={`text-2xl font-black ${stats.reducedTierPct > 30 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-800 dark:text-gray-100'}`}>{stats.reducedTierPct !== null ? `${stats.reducedTierPct}%` : '—'}</p>
                        </div>
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('fleetHealth.statSlowNetwork')}</p>
                            <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.slowNetworkPct !== null ? `${stats.slowNetworkPct}%` : '—'}</p>
                        </div>
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('fleetHealth.statLensIssue')}</p>
                            <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.lensIssuePct !== null ? `${stats.lensIssuePct}%` : '—'}</p>
                        </div>
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('fleetHealth.statAvgBattery')}</p>
                            <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.avgBatteryPct !== null ? `${stats.avgBatteryPct}%` : '—'}</p>
                        </div>
                    </div>

                    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                        <div className="p-5 pb-3">
                            <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('fleetHealth.recentTitle')}</h2>
                        </div>
                        {isLoading ? (
                            <SkeletonList count={5} />
                        ) : snapshots.length === 0 ? (
                            <EmptyState icon={Icons.CpuChip} title={t('fleetHealth.noSnapshots')} />
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider border-y border-gray-100 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/30">
                                            <th className="px-4 py-2.5">{t('fleetHealth.colEmployee')}</th>
                                            <th className="px-4 py-2.5">{t('fleetHealth.colTimestamp')}</th>
                                            <th className="px-4 py-2.5">{t('fleetHealth.colLatency')}</th>
                                            <th className="px-4 py-2.5">{t('fleetHealth.colTier')}</th>
                                            <th className="px-4 py-2.5">{t('fleetHealth.colNetwork')}</th>
                                            <th className="px-4 py-2.5">{t('fleetHealth.colBattery')}</th>
                                            <th className="px-4 py-2.5">{t('fleetHealth.colLens')}</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50 dark:divide-gray-700/40">
                                        {snapshots.slice(0, 100).map((s) => (
                                            <tr key={s.id} className="text-gray-700 dark:text-gray-300">
                                                <td className="px-4 py-2.5 font-bold text-gray-800 dark:text-gray-100 whitespace-nowrap">{getUserName(s.employee_id)}</td>
                                                <td className="px-4 py-2.5 whitespace-nowrap">{new Date(s.created_at).toLocaleString()}</td>
                                                <td className="px-4 py-2.5 whitespace-nowrap">{typeof s.avg_latency_ms === 'number' ? `${s.avg_latency_ms}ms` : '—'}</td>
                                                <td className="px-4 py-2.5 whitespace-nowrap">{s.model_tier === 'reduced' ? t('attendance.diagModelReduced') : s.model_tier === 'full' ? t('attendance.diagModelFull') : '—'}</td>
                                                <td className="px-4 py-2.5 whitespace-nowrap">{s.network_effective_type ? s.network_effective_type.toUpperCase() : '—'}</td>
                                                <td className="px-4 py-2.5 whitespace-nowrap">{typeof s.battery_level === 'number' ? `${Math.round(s.battery_level * 100)}%${s.is_charging ? ' ⚡' : ''}` : '—'}</td>
                                                <td className="px-4 py-2.5 whitespace-nowrap">{s.lens_clear === false ? `⚠️ ${t('attendance.diagObstructed')}` : s.lens_clear === true ? t('attendance.diagClear') : '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </>
            )}

            {activeTab === 'perDevice' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                    <div className="p-5 pb-3">
                        <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('fleetHealth.perDeviceTitle')}</h2>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{t('fleetHealth.perDeviceDescription')}</p>
                    </div>
                    {isLoading ? (
                        <SkeletonList count={5} />
                    ) : perDeviceStats.length === 0 ? (
                        <EmptyState icon={Icons.UsersGroup} title={t('fleetHealth.noSnapshots')} />
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider border-y border-gray-100 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/30">
                                        <th className="px-4 py-2.5">{t('fleetHealth.colEmployee')}</th>
                                        <th className="px-4 py-2.5">{t('fleetHealth.colSnapshotCount')}</th>
                                        <th className="px-4 py-2.5">{t('fleetHealth.colAvgLatency')}</th>
                                        <th className="px-4 py-2.5">{t('fleetHealth.colIssueCount')}</th>
                                        <th className="px-4 py-2.5">{t('fleetHealth.colLastSeen')}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/40">
                                    {perDeviceStats.map((row) => (
                                        <tr key={row.employeeId} className="text-gray-700 dark:text-gray-300">
                                            <td className="px-4 py-2.5 font-bold text-gray-800 dark:text-gray-100 whitespace-nowrap">{row.name}</td>
                                            <td className="px-4 py-2.5 whitespace-nowrap">{row.snapshotCount}</td>
                                            <td className="px-4 py-2.5 whitespace-nowrap">{row.avgLatencyMs !== null ? `${row.avgLatencyMs}ms` : '—'}</td>
                                            <td className="px-4 py-2.5 whitespace-nowrap">
                                                <span className={`text-[10px] font-bold px-2 py-1 rounded-lg ${row.issueCount > 0 ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'}`}>
                                                    {row.issueCount}
                                                </span>
                                            </td>
                                            <td className="px-4 py-2.5 whitespace-nowrap">{row.lastSeen ? new Date(row.lastSeen).toLocaleString() : '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'issues' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                    <div className="p-5 pb-3">
                        <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('fleetHealth.issuesTitle')}</h2>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{t('fleetHealth.issuesDescription')}</p>
                    </div>
                    {isLoading ? (
                        <SkeletonList count={5} />
                    ) : issueSnapshots.length === 0 ? (
                        <EmptyState icon={Icons.ShieldCheck} title={t('fleetHealth.noIssues')} />
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider border-y border-gray-100 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/30">
                                        <th className="px-4 py-2.5">{t('fleetHealth.colEmployee')}</th>
                                        <th className="px-4 py-2.5">{t('fleetHealth.colTimestamp')}</th>
                                        <th className="px-4 py-2.5">{t('fleetHealth.colTier')}</th>
                                        <th className="px-4 py-2.5">{t('fleetHealth.colNetwork')}</th>
                                        <th className="px-4 py-2.5">{t('fleetHealth.colLens')}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/40">
                                    {issueSnapshots.slice(0, 100).map((s) => (
                                        <tr key={s.id} className="text-gray-700 dark:text-gray-300">
                                            <td className="px-4 py-2.5 font-bold text-gray-800 dark:text-gray-100 whitespace-nowrap">{getUserName(s.employee_id)}</td>
                                            <td className="px-4 py-2.5 whitespace-nowrap">{new Date(s.created_at).toLocaleString()}</td>
                                            <td className="px-4 py-2.5 whitespace-nowrap">{s.model_tier === 'reduced' ? `⚠️ ${t('attendance.diagModelReduced')}` : s.model_tier === 'full' ? t('attendance.diagModelFull') : '—'}</td>
                                            <td className="px-4 py-2.5 whitespace-nowrap">{s.is_slow_network ? `⚠️ ${(s.network_effective_type || '').toUpperCase()}` : (s.network_effective_type || '').toUpperCase() || '—'}</td>
                                            <td className="px-4 py-2.5 whitespace-nowrap">{s.lens_clear === false ? `⚠️ ${t('attendance.diagObstructed')}` : t('attendance.diagClear')}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default FleetHealthView;
