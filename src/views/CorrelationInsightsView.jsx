import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ZAxis } from 'recharts';
import { computeCorrelationInsights } from '../domain/correlationInsights';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';
import { getChartTheme } from '../utils/chartTheme';

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
    const chartTheme = getChartTheme(isDarkMode);
    const employeeUsers = useMemo(() => allUsers.filter((u) => u.role === 'employee'), [allUsers]);
    const insights = useMemo(
        () => computeCorrelationInsights(employeeUsers, { tasks, attendance, reviews }),
        [employeeUsers, tasks, attendance, reviews]
    );

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('correlationInsights.supervisorOnly')}
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('correlationInsights.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('correlationInsights.subtitle')}</p>
            </div>

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
        </div>
    );
};

export default CorrelationInsightsView;
