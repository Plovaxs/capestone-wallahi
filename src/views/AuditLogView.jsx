import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { auditLogRepository } from '../data/repositories/auditLogRepository';
import { subscribeToTable } from '../realtime/subscribeToTable';
import { showUserError } from '../utils/errorHandling';

const DAY_MS = 24 * 60 * 60 * 1000;

const ENTITY_ICONS = {
    task: '📋',
    leave_request: '🌴',
    performance_evaluation: '⭐',
    profile: '👤',
};

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
    const [entries, setEntries] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [entityFilter, setEntityFilter] = useState('all');

    const usersById = useMemo(() => {
        const map = new Map();
        for (const u of allUsers) map.set(String(u.id), u);
        return map;
    }, [allUsers]);

    const getUserName = (id) => (id ? usersById.get(String(id))?.name : null) || t('auditLog.unknownUser');

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

    /** Turns one entry's jsonb `details` into a plain-language summary -- shape varies by entity_type/action (see the 4 trigger functions in the migration). */
    const describeEntry = (entry) => {
        const d = entry.details || {};
        switch (`${entry.entity_type}:${entry.action}`) {
            case 'task:status_change':
                return t('auditLog.descTaskStatusChange', { title: d.title || entry.entity_id, from: d.from, to: d.to });
            case 'leave_request:status_change':
                return t('auditLog.descLeaveStatusChange', { type: d.type, from: d.from, to: d.to });
            case 'performance_evaluation:created':
                return t('auditLog.descEvaluationCreated', { employee: getUserName(d.employee_id), score: d.final_score });
            case 'performance_evaluation:updated':
                return t('auditLog.descEvaluationUpdated', { employee: getUserName(d.employee_id), from: d.from_score, to: d.to_score });
            case 'performance_evaluation:deleted':
                return t('auditLog.descEvaluationDeleted', { employee: getUserName(d.employee_id), score: d.final_score });
            case 'profile:role_change':
                return t('auditLog.descRoleChange', { name: d.name, from: d.from, to: d.to });
            default:
                return `${entry.action} ${entry.entity_type}`;
        }
    };

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

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('auditLog.supervisorOnly')}
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('auditLog.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('auditLog.subtitle')}</p>
            </div>

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
                    <p className="text-center text-xs text-gray-400 py-10 dark:text-gray-500">{t('auditLog.loading')}</p>
                ) : filteredEntries.length === 0 ? (
                    <p className="text-center text-xs text-gray-400 py-10 dark:text-gray-500 italic">{t('auditLog.noEntries')}</p>
                ) : (
                    <div className="divide-y divide-gray-50 dark:divide-gray-700/40 max-h-[560px] overflow-y-auto">
                        {filteredEntries.map((entry) => (
                            <div key={entry.id} className="p-4 flex items-start gap-3">
                                <span className="text-lg shrink-0" aria-hidden="true">{ENTITY_ICONS[entry.entity_type] || '📄'}</span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{describeEntry(entry)}</p>
                                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                                        {t('auditLog.byActor', { actor: getUserName(entry.actor_id) })} &middot; {new Date(entry.created_at).toLocaleString()}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default AuditLogView;
