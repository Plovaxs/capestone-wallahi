import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
    LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { memoizeWithLru } from '../patterns/LRUCache';

/**
 * Pure, module-scope so the LRU cache below survives across renders and
 * across component instances. Keyed on a cheap summary of the inputs
 * (ids + lengths), not a full JSON.stringify of every task/attendance
 * row — the leaderboard is recomputed only when that summary actually
 * changes, e.g. not on every 20s notification poll that leaves this data
 * untouched.
 */
const computeLeaderboard = memoizeWithLru(
    (employeeUsers, tasks, attendance) => employeeUsers
        .map(emp => {
            const empTasks = tasks.filter(task => (task.assigned_to || []).includes(emp.id));
            const approvedCount = empTasks.filter(task => task.status === 'Approved').length;
            const empAttendance = attendance.filter(a => a.employee_id === emp.id);
            const punctuality = empAttendance.length > 0
                ? Math.round((empAttendance.filter(a => a.status === 'Present').length / empAttendance.length) * 100)
                : null;
            return { id: emp.id, name: emp.name, approvedCount, punctuality };
        })
        .sort((a, b) => b.approvedCount - a.approvedCount)
        .slice(0, 5),
    {
        capacity: 10,
        keyFn: (employeeUsers, tasks, attendance) =>
            `${employeeUsers.map((e) => e.id).join(',')}|${tasks.length}:${tasks.map((t) => t.id).join(',')}|${attendance.length}`,
    }
);

/**
 * COMPONENT: DashboardView
 * PURPOSE: Executive Telemetry Dashboard Aggregator.
 * FIXED: Shifted month index processing from (Jul-Dec) to (Jan-Jun) to perfectly match active internship timeline data.
 */
