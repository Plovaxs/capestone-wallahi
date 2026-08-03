import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { openFeatureFlagPanel } from '../feature-flags/panelOpener';

/**
 * COMPONENT: CommandPalette
 * PURPOSE: Ctrl/Cmd+K quick-navigation + quick-actions, Notion/Linear-style.
 * Combines static commands (go to a page, toggle dark mode) with the same
 * fuzzy record search GlobalSearch does (tasks/forum/leave), so power users
 * never need the mouse to get around.
 */
const CommandPalette = ({ setActiveView, userProfile, isDarkMode, toggleDarkMode, tasks = [], contributions = [], leaveRequests = [], allUsers = [] }) => {
    const { t } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef(null);

    const getUserName = (id) => allUsers.find(u => String(u.id) === String(id))?.name || '';

    const staticCommands = useMemo(() => {
        const nav = (view, label) => ({ id: `nav-${view}`, label, action: () => setActiveView(view), group: t('palette.navigation') });
        const commands = [
            nav('dashboard', t('nav.dashboard')),
            nav('tasks', t('nav.myTasks')),
            nav('attendance', t('nav.attendance')),
            nav('leave', t('nav.leaveRequests')),
            nav('contributions', t('nav.contributions')),
            nav('helpdesk', t('nav.helpdesk')),
        ];
        if (userProfile?.role === 'supervisor') commands.push(nav('reviews', t('nav.performance')));
        commands.push(nav('settings', t('nav.settings')));
        commands.push({
            id: 'toggle-dark-mode',
            label: isDarkMode ? t('palette.switchToLight') : t('palette.switchToDark'),
            action: toggleDarkMode,
            group: t('palette.actions'),
        });
        commands.push({
            id: 'print-page',
            label: t('palette.printPage'),
            action: () => window.print(),
            group: t('palette.actions'),
        });
        commands.push({
            id: 'feature-flags',
            label: t('palette.featureFlags'),
            action: openFeatureFlagPanel,
            group: t('palette.actions'),
        });
        return commands;
    }, [setActiveView, userProfile, isDarkMode, toggleDarkMode, t]);

    const q = query.trim().toLowerCase();
    const matchesQuery = (...fields) => fields.some(f => (f || '').toLowerCase().includes(q));

    const recordResults = useMemo(() => {
        if (q.length < 2) return [];
        const results = [];
        tasks.filter(task => matchesQuery(task.title, task.description)).slice(0, 4).forEach(task => {
            results.push({ id: `task-${task.id}`, label: task.title, group: t('search.tasksGroup'), action: () => setActiveView('tasks') });
        });
        contributions.filter(post => matchesQuery(post.title, post.contribution, getUserName(post.employee_id))).slice(0, 4).forEach(post => {
            results.push({ id: `post-${post.id}`, label: post.title || post.contribution, group: t('search.forumGroup'), action: () => setActiveView('contributions') });
        });
        leaveRequests.filter(req => matchesQuery(req.type, req.reason, getUserName(req.employee_id))).slice(0, 4).forEach(req => {
            results.push({ id: `leave-${req.id}`, label: `${req.type} — ${getUserName(req.employee_id)}`, group: t('search.leaveGroup'), action: () => setActiveView('leave') });
        });
        return results;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [q, tasks, contributions, leaveRequests]);

    const filteredCommands = q.length >= 1
        ? staticCommands.filter(c => c.label.toLowerCase().includes(q))
        : staticCommands;

    const allResults = [...filteredCommands, ...recordResults];

    useEffect(() => {
        const handleGlobalKeyDown = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setIsOpen(prev => !prev);
            }
        };
        document.addEventListener('keydown', handleGlobalKeyDown);
        return () => document.removeEventListener('keydown', handleGlobalKeyDown);
    }, []);

    useEffect(() => {
        if (isOpen) {
            setQuery('');
            setActiveIndex(0);
            setTimeout(() => inputRef.current?.focus(), 0);
        }
    }, [isOpen]);

    useEffect(() => {
        setActiveIndex(0);
    }, [query]);

    const runCommand = (cmd) => {
        cmd.action();
        setIsOpen(false);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
            setIsOpen(false);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex(prev => Math.min(prev + 1, allResults.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex(prev => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (allResults[activeIndex]) runCommand(allResults[activeIndex]);
        }
    };

    if (!isOpen) return null;

    let runningIndex = -1;
    let lastGroup = null;

    return (
        <div className="fixed inset-0 bg-black/50 z-[70] flex justify-center items-start pt-24 px-4" onClick={() => setIsOpen(false)}>
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t('palette.title')}
                onClick={(e) => e.stopPropagation()}
                className="bg-white dark:bg-gray-800 w-full max-w-lg rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-700 overflow-hidden"
            >
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t('palette.placeholder')}
                    aria-label={t('palette.placeholder')}
                    className="w-full p-4 text-sm border-b border-gray-100 dark:border-gray-700 bg-transparent dark:text-white focus:outline-none"
                />
                <div className="max-h-80 overflow-y-auto p-2">
                    {allResults.length === 0 && (
                        <p className="p-4 text-xs text-gray-400 italic text-center">{t('search.noResults')}</p>
                    )}
                    {allResults.map((cmd) => {
                        runningIndex += 1;
                        const index = runningIndex;
                        const showGroupHeader = cmd.group !== lastGroup;
                        lastGroup = cmd.group;
                        return (
                            <React.Fragment key={cmd.id}>
                                {showGroupHeader && (
                                    <div className="px-2 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">{cmd.group}</div>
                                )}
                                <button
                                    type="button"
                                    onClick={() => runCommand(cmd)}
                                    onMouseEnter={() => setActiveIndex(index)}
                                    className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                                        index === activeIndex
                                            ? 'bg-blue-600 text-white'
                                            : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
                                    }`}
                                >
                                    {cmd.label}
                                </button>
                            </React.Fragment>
                        );
                    })}
                </div>
                <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-700 text-[10px] text-gray-400 flex gap-3">
                    <span>↑↓ {t('palette.toNavigate')}</span>
                    <span>↵ {t('palette.toSelect')}</span>
                    <span>Esc {t('palette.toClose')}</span>
                </div>
            </div>
        </div>
    );
};

export default CommandPalette;
