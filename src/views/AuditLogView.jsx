import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { auditLogRepository } from '../data/repositories/auditLogRepository';
import { subscribeToTable } from '../realtime/subscribeToTable';
import { showUserError } from '../utils/errorHandling';
import EmptyState from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { Icons } from '../components/Icons';
import ModuleTabBar from '../components/ModuleTabBar';
import { ENTITY_ICONS, describeAuditEntry, explainAuditEntry } from '../utils/auditLogFormat';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * VIEW: AuditLogView
 * PURPOSE: Read-only accountability trail -- who did what, and when.
 * Supervisor-only, matching the onboarding tour's existing promise (see
 * OnboardingTour.jsx's auditTitle/auditDesc step) that this codebase had
 * been making without ever actually shipping the page for it. The
 * audit_log table + its 4 writer triggers (leave approvals, performance
 * evaluation CRUD, role changes, task status changes) were already live
 * in the database -- see migrations/20260810_document_audit_log.sql --
 * this is purely the missing frontend.
 */
const AuditLogView = ({ userProfile, allUsers = [] }) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState('overview');
    const [entries, setEntries] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [entityFilter, setEntityFilter] = useState('all');

    const usersById = useMemo(() => {
        const map = new Map();
        for (const u of allUsers) map.set(String(u.id), u);
        return map;
    }, [allUsers]);

    const getUserName = useCallback((id) => (id ? usersById.get(String(id))?.name : null) || t('auditLog.unknownUser'), [usersById, t]);

    const fetchEntries = async () => {
        try {
            const data = await auditLogRepository.listRecent();
            setEntries(data || []);
        } catch (err) {
            showUserError('errors.fetchAuditLog', err);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchEntries();
        const unsubscribe = subscribeToTable('audit_log', fetchEntries);
        return unsubscribe;
    }, []);

    const describeEntry = (entry) => describeAuditEntry(entry, t, getUserName);
    const explainEntry = (entry) => explainAuditEntry(entry, t);

    const stats = useMemo(() => {
        const now = Date.now();
        return {
            total: entries.length,
            last24h: entries.filter((e) => now - new Date(e.created_at).getTime() < DAY_MS).length,
            last7d: entries.filter((e) => now - new Date(e.created_at).getTime() < DAY_MS * 7).length,
        };
    }, [entries]);

    const entityTypes = useMemo(() => Array.from(new Set(entries.map((e) => e.entity_type))).sort(), [entries]);

    const filteredEntries = useMemo(() => {
        return entries.filter((e) => {
            if (entityFilter !== 'all' && e.entity_type !== entityFilter) return false;
            if (!searchTerm.trim()) return true;
            const needle = searchTerm.toLowerCase();
            return getUserName(e.actor_id).toLowerCase().includes(needle) || describeEntry(e).toLowerCase().includes(needle);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entries, entityFilter, searchTerm, usersById]);

    // 🟩 NEW SUBMODULE: By Actor -- who's actually generating the most
    // audit entries. Reuses the same already-fetched `entries`, just
    // aggregated the other way from the flat feed above.
    const byActorStats = useMemo(() => {
        const byActor = new Map();
        entries.forEach((e) => {
            const key = e.actor_id || 'system';
            byActor.set(key, (byActor.get(key) || 0) + 1);
        });
        return Array.from(byActor.entries())
            .map(([actorId, count]) => ({ actorId, name: getUserName(actorId), count }))
            .sort((a, b) => b.count - a.count);
    }, [entries, getUserName]);

    // 🟩 NEW SUBMODULE: By Entity Type -- what KIND of activity dominates
    // (leave approvals vs. review edits vs. role changes vs. task status
    // changes), reusing the same entity_type field the filter dropdown
    // above already reads.
    const byEntityTypeStats = useMemo(() => {
        const byType = new Map();
        entries.forEach((e) => {
            byType.set(e.entity_type, (byType.get(e.entity_type) || 0) + 1);
        });
        return Array.from(byType.entries())
            .map(([entityType, count]) => ({ entityType, count }))
            .sort((a, b) => b.count - a.count);
    }, [entries]);

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('auditLog.supervisorOnly')}
            </div>
        );
    }

    const tabs = [
        { id: 'overview', label: t('auditLog.tabOverview'), icon: Icons.ClipboardCheck },
        { id: 'byActor', label: t('auditLog.tabByActor'), icon: Icons.UsersGroup },
        { id: 'byEntityType', label: t('auditLog.tabByEntityType'), icon: Icons.ScatterChart },
    ];

    return (
        <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('auditLog.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('auditLog.subtitle')}</p>
            </div>

            <ModuleTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'overview' && (
                <>
                    <div className="grid grid-cols-3 gap-4">
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('auditLog.statTotal')}</p>
                            <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.total}</p>
                        </div>
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('auditLog.statLast24h')}</p>
                            <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.last24h}</p>
                        </div>
                        <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('auditLog.statLast7d')}</p>
                            <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.last7d}</p>
                        </div>
                    </div>

                    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                        <div className="p-5 pb-3 flex flex-col sm:flex-row gap-3">
                            <input
                                type="text"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                placeholder={t('auditLog.searchPlaceholder')}
                                className="flex-1 p-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg dark:bg-gray-900/40 dark:text-white focus:outline-none"
                            />
                            <select
                                value={entityFilter}
                                onChange={(e) => setEntityFilter(e.target.value)}
                                className="p-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg dark:bg-gray-900/40 dark:text-white focus:outline-none"
                            >
                                <option value="all">{t('auditLog.allEntityTypes')}</option>
                                {entityTypes.map((et) => (
                                    <option key={et} value={et}>{t(`auditLog.entityType_${et}`, et)}</option>
                                ))}
                            </select>
                        </div>
                        {isLoading ? (
                            <SkeletonList count={5} />
                        ) : filteredEntries.length === 0 ? (
                            <EmptyState icon={Icons.ClipboardCheck} title={t('auditLog.noEntries')} />
                        ) : (
                            <div className="divide-y divide-gray-50 dark:divide-gray-700/40 max-h-[560px] overflow-y-auto">
                                {filteredEntries.map((entry) => (
                                    <div key={entry.id} className="p-4 flex items-start gap-3">
                                        <span className="text-lg shrink-0" aria-hidden="true">{ENTITY_ICONS[entry.entity_type] || '📄'}</span>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{describeEntry(entry)}</p>
                                            {explainEntry(entry) && (
                                                <p className="text-[10px] text-blue-600 dark:text-blue-400 mt-0.5 italic">{explainEntry(entry)}</p>
                                            )}
                                            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                                                {t('auditLog.byActor', { actor: getUserName(entry.actor_id) })} &middot; {new Date(entry.created_at).toLocaleString()}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </>
            )}

            {activeTab === 'byActor' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('auditLog.byActorTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('auditLog.byActorDescription')}</p>
                    {byActorStats.length === 0 ? (
                        <EmptyState icon={Icons.UsersGroup} title={t('auditLog.noEntries')} />
                    ) : (
                        <ul className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {byActorStats.map((row) => (
                                <li key={row.actorId} className="py-3 flex items-center justify-between gap-4">
                                    <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{row.name}</span>
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-900/40 dark:text-gray-300 shrink-0">
                                        {t('auditLog.entryCount', { count: row.count })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {activeTab === 'byEntityType' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('auditLog.byEntityTypeTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('auditLog.byEntityTypeDescription')}</p>
                    {byEntityTypeStats.length === 0 ? (
                        <EmptyState icon={Icons.ScatterChart} title={t('auditLog.noEntries')} />
                    ) : (
                        <ul className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {byEntityTypeStats.map((row) => (
                                <li key={row.entityType} className="py-3 flex items-center justify-between gap-4">
                                    <span className="text-xs font-bold text-gray-700 dark:text-gray-200 flex items-center gap-2">
                                        <span aria-hidden="true">{ENTITY_ICONS[row.entityType] || '📄'}</span>
                                        {t(`auditLog.entityType_${row.entityType}`, row.entityType)}
                                    </span>
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-900/40 dark:text-gray-300 shrink-0">
                                        {t('auditLog.entryCount', { count: row.count })}
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

export default AuditLogView;