const DashboardView = ({ userProfile, tasks = [], leaveRequests = [], attendance = [], allUsers = [], reviews = [], setActiveView }) => {
    const { t } = useTranslation();
    const [selectedEmployee, setSelectedEmployee] = useState(userProfile.role === 'supervisor' ? 'all' : userProfile.id);
    const [showSettings, setShowSettings] = useState(false);

    // --- 1. CONFIGURABLE WIDGET STATE ---
    const DEFAULT_WIDGETS = {
        metrics: true,
        attendanceChart: true,
        taskChart: true,
        recentReviews: true,
        contractInfo: true,
        leaderboard: true,
        individualTrend: true,
    };
    const [widgets, setWidgets] = useState(() => {
        const saved = localStorage.getItem('dashboard_widgets');
        // Merge over defaults so users who saved a widget config before these
        // two were introduced still get them turned on, instead of the new
        // keys silently evaluating to undefined (falsy) and staying hidden.
        return saved ? { ...DEFAULT_WIDGETS, ...JSON.parse(saved) } : DEFAULT_WIDGETS;
    });

    useEffect(() => {
        localStorage.setItem('dashboard_widgets', JSON.stringify(widgets));
    }, [widgets]);

    const toggleWidget = (key) => {
        setWidgets(prev => ({ ...prev, [key]: !prev[key] }));
    };

    // --- WIDGET MICROKERNEL: each dashboard card is an independent, named
    // slot that can be shown/hidden (widgets state above) AND reordered
    // (widgetOrder below) at runtime — a small plugin-registry flavor
    // instead of a fixed hardcoded layout. Order is persisted per-browser. ---
    const DEFAULT_WIDGET_ORDER = ['metrics', 'contractInfo', 'leaderboard', 'chartsGrid', 'recentReviews'];
    const [widgetOrder, setWidgetOrder] = useState(() => {
        const saved = localStorage.getItem('dashboard_widget_order');
        if (!saved) return DEFAULT_WIDGET_ORDER;
        try {
            const parsed = JSON.parse(saved);
            // Guard against a stale saved order missing a slot introduced later.
            const missing = DEFAULT_WIDGET_ORDER.filter((id) => !parsed.includes(id));
            return [...parsed, ...missing];
        } catch {
            return DEFAULT_WIDGET_ORDER;
        }
    });

    useEffect(() => {
        localStorage.setItem('dashboard_widget_order', JSON.stringify(widgetOrder));
    }, [widgetOrder]);

    const moveWidget = (id, direction) => {
        setWidgetOrder((prev) => {
            const index = prev.indexOf(id);
            const swapWith = index + direction;
            if (swapWith < 0 || swapWith >= prev.length) return prev;
            const next = [...prev];
            [next[index], next[swapWith]] = [next[swapWith], next[index]];
            return next;
        });
    };

    const orderOf = (id) => widgetOrder.indexOf(id);

    // --- 2. SYNCHRONIZED METRICS ---
    
    // PENDING TASKS (Active Workload)
    const activeWorkload = tasks.filter(t => {
        const isActive = t.status === 'To Do' || t.status === 'In Progress' || t.status === 'Revision Needed';
        if (userProfile.role === 'supervisor') return isActive; 
        return isActive && (t.assigned_to || []).includes(userProfile.id);
    }).length;

    // PENDING APPROVALS (Action Items)
    let approvalCount = 0;
    let approvalLabel = t('dashboard.systemOperationsClean');

    if (userProfile.role === 'supervisor') {
        const pendingLeaves = leaveRequests.filter(r => r.status === 'Pending').length;
        const pendingTaskReviews = tasks.filter(t => t.status === 'Completed').length;

        approvalCount = pendingLeaves + pendingTaskReviews;
        if (approvalCount > 0) {
            approvalLabel = t('dashboard.leaveFormsTasksPending', { leaves: pendingLeaves, tasks: pendingTaskReviews });
        }
    } else {
        const myPendingLeaves = leaveRequests.filter(r => r.employee_id === userProfile.id && r.status === 'Pending').length;
        const myPendingTasks = tasks.filter(t =>
            (t.assigned_to || []).includes(userProfile.id) && t.status === 'Completed'
        ).length;

        approvalCount = myPendingLeaves + myPendingTasks;
        if (approvalCount > 0) approvalLabel = t('dashboard.awaitingSupervisorFeedback');
    }

    // Leave Days Taken Calculator
    const getDaysDiff = (start, end) => {
        const date1 = new Date(start);
        const date2 = new Date(end);
        return Math.ceil(Math.abs(date2 - date1) / (1000 * 60 * 60 * 24)) + 1;
    };

    const leaveDaysTaken = leaveRequests
        .filter(req => req.employee_id === userProfile.id && req.status === "Approved")
        .reduce((total, req) => total + getDaysDiff(req.start_date, req.end_date), 0);

    const getUserName = (id) => {
        if (!allUsers || !id) return t('dashboard.unknownOfficer');
        const match = allUsers.find(u => String(u.id) === String(id));
        return match ? match.name : t('dashboard.unknownOfficer');
    };

    // --- ASSIGNMENT & CONTRACT STATUS (supervisor-set, read-only here) ---
    const getContractStatus = () => {
        if (!userProfile.contract_start_date || !userProfile.contract_end_date) {
            return { hasContract: false };
        }
        const start = new Date(userProfile.contract_start_date);
        const end = new Date(userProfile.contract_end_date);
        const now = new Date();
        const totalDays = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
        const elapsedDays = Math.min(totalDays, Math.max(0, Math.ceil((now - start) / (1000 * 60 * 60 * 24))));
        const remainingDays = Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)));
        const percent = Math.min(100, Math.round((elapsedDays / totalDays) * 100));
        return { hasContract: true, remainingDays, percent, isOver: now > end };
    };
    const contractStatus = getContractStatus();

    // =========================================================================
    // 📈 FIXED CALENDAR CHART DATA PROCESSING ENGINE
    // =========================================================================
    const processChartData = () => {
        // 🟩 FIX: Rolling 6-month window ending at the current month, instead of
        // a hardcoded Jan-Jun range. The old range silently excluded whatever
        // month it actually is right now — which is exactly where most live
        // attendance/task activity lives — making the chart look disconnected
        // from real data even though the underlying rows were fine.
        const now = new Date();
        const monthWindow = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            monthWindow.push({
                label: d.toLocaleString('en-US', { month: 'short' }),
                year: d.getFullYear(),
                month: d.getMonth(),
            });
        }

        const users = allUsers.filter(u => u.role === 'employee');

        const attData = [];
        const taskData = [];

        monthWindow.forEach(({ label, year, month }) => {
            const attMonth = { name: label };
            const taskMonth = { name: label };

            users.forEach(u => {
                // Accumulates monthly employee attendance rows
                const presentCount = attendance.filter(a => {
                    const d = new Date(a.date);
                    return a.employee_id === u.id &&
                        d.getMonth() === month &&
                        d.getFullYear() === year &&
                        (a.status === 'Present' || a.status === 'Late');
                }).length;

                // Accumulates monthly completed/approved items
                const completedCount = tasks.filter(t => {
                    const d = new Date(t.due_date);
                    return (t.assigned_to || []).includes(u.id) &&
                        t.status === 'Approved' &&
                        d.getMonth() === month &&
                        d.getFullYear() === year;
                }).length;

                if (selectedEmployee === 'all' || selectedEmployee === u.id) {
                    attMonth[u.name] = presentCount;
                    taskMonth[u.name] = completedCount;
                }
            });
            attData.push(attMonth);
            taskData.push(taskMonth);
        });

        return { attData, taskData };
    };

    const { attData, taskData } = processChartData();
    const employeeUsers = allUsers.filter(u => u.role === 'employee');
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

    // --- LEADERBOARD: ranks employees by approved/completed task volume,
    // with punctuality as a tiebreaker signal shown alongside it.
    // LRU-memoized (see computeLeaderboard above) since this view re-renders
    // on every notification poll even when tasks/attendance haven't changed. ---
    const leaderboard = computeLeaderboard(employeeUsers, tasks, attendance);

    // --- INDIVIDUAL PERFORMANCE TREND: only meaningful once a single
    // employee is picked in the selector above (not the "all" aggregate). ---
    const individualTrendData = selectedEmployee !== 'all'
        ? reviews
            .filter(r => r.employee_id === selectedEmployee)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
            .map(r => ({
                date: r.created_at ? new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
                score: r.final_score,
            }))
        : [];

    return (
        <div className="p-4 md:p-8 relative space-y-6">
            
            {/* --- HEADER --- */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-gray-200 dark:border-gray-700/60 pb-4">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">{t('dashboard.welcome', { name: userProfile.name })}</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('dashboard.subtitle')}</p>
                </div>

                <div className="relative self-end sm:self-center">
                    <button
                        type="button"
                        onClick={() => setShowSettings(!showSettings)}
                        className="flex items-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2 px-4 rounded-xl border transition text-xs dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700 dark:hover:bg-gray-700"
                    >
                        <span>{t('dashboard.configureMetrics')}</span>
                    </button>

                    {showSettings && (
                        <div className="absolute right-0 mt-2 w-64 bg-white rounded-xl shadow-xl border border-gray-100 z-50 p-4 dark:bg-gray-800 dark:border-gray-700 animate-scale-up">
                            <h3 className="font-bold text-xs text-gray-400 uppercase tracking-wider mb-3">{t('dashboard.visibleCards')}</h3>
                            <div className="space-y-2.5 text-xs font-bold text-gray-700 dark:text-gray-300">
                                <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                    <input type="checkbox" checked={widgets.metrics} onChange={() => toggleWidget('metrics')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                    <span>{t('dashboard.keyMetricsSummary')}</span>
                                </label>
                                <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                    <input type="checkbox" checked={widgets.attendanceChart} onChange={() => toggleWidget('attendanceChart')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                    <span>{t('dashboard.attendanceTrendsLine')}</span>
                                </label>
                                <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                    <input type="checkbox" checked={widgets.taskChart} onChange={() => toggleWidget('taskChart')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                    <span>{t('dashboard.taskCompletionBars')}</span>
                                </label>
                                <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                    <input type="checkbox" checked={widgets.recentReviews} onChange={() => toggleWidget('recentReviews')} className="form-checkbox rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                    <span>{t('dashboard.recentAppraisalsSheet')}</span>
                                </label>
                                <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                    <input type="checkbox" checked={widgets.contractInfo} onChange={() => toggleWidget('contractInfo')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                    <span>{t('dashboard.assignmentAndContract')}</span>
                                </label>
                                {userProfile.role === 'supervisor' && (
                                    <>
                                        <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                            <input type="checkbox" checked={widgets.leaderboard} onChange={() => toggleWidget('leaderboard')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                            <span>{t('dashboard.leaderboard')}</span>
                                        </label>
                                        <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                            <input type="checkbox" checked={widgets.individualTrend} onChange={() => toggleWidget('individualTrend')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                            <span>{t('dashboard.individualTrend')}</span>
                                        </label>
                                    </>
                                )}
                            </div>

                            <h3 className="font-bold text-xs text-gray-400 uppercase tracking-wider mb-2 mt-4">{t('dashboard.widgetOrder')}</h3>
                            <div className="space-y-1.5">
                                {widgetOrder.map((id, index) => (
                                    <div key={id} className="flex items-center justify-between gap-2 text-xs font-bold text-gray-700 dark:text-gray-300">
                                        <span>{t(`dashboard.widgetSlot_${id}`)}</span>
                                        <span className="flex gap-1">
                                            <button
                                                type="button"
                                                onClick={() => moveWidget(id, -1)}
                                                disabled={index === 0}
                                                aria-label={t('dashboard.moveUp')}
                                                className="w-5 h-5 flex items-center justify-center rounded border border-gray-200 dark:border-gray-600 disabled:opacity-30 hover:bg-gray-50 dark:hover:bg-gray-700"
                                            >↑</button>
                                            <button
                                                type="button"
                                                onClick={() => moveWidget(id, 1)}
                                                disabled={index === widgetOrder.length - 1}
                                                aria-label={t('dashboard.moveDown')}
                                                className="w-5 h-5 flex items-center justify-center rounded border border-gray-200 dark:border-gray-600 disabled:opacity-30 hover:bg-gray-50 dark:hover:bg-gray-700"
                                            >↓</button>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* --- ADMIN INTERN SELECTOR --- */}
            {(widgets.attendanceChart || widgets.taskChart || widgets.individualTrend) && userProfile.role === 'supervisor' && (
                <div className="flex justify-end bg-white p-3 rounded-2xl border border-gray-100 dark:bg-gray-800 dark:border-gray-700 shadow-sm">
                    <select
                        value={selectedEmployee}
                        onChange={(e) => setSelectedEmployee(e.target.value)}
                        className="p-2 text-xs border border-gray-200 rounded-xl shadow-sm bg-gray-50 dark:bg-gray-900 dark:border-gray-600 dark:text-white focus:outline-none font-bold"
                    >
                        <option value="all">{t('dashboard.allStaff')}</option>
                        {employeeUsers.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                    </select>
                </div>
            )}

            {/* --- REORDERABLE WIDGET SLOTS (microkernel: shown/hidden via `widgets`,
                positioned via `widgetOrder` — both persisted per-browser) --- */}
            <div className="flex flex-col gap-6">

            {/* --- CORE STAT WIDGET CARDS --- */}
            {widgets.metrics && (
                <div style={{ order: orderOf('metrics') }} className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-fade-in-down">
                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 border-l-4 border-l-blue-500 dark:bg-gray-800 dark:border-gray-700/60 dark:border-l-blue-500">
                        <h3 className="font-bold text-xs text-gray-400 uppercase tracking-wider">
                            {userProfile.role === 'supervisor' ? t('dashboard.teamActiveWorkload') : t('dashboard.myPendingTasks')}
                        </h3>
                        <div className="flex items-baseline gap-2 mt-2">
                            <p className="text-4xl font-extrabold text-gray-800 dark:text-gray-100">{activeWorkload}</p>
                            <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">{t('dashboard.tasksActive')}</span>
                        </div>
                    </div>

                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 border-l-4 border-l-green-500 dark:bg-gray-800 dark:border-gray-700/60 dark:border-l-green-500">
                        <h3 className="font-bold text-xs text-gray-400 uppercase tracking-wider">{t('dashboard.accreditedLeaveDays')}</h3>
                        <div className="flex items-baseline gap-2 mt-2">
                            <p className="text-4xl font-extrabold text-gray-800 dark:text-gray-100">{leaveDaysTaken}</p>
                            <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">{t('dashboard.daysClosed')}</span>
                        </div>
                    </div>

                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 border-l-4 border-l-yellow-500 dark:bg-gray-800 dark:border-gray-700/60 dark:border-l-yellow-500">
                        <h3 className="font-bold text-xs text-gray-400 uppercase tracking-wider">
                            {userProfile.role === 'supervisor' ? t('dashboard.approvalsOutstanding') : t('dashboard.awaitingApproval')}
                        </h3>
                        <div className="flex flex-col mt-2 justify-center">
                            <div className="flex items-baseline gap-2">
                                <p className="text-4xl font-extrabold text-gray-800 dark:text-gray-100">{approvalCount}</p>
                                <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">{t('dashboard.itemsFlagged')}</span>
                            </div>
                            {approvalCount > 0 && (
                                <p className="text-[10px] font-bold text-amber-600 dark:text-amber-400 italic mt-1 bg-amber-50 dark:bg-amber-950/20 px-2 py-0.5 rounded w-fit">{approvalLabel}</p>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* --- ASSIGNMENT & CONTRACT CARD --- */}
            {widgets.contractInfo && (
                <div style={{ order: orderOf('contractInfo') }} className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700/60">
                    <h2 className="text-sm font-bold text-gray-700 mb-4 dark:text-gray-100 uppercase tracking-wider">{t('dashboard.assignmentAndContract')}</h2>
                    {userProfile.department || contractStatus.hasContract ? (
                        <div className="space-y-3 max-w-md">
                            <div className="flex justify-between items-center text-xs">
                                <span className="font-bold text-gray-400 uppercase tracking-wider">{t('dashboard.department')}</span>
                                <span className="font-bold text-gray-800 dark:text-gray-100">{userProfile.department || t('dashboard.notAssignedYet')}</span>
                            </div>
                            {contractStatus.hasContract ? (
                                <>
                                    <div className="flex justify-between items-center text-xs">
                                        <span className="font-bold text-gray-400 uppercase tracking-wider">{t('dashboard.contractPeriod')}</span>
                                        <span className="font-bold text-gray-800 dark:text-gray-100">
                                            {new Date(userProfile.contract_start_date).toLocaleDateString('en-GB')} – {new Date(userProfile.contract_end_date).toLocaleDateString('en-GB')}
                                        </span>
                                    </div>
                                    <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                                        <div className={`h-2 rounded-full ${contractStatus.isOver ? 'bg-gray-400' : 'bg-blue-500'}`} style={{ width: `${contractStatus.percent}%` }} />
                                    </div>
                                    <p className="text-[11px] font-bold text-gray-500 dark:text-gray-400">
                                        {contractStatus.isOver ? t('dashboard.contractCompleted') : t('dashboard.daysRemaining', { count: contractStatus.remainingDays })}
                                    </p>
                                </>
                            ) : (
                                <p className="text-xs text-gray-400 italic">{t('dashboard.contractDatesNotSet')}</p>
                            )}
                        </div>
                    ) : (
                        <p className="text-center text-xs text-gray-400 py-4 dark:text-gray-500 italic">{t('dashboard.noAssignmentYet')}</p>
                    )}
                </div>
            )}

            {/* --- LEADERBOARD: top performers by approved task volume --- */}
            {widgets.leaderboard && userProfile.role === 'supervisor' && (
                <div style={{ order: orderOf('leaderboard') }} className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700/60">
                    <h2 className="text-sm font-bold text-gray-700 mb-4 dark:text-gray-100 uppercase tracking-wider">{t('dashboard.leaderboard')}</h2>
                    {leaderboard.length > 0 ? (
                        <div className="space-y-2">
                            {leaderboard.map((entry, index) => (
                                <div key={entry.id} className="flex items-center gap-3 p-2.5 rounded-xl bg-gray-50/60 dark:bg-gray-900/30">
                                    <span className="w-6 text-center text-sm font-black text-gray-400">
                                        {index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`}
                                    </span>
                                    <span className="flex-1 text-xs font-bold text-gray-800 dark:text-gray-100">{entry.name}</span>
                                    <span className="text-[10px] font-bold text-gray-400 uppercase">
                                        {t('dashboard.tasksApproved', { count: entry.approvedCount })}
                                    </span>
                                    {entry.punctuality !== null && (
                                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                                            {t('dashboard.punctualityPercent', { percent: entry.punctuality })}
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-center text-xs text-gray-400 py-6 dark:text-gray-500 italic">{t('dashboard.noLeaderboardData')}</p>
                    )}
                </div>
            )}

            {/* --- RECHARTS TIMELINE GRAPH GRIDS --- */}
            <div style={{ order: orderOf('chartsGrid') }} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {widgets.attendanceChart && (
                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700/60">
                        <h2 className="text-sm font-bold text-gray-700 mb-4 dark:text-gray-100 uppercase tracking-wider">{t('dashboard.attendanceTrendsTimeline')}</h2>
                        <div style={{ width: '100%', height: 280, minHeight: 200 }} className="text-xs font-medium">
                            <ResponsiveContainer width="100%" height={280}>
                                <LineChart data={attData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.1} />
                                    <XAxis dataKey="name" stroke="#94a3b8" fontStyle="bold" />
                                    <YAxis stroke="#94a3b8" />
                                    <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: 'none', color:'#fff', borderRadius:'12px', fontSize:'11px', fontWeight:'bold' }} />
                                    <Legend wrapperStyle={{ paddingTop: '10px', fontSize: '11px', fontWeight: 'bold' }}/>
                                    {employeeUsers.map((emp, index) => {
                                        if (selectedEmployee === 'all' || selectedEmployee === emp.id) {
                                            return <Line key={emp.id} type="monotone" dataKey={emp.name} stroke={colors[index % colors.length]} strokeWidth={3} dot={{r:3}} activeDot={{r:5}} />;
                                        }
                                        return null;
                                    })}
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                )}

                {widgets.taskChart && (
                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700/60">
                        <h2 className="text-sm font-bold text-gray-700 mb-4 dark:text-gray-100 uppercase tracking-wider">{t('dashboard.deliverablesCompletedVolume')}</h2>
                        <div style={{ width: '100%', height: 280, minHeight: 200 }} className="text-xs font-medium">
                            <ResponsiveContainer width="100%" height={280}>
                                <BarChart data={taskData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.1} />
                                    <XAxis dataKey="name" stroke="#94a3b8" fontStyle="bold" />
                                    <YAxis stroke="#94a3b8" />
                                    <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: 'none', color:'#fff', borderRadius:'12px', fontSize:'11px', fontWeight:'bold' }} cursor={{fill: 'rgba(255,255,255,0.05)'}}/>
                                    <Legend wrapperStyle={{ paddingTop: '10px', fontSize: '11px', fontWeight: 'bold' }}/>
                                    {employeeUsers.map((emp, index) => {
                                        if (selectedEmployee === 'all' || selectedEmployee === emp.id) {
                                            return <Bar key={emp.id} dataKey={emp.name} fill={colors[index % colors.length]} radius={[4, 4, 0, 0]} maxBarSize={30} />;
                                        }
                                        return null;
                                    })}
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                )}

                {widgets.individualTrend && selectedEmployee !== 'all' && (
                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700/60 lg:col-span-2">
                        <h2 className="text-sm font-bold text-gray-700 mb-4 dark:text-gray-100 uppercase tracking-wider">
                            {t('dashboard.individualTrend')}: {employeeUsers.find(e => e.id === selectedEmployee)?.name}
                        </h2>
                        {individualTrendData.length > 0 ? (
                            <div style={{ width: '100%', height: 240 }} className="text-xs font-medium">
                                <ResponsiveContainer width="100%" height={240}>
                                    <LineChart data={individualTrendData}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.1} />
                                        <XAxis dataKey="date" stroke="#94a3b8" fontStyle="bold" />
                                        <YAxis stroke="#94a3b8" domain={[0, 100]} />
                                        <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: 'none', color:'#fff', borderRadius:'12px', fontSize:'11px', fontWeight:'bold' }} />
                                        <Line type="monotone" dataKey="score" name={t('dashboard.scoreLabel')} stroke="#3b82f6" strokeWidth={3} dot={{r:4}} activeDot={{r:6}} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        ) : (
                            <p className="text-center text-xs text-gray-400 py-8 dark:text-gray-500 italic">{t('dashboard.noTrendData')}</p>
                        )}
                    </div>
                )}
            </div>

            {/* --- RECENT APPRAISAL LOGS TRANSCRIPTS --- */}
            {widgets.recentReviews && (
                <div style={{ order: orderOf('recentReviews') }} className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700/60">
                    <h2 className="text-sm font-bold text-gray-700 mb-4 dark:text-gray-100 uppercase tracking-wider">{t('dashboard.performanceTranscriptLog')}</h2>
                    {reviews && reviews.length > 0 ? (
                        <div className="space-y-4">
                            {reviews.slice(0, 3).map(review => {
                                const textToDisplay = review.comments || review.review_text || t('dashboard.noObservations');
                                const truncatedText = textToDisplay.length > 100 ? textToDisplay.substring(0, 100) + '...' : textToDisplay;

                                return (
                                    <button
                                        key={review.id}
                                        type="button"
                                        onClick={() => setActiveView && setActiveView('reviews')}
                                        className="w-full text-left border-b pb-4 last:border-b-0 last:pb-0 border-gray-50 dark:border-gray-700/60 animate-fade-in group hover:bg-gray-50/60 dark:hover:bg-gray-700/20 rounded-lg transition-colors -mx-2 px-2"
                                    >
                                        <div className="flex justify-between items-start gap-4 mb-2 text-xs">
                                            <div className="space-y-1">
                                                <p className="font-bold text-gray-800 dark:text-gray-200">
                                                    {t('dashboard.appraisalFiledBy')} <span className="text-blue-600 dark:text-blue-400">{getUserName(review.supervisor_id)}</span>
                                                </p>
                                                {review.final_score !== undefined && (
                                                    <div className="flex items-center gap-2">
                                                        <div className="flex text-yellow-400 text-xs tracking-tighter">
                                                            {[...Array(Math.max(1, Math.min(5, Math.round((review.final_score / 100) * 5))))].map((_, i) => <span key={i}>★</span>)}
                                                        </div>
                                                        <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400">
                                                            {t('dashboard.indexPts', { score: review.final_score })}
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                            <p className="text-[10px] font-bold text-gray-400 font-mono uppercase">
                                                {review.created_at ? new Date(review.created_at).toLocaleDateString('en-GB') : (review.date || t('dashboard.pendingLog'))}
                                            </p>
                                        </div>
                                        <p className="text-gray-600 dark:text-gray-300 text-xs italic pl-1 leading-relaxed bg-gray-50/40 dark:bg-gray-900/20 p-3 rounded-xl border border-dashed dark:border-gray-700/40">
                                            "{truncatedText}"
                                        </p>
                                        <span className="mt-2 inline-block text-[10px] font-bold text-blue-600 dark:text-blue-400 group-hover:underline">
                                            {t('dashboard.viewFullRubric')}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="text-center text-xs text-gray-400 py-8 dark:text-gray-500 italic">{t('dashboard.noAppraisalScores')}</p>
                    )}
                </div>
            )}
            </div>
        </div>
    );
};

export default DashboardView;