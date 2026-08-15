import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { clientErrorLogsRepository } from '../data/repositories/clientErrorLogsRepository';
import { subscribeToTable } from '../realtime/subscribeToTable';
import { confirmDialog } from '../utils/confirm';
import { showUserError } from '../utils/errorHandling';
import { getLocalDateString } from '../utils/dateOnly';
import Modal from '../components/Modal';
import EmptyState from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { Icons } from '../components/Icons';
import { getChartTheme } from '../utils/chartTheme';
import ModuleTabBar from '../components/ModuleTabBar';

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 14;

/**
 * VIEW: ErrorMonitorView
 * PURPOSE: Self-hosted, Sentry-style error dashboard -- supervisor-only.
 * Client crashes and handled API failures (see monitoring/errorReporter.js,
 * wired into ErrorBoundary/showUserError/window error listeners) were
 * previously only ever visible in the individual user's own browser
 * console; nobody on the team would know unless that user reported it
 * themselves. This surfaces them in one place, no third-party account
 * needed.
 */
const ErrorMonitorView = ({ userProfile, isDarkMode = false }) => {
    const chartTheme = getChartTheme(isDarkMode);
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState('overview');
    const [errors, setErrors] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [inspectingError, setInspectingError] = useState(null);
    const [isClearing, setIsClearing] = useState(false);

    const fetchErrors = async () => {
        try {
            const data = await clientErrorLogsRepository.listRecent();
            setErrors(data || []);
        } catch (err) {
            showUserError('errors.fetchErrorLogs', err);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchErrors();
        // 🟩 LIVE UPDATES: a new client error while a supervisor already has
        // this page open shows up without a manual refresh -- same
        // subscribeToTable pattern used for every other live-updated table
        // in this app (App.jsx's realtime effect), just scoped locally
        // since this view (unlike tasks/attendance/etc.) isn't part of the
        // global app-data load every user pays for on login.
        const unsubscribe = subscribeToTable('client_error_logs', fetchErrors);
        return unsubscribe;
    }, []);

    const stats = useMemo(() => {
        const now = Date.now();
        const last24h = errors.filter((e) => now - new Date(e.created_at).getTime() < DAY_MS).length;
        const last7d = errors.filter((e) => now - new Date(e.created_at).getTime() < DAY_MS * 7).length;
        const uniqueMessages = new Set(errors.map((e) => e.message)).size;
        return { total: errors.length, last24h, last7d, uniqueMessages };
    }, [errors]);

    const trendData = useMemo(() => {
        const now = new Date();
        const buckets = new Map();
        for (let i = TREND_DAYS - 1; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const key = getLocalDateString(d);
            buckets.set(key, 0);
        }
        for (const err of errors) {
            const key = getLocalDateString(new Date(err.created_at));
            if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
        }
        return Array.from(buckets, ([date, count]) => ({ date: date.slice(5), count }));
    }, [errors]);

    const filteredErrors = useMemo(() => {
        if (!searchTerm.trim()) return errors;
        const needle = searchTerm.toLowerCase();
        return errors.filter((e) =>
            (e.message || '').toLowerCase().includes(needle) ||
            (e.user_email || '').toLowerCase().includes(needle) ||
            (e.url || '').toLowerCase().includes(needle)
        );
    }, [errors, searchTerm]);

    const handleClearAll = async () => {
        if (errors.length === 0) return;
        if (!(await confirmDialog(t('errorMonitor.confirmClearAll', { count: errors.length })))) return;
        setIsClearing(true);
        try {
            await clientErrorLogsRepository.deleteAll();
            toast.success(t('errorMonitor.clearedSuccess'));
            await fetchErrors();
        } catch (err) {
            showUserError('errors.deleteErrorLogs', err);
        } finally {
            setIsClearing(false);
        }
    };

    const handleDeleteOne = async (id) => {
        try {
            await clientErrorLogsRepository.delete(id);
            setErrors((prev) => prev.filter((e) => e.id !== id));
        } catch (err) {
            showUserError('errors.deleteErrorLogs', err);
        }
    };

    // 🟩 NEW SUBMODULE: By Message -- the flat list above shows every
    // occurrence individually, so the same recurring bug can bury the
    // signal under dozens of near-identical rows. Groups the SAME
    // already-fetched `errors` by message, showing occurrence count and
    // most-recent timestamp per unique error -- the standard "dedupe by
    // fingerprint" triage view every error-tracking tool leads with.
    const byMessageStats = useMemo(() => {
        const byMessage = new Map();
        errors.forEach((e) => {
            const key = e.message || t('errorMonitor.unknownMessage');
            if (!byMessage.has(key)) byMessage.set(key, { message: key, count: 0, lastSeen: null, sample: e });
            const entry = byMessage.get(key);
            entry.count += 1;
            if (!entry.lastSeen || new Date(e.created_at) > new Date(entry.lastSeen)) {
                entry.lastSeen = e.created_at;
                entry.sample = e;
            }
        });
        return Array.from(byMessage.values()).sort((a, b) => b.count - a.count);
    }, [errors, t]);

    // 🟩 NEW SUBMODULE: By User -- which specific users are hitting errors
    // most, reusing the same already-fetched `errors` grouped by
    // user_email instead of message. Helps distinguish "one person having
    // a bad time" from "everyone is hitting this."
    const byUserStats = useMemo(() => {
        const byUser = new Map();
        errors.forEach((e) => {
            const key = e.user_email || t('errorMonitor.unknownUser');
            byUser.set(key, (byUser.get(key) || 0) + 1);
        });
        return Array.from(byUser.entries())
            .map(([user, count]) => ({ user, count }))
            .sort((a, b) => b.count - a.count);
    }, [errors, t]);

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('errorMonitor.supervisorOnly')}
            </div>
        );
    }

    const tabs = [
        { id: 'overview', label: t('errorMonitor.tabOverview'), icon: Icons.CheckCircle },
        { id: 'byMessage', label: t('errorMonitor.tabByMessage'), icon: Icons.ClipboardList },
        { id: 'byUser', label: t('errorMonitor.tabByUser'), icon: Icons.UsersGroup },
    ];

    return (
        <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('errorMonitor.title')}</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{t('errorMonitor.subtitle')}</p>
                </div>
                <button
                    type="button"
                    onClick={handleClearAll}
                    disabled={isClearing || errors.length === 0}
                    className="text-xs font-bold text-red-600 hover:text-red-800 bg-red-50 dark:bg-red-950/30 dark:text-red-400 px-3 py-2 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    {isClearing ? t('errorMonitor.clearing') : t('errorMonitor.clearAll')}
                </button>
            </div>

            <ModuleTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'overview' && (
                <>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('errorMonitor.statTotal')}</p>
                            <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.total}</p>
                        </div>
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('errorMonitor.statLast24h')}</p>
                            <p className={`text-2xl font-black ${stats.last24h > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>{stats.last24h}</p>
                        </div>
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('errorMonitor.statLast7d')}</p>
                            <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.last7d}</p>
                        </div>
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('errorMonitor.statUnique')}</p>
                            <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.uniqueMessages}</p>
                        </div>
                    </div>

                    <div className="bg-white dark:bg-gray-800 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                        <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 mb-4 uppercase tracking-wider">{t('errorMonitor.trendTitle')}</h2>
                        <div style={{ width: '100%', height: 220 }}>
                            <ResponsiveContainer width="100%" height={220}>
                                <BarChart data={trendData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} opacity={isDarkMode ? 0.6 : 0.4} />
                                    <XAxis dataKey="date" stroke={chartTheme.axis} fontSize={11} />
                                    <YAxis stroke={chartTheme.axis} allowDecimals={false} />
                                    <Tooltip contentStyle={{ backgroundColor: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, color: chartTheme.tooltipText, borderRadius: '12px', fontSize: '11px', fontWeight: 'bold' }} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                                    <Bar dataKey="count" fill="#dc2626" radius={[4, 4, 0, 0]} maxBarSize={28} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                        <div className="p-5 pb-3">
                            <input
                                type="text"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                placeholder={t('errorMonitor.searchPlaceholder')}
                                className="w-full p-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg dark:bg-gray-900/40 dark:text-white focus:outline-none"
                            />
                        </div>
                        {isLoading ? (
                            <SkeletonList count={5} />
                        ) : filteredErrors.length === 0 ? (
                            <EmptyState icon={Icons.CheckCircle} title={t('errorMonitor.noErrors')} />
                        ) : (
                            <div className="divide-y divide-gray-50 dark:divide-gray-700/40 max-h-[480px] overflow-y-auto">
                                {filteredErrors.map((err) => (
                                    <div key={err.id} className="p-4 flex items-start gap-3 hover:bg-gray-50/60 dark:hover:bg-gray-900/20">
                                        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setInspectingError(err)}>
                                            <p className="text-xs font-bold text-gray-800 dark:text-gray-100 truncate">{err.message}</p>
                                            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                                                {new Date(err.created_at).toLocaleString()} &middot; {err.user_email || t('errorMonitor.unknownUser')}
                                                {err.context?.source && <> &middot; {err.context.source}</>}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => handleDeleteOne(err.id)}
                                            className="shrink-0 text-[10px] font-bold text-gray-400 hover:text-red-600 dark:hover:text-red-400 uppercase tracking-wider px-2 py-1"
                                        >
                                            {t('errorMonitor.dismiss')}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </>
            )}

            {activeTab === 'byMessage' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                    <div className="p-5 pb-3">
                        <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('errorMonitor.byMessageTitle')}</h2>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{t('errorMonitor.byMessageDescription')}</p>
                    </div>
                    {byMessageStats.length === 0 ? (
                        <EmptyState icon={Icons.ClipboardList} title={t('errorMonitor.noErrors')} />
                    ) : (
                        <div className="divide-y divide-gray-50 dark:divide-gray-700/40 max-h-[480px] overflow-y-auto">
                            {byMessageStats.map((row) => (
                                <div key={row.message} className="p-4 flex items-start gap-3 hover:bg-gray-50/60 dark:hover:bg-gray-900/20 cursor-pointer" onClick={() => setInspectingError(row.sample)}>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-bold text-gray-800 dark:text-gray-100 truncate">{row.message}</p>
                                        <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{t('errorMonitor.lastSeen', { time: new Date(row.lastSeen).toLocaleString() })}</p>
                                    </div>
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300 shrink-0">
                                        {t('errorMonitor.occurrenceCount', { count: row.count })}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'byUser' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('errorMonitor.byUserTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('errorMonitor.byUserDescription')}</p>
                    {byUserStats.length === 0 ? (
                        <EmptyState icon={Icons.UsersGroup} title={t('errorMonitor.noErrors')} />
                    ) : (
                        <ul className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {byUserStats.map((row) => (
                                <li key={row.user} className="py-3 flex items-center justify-between gap-4">
                                    <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{row.user}</span>
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-900/40 dark:text-gray-300 shrink-0">
                                        {t('errorMonitor.occurrenceCount', { count: row.count })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            <Modal isOpen={!!inspectingError} onClose={() => setInspectingError(null)} title={t('errorMonitor.detailsTitle')}>
                {inspectingError && (
                    <div className="space-y-3 text-xs">
                        <div>
                            <span className="block font-bold text-gray-400 uppercase tracking-wider text-[10px] mb-0.5">{t('errorMonitor.message')}</span>
                            <p className="font-mono text-gray-800 dark:text-gray-100 break-words">{inspectingError.message}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <span className="block font-bold text-gray-400 uppercase tracking-wider text-[10px] mb-0.5">{t('errorMonitor.timestamp')}</span>
                                <p className="text-gray-700 dark:text-gray-300">{new Date(inspectingError.created_at).toLocaleString()}</p>
                            </div>
                            <div>
                                <span className="block font-bold text-gray-400 uppercase tracking-wider text-[10px] mb-0.5">{t('errorMonitor.user')}</span>
                                <p className="text-gray-700 dark:text-gray-300 break-all">{inspectingError.user_email || t('errorMonitor.unknownUser')}</p>
                            </div>
                        </div>
                        {inspectingError.url && (
                            <div>
                                <span className="block font-bold text-gray-400 uppercase tracking-wider text-[10px] mb-0.5">{t('errorMonitor.url')}</span>
                                <p className="text-gray-700 dark:text-gray-300 break-all font-mono">{inspectingError.url}</p>
                            </div>
                        )}
                        {inspectingError.stack && (
                            <div>
                                <span className="block font-bold text-gray-400 uppercase tracking-wider text-[10px] mb-0.5">{t('errorMonitor.stackTrace')}</span>
                                <pre className="bg-gray-50 dark:bg-gray-900/40 border border-gray-100 dark:border-gray-700 rounded-lg p-3 overflow-x-auto text-[10px] font-mono text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{inspectingError.stack}</pre>
                            </div>
                        )}
                        {inspectingError.user_agent && (
                            <div>
                                <span className="block font-bold text-gray-400 uppercase tracking-wider text-[10px] mb-0.5">{t('errorMonitor.userAgent')}</span>
                                <p className="text-gray-500 dark:text-gray-400 break-all">{inspectingError.user_agent}</p>
                            </div>
                        )}
                    </div>
                )}
            </Modal>
        </div>
    );
};

export default ErrorMonitorView;
