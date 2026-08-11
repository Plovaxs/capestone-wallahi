import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * COMPONENT: GlobalSearch
 * PURPOSE: One search box across Tasks, Forum posts, and Leave requests
 * instead of hunting through each page separately. Searches whatever the
 * caller already has loaded client-side (tasks/contributions/leaveRequests
 * are already scoped by role upstream in App.jsx's fetch functions, so this
 * never surfaces data the current user couldn't already see on those pages).
 * Selecting a result just switches to that page — it doesn't deep-link to
 * the specific row, since none of those views support that yet.
 */
const GlobalSearch = ({ tasks = [], contributions = [], leaveRequests = [], allUsers = [], setActiveView }) => {
    const { t } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const containerRef = useRef(null);

    // 🟩 PERFORMANCE: was an O(n) allUsers.find() per task/post/leave-
    // request result -- a Map built once per allUsers change turns every
    // lookup into O(1), matching the fix already applied to the equivalent
    // pattern in TasksView/ContributionsView/AuditLogView.
    const usersById = useMemo(() => {
        const map = new Map();
        for (const u of allUsers) map.set(String(u.id), u);
        return map;
    }, [allUsers]);
    const getUserName = useCallback((id) => usersById.get(String(id))?.name || '', [usersById]);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (containerRef.current && !containerRef.current.contains(e.target)) setIsOpen(false);
        };
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') setIsOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, []);

    const q = query.trim().toLowerCase();

    // 🟩 PERFORMANCE: GlobalSearch lives in the always-mounted Header, so
    // while a query is active, every unrelated App-level re-render
    // (realtime events, the notification poll) used to re-run all three
    // O(results x allUsers) filters again. Memoized so they only recompute
    // when the query or the underlying data actually changes.
    const taskResults = useMemo(() => {
        if (q.length < 2) return [];
        const matchesQuery = (...fields) => fields.some(f => (f || '').toLowerCase().includes(q));
        return tasks.filter(task => matchesQuery(task.title, task.description)).slice(0, 5);
    }, [q, tasks]);
    const forumResults = useMemo(() => {
        if (q.length < 2) return [];
        const matchesQuery = (...fields) => fields.some(f => (f || '').toLowerCase().includes(q));
        return contributions.filter(post => matchesQuery(post.title, post.contribution, getUserName(post.employee_id))).slice(0, 5);
    }, [q, contributions, getUserName]);
    const leaveResults = useMemo(() => {
        if (q.length < 2) return [];
        const matchesQuery = (...fields) => fields.some(f => (f || '').toLowerCase().includes(q));
        return leaveRequests.filter(req => matchesQuery(req.type, req.reason, getUserName(req.employee_id))).slice(0, 5);
    }, [q, leaveRequests, getUserName]);

    const hasResults = taskResults.length + forumResults.length + leaveResults.length > 0;

    const goTo = (view) => {
        setActiveView(view);
        setIsOpen(false);
        setQuery('');
    };

    return (
        <div ref={containerRef} className="relative w-full max-w-xs hidden md:block">
            <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                    type="text"
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }}
                    onFocus={() => setIsOpen(true)}
                    placeholder={t('search.placeholder')}
                    aria-label={t('search.placeholder')}
                    className="w-full pl-9 pr-12 py-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none focus:border-blue-500"
                />
                <kbd className="hidden sm:flex items-center gap-0.5 absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[10px] font-bold bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded-md border border-gray-300 dark:border-gray-600 pointer-events-none">
                    Ctrl K
                </kbd>
            </div>

            {isOpen && q.length >= 2 && (
                <div className="absolute left-0 right-0 mt-2 bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-700 z-50 max-h-96 overflow-y-auto">
                    {!hasResults && (
                        <p className="p-4 text-xs text-gray-400 italic text-center">{t('search.noResults')}</p>
                    )}

                    {taskResults.length > 0 && (
                        <div className="p-2">
                            <div className="px-2 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">{t('search.tasksGroup')}</div>
                            {taskResults.map(task => (
                                <button key={task.id} type="button" onClick={() => goTo('tasks')} className="w-full text-left px-2 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-xs">
                                    <div className="font-bold text-gray-800 dark:text-gray-100 truncate">{task.title}</div>
                                    <div className="text-[10px] text-gray-400">{task.status}</div>
                                </button>
                            ))}
                        </div>
                    )}

                    {forumResults.length > 0 && (
                        <div className="p-2 border-t border-gray-50 dark:border-gray-700">
                            <div className="px-2 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">{t('search.forumGroup')}</div>
                            {forumResults.map(post => (
                                <button key={post.id} type="button" onClick={() => goTo('contributions')} className="w-full text-left px-2 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-xs">
                                    <div className="font-bold text-gray-800 dark:text-gray-100 truncate">{post.title || post.contribution}</div>
                                    <div className="text-[10px] text-gray-400">{getUserName(post.employee_id)}</div>
                                </button>
                            ))}
                        </div>
                    )}

                    {leaveResults.length > 0 && (
                        <div className="p-2 border-t border-gray-50 dark:border-gray-700">
                            <div className="px-2 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">{t('search.leaveGroup')}</div>
                            {leaveResults.map(req => (
                                <button key={req.id} type="button" onClick={() => goTo('leave')} className="w-full text-left px-2 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-xs">
                                    <div className="font-bold text-gray-800 dark:text-gray-100 truncate">{req.type} — {getUserName(req.employee_id)}</div>
                                    <div className="text-[10px] text-gray-400">{req.reason || req.status}</div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default GlobalSearch;
