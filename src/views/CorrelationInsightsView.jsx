import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ZAxis } from 'recharts';
import { computeCorrelationInsights } from '../domain/correlationInsights';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';
import { getChartTheme } from '../utils/chartTheme';
import ModuleTabBar from '../components/ModuleTabBar';

const PAIRS = [
    { key: 'punctualityVsTaskCompletion', xKey: 'punctuality', yKey: 'taskCompletionRate', color: '#2563eb' },
    { key: 'punctualityVsReviewScore', xKey: 'punctuality', yKey: 'reviewScore', color: '#7c3aed' },
    { key: 'taskCompletionVsReviewScore', xKey: 'taskCompletionRate', yKey: 'reviewScore', color: '#059669' },
];

const describeStrength = (r) => {
    if (r === null) return 'insufficientData';
    const abs = Math.abs(r);
    if (abs >= 0.7) return 'strong';
    if (abs >= 0.4) return 'moderate';
    if (abs >= 0.2) return 'weak';
    return 'negligible';
};

/**
 * VIEW: CorrelationInsightsView
 * PURPOSE: Cross-references attendance punctuality, task completion, and
 * performance review scores to show whether they actually move together
 * for this team -- rather than assuming it (a common but unverified
 * assumption in people-management). Supervisor-only, purely client-side
 * (Pearson correlation over already-fetched data, see
 * domain/correlationInsights.js).
 */
const CorrelationInsightsView = ({ userProfile, allUsers = [], tasks = [], attendance = [], reviews = [], isDarkMode = false }) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState('overview');
    const chartTheme = getChartTheme(isDarkMode);
    const employeeUsers = useMemo(() => allUsers.filter((u) => u.role === 'employee'), [allUsers]);
    const insights = useMemo(
        () => computeCorrelationInsights(employeeUsers, { tasks, attendance, reviews }),
        [employeeUsers, tasks, attendance, reviews]
    );
    const employeeNameById = useMemo(
        () => new Map(employeeUsers.map((u) => [u.id, u.name])),
        [employeeUsers]
    );

    // 🟩 NEW SUBMODULE: Employee Breakdown -- the scatter charts above only
    // show dots, never the actual per-employee numbers behind them. Reuses
    // the exact same `insights` computation (no new domain logic, no new
    // backend call) just tabulated instead of plotted.
    const breakdownRows = useMemo(() => {
        const byEmployee = new Map();
        Object.values(insights).forEach(({ points }) => {
            points.forEach((p) => {
                if (!byEmployee.has(p.employeeId)) {
                    byEmployee.set(p.employeeId, {
                        employeeId: p.employeeId,
                        name: employeeNameById.get(p.employeeId) || p.employeeId,
                        punctuality: p.punctuality,
                        taskCompletionRate: p.taskCompletionRate,
                        reviewScore: p.reviewScore,
                    });
                }
            });
        });
        return Array.from(byEmployee.values()).sort((a, b) => a.name.localeCompare(b.name));
    }, [insights, employeeNameById]);

    // 🟩 NEW SUBMODULE: Outliers -- flags employees whose punctuality and
    // task-completion rate diverge the most from each other (e.g.
    // consistently on time but rarely finishing tasks, or vice versa).
    // A simple, transparent "gap" heuristic rather than a full regression
    // residual -- easy to explain to a non-technical supervisor, and pure
    // client-side math over data this view already has.
    const outlierRows = useMemo(() => {
        const { points } = insights.punctualityVsTaskCompletion;
        return points
            .map((p) => ({
                employeeId: p.employeeId,
                name: employeeNameById.get(p.employeeId) || p.employeeId,
                punctuality: p.punctuality,
                taskCompletionRate: p.taskCompletionRate,
                gap: Math.abs(p.punctuality - p.taskCompletionRate),
            }))
            .sort((a, b) => b.gap - a.gap)
            .slice(0, 10);
    }, [insights, employeeNameById]);

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('correlationInsights.supervisorOnly')}
            </div>
        );
    }

    const tabs = [
        { id: 'overview', label: t('correlationInsights.tabOverview'), icon: Icons.ScatterChart },
        { id: 'breakdown', label: t('correlationInsights.tabBreakdown'), icon: Icons.ClipboardList },
        { id: 'outliers', label: t('correlationInsights.tabOutliers'), icon: Icons.AlertTriangle },
    ];

    return (
        <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('correlationInsights.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('correlationInsights.subtitle')}</p>
            </div>

            <ModuleTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'overview' && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {PAIRS.map(({ key, xKey, yKey, color }) => {
                        const { points, correlation } = insights[key];
                        const strength = describeStrength(correlation);
                        return (
                            <div key={key} className="bg-white dark:bg-gray-800 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                                <h3 className="text-xs font-bold text-gray-700 dark:text-gray-100 mb-1">{t(`correlationInsights.pair_${key}`)}</h3>
                                <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-3">
                                    {correlation === null
                                        ? t('correlationInsights.notEnoughData')
                                        : t(`correlationInsights.strength_${strength}`, { r: correlation.toFixed(2) })}
                                </p>
                                {points.length >= 2 ? (
                                    <ResponsiveContainer width="100%" height={200}>
                                        <ScatterChart margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} opacity={isDarkMode ? 0.7 : 0.5} />
                                            <XAxis type="number" dataKey={xKey} name={xKey} domain={[0, 100]} tick={{ fontSize: 10, fill: chartTheme.axis }} />
                                            <YAxis type="number" dataKey={yKey} name={yKey} domain={[0, 100]} tick={{ fontSize: 10, fill: chartTheme.axis }} />
                                            <ZAxis range={[60, 60]} />
                                            <Tooltip
                                                cursor={{ strokeDasharray: '3 3' }}
                                                formatter={(v) => Math.round(v)}
                                                contentStyle={{ backgroundColor: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, color: chartTheme.tooltipText, borderRadius: '12px', fontSize: '11px' }}
                                            />
                                            <Scatter data={points} fill={color} />
                                        </ScatterChart>
                                    </ResponsiveContainer>
                                ) : (
                                    <EmptyState icon={Icons.ScatterChart} title={t('correlationInsights.notEnoughData')} className="py-6" />
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {activeTab === 'breakdown' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6 overflow-x-auto">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('correlationInsights.breakdownTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('correlationInsights.breakdownDescription')}</p>
                    {breakdownRows.length === 0 ? (
                        <EmptyState icon={Icons.ClipboardList} title={t('correlationInsights.notEnoughData')} className="py-6" />
                    ) : (
                        <table className="min-w-full text-xs">
                            <thead>
                                <tr className="text-left text-gray-400 dark:text-gray-500">
                                    <th className="pb-2 pr-4 font-bold">{t('correlationInsights.colEmployee')}</th>
                                    <th className="pb-2 pr-4 font-bold">{t('correlationInsights.colPunctuality')}</th>
                                    <th className="pb-2 pr-4 font-bold">{t('correlationInsights.colTaskCompletion')}</th>
                                    <th className="pb-2 font-bold">{t('correlationInsights.colReviewScore')}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/40">
                                {breakdownRows.map((row) => (
                                    <tr key={row.employeeId}>
                                        <td className="py-2 pr-4 font-bold text-gray-700 dark:text-gray-200">{row.name}</td>
                                        <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{row.punctuality === null ? '—' : `${Math.round(row.punctuality)}%`}</td>
                                        <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{row.taskCompletionRate === null ? '—' : `${Math.round(row.taskCompletionRate)}%`}</td>
                                        <td className="py-2 text-gray-500 dark:text-gray-400">{row.reviewScore === null ? '—' : Math.round(row.reviewScore)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {activeTab === 'outliers' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('correlationInsights.outliersTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('correlationInsights.outliersDescription')}</p>
                    {outlierRows.length === 0 ? (
                        <EmptyState icon={Icons.AlertTriangle} title={t('correlationInsights.notEnoughData')} className="py-6" />
                    ) : (
                        <ul className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {outlierRows.map((row) => (
                                <li key={row.employeeId} className="py-3 flex items-center justify-between gap-4">
                                    <div>
                                        <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{row.name}</p>
                                        <p className="text-[10px] text-gray-400 dark:text-gray-500">
                                            {t('correlationInsights.outlierDetail', { punctuality: Math.round(row.punctuality), completion: Math.round(row.taskCompletionRate) })}
                                        </p>
                                    </div>
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 shrink-0">
                                        {t('correlationInsights.gapLabel', { gap: Math.round(row.gap) })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
};

export default CorrelationInsightsView;
