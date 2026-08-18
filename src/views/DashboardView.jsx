import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
    LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { memoizeWithLru } from '../patterns/LRUCache';
import { profilesRepository } from '../data/repositories/profilesRepository';
import { showUserError } from '../utils/errorHandling';
import { detectAttendanceAnomalies } from '../domain/attendanceAnomalyDetector';
import { computeEngagementScores } from '../domain/employeeEngagementScore';
import { useStaffAssignmentEditor } from '../hooks/useStaffAssignmentEditor';
import { supabase } from '../supabaseClient';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';
import { getChartTheme } from '../utils/chartTheme';
import ModuleTabBar from '../components/ModuleTabBar';

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
const DashboardView = ({ userProfile, tasks = [], leaveRequests = [], attendance = [], allUsers = [], reviews = [], setActiveView, fetchAllUsers, isDarkMode = false }) => {
    const chartTheme = getChartTheme(isDarkMode);
    const { t } = useTranslation();
    const [selectedEmployee, setSelectedEmployee] = useState(userProfile.role === 'supervisor' ? 'all' : userProfile.id);
    const [showSettings, setShowSettings] = useState(false);
    const [activeTab, setActiveTab] = useState('overview');
    // 🟩 INLINE EDITING: Outsource Directory edits an employee's assignment
    // fields directly in the table now (no more redirecting to Settings) --
    // shared hook with Settings > Manage Staff Assignments (see
    // hooks/useStaffAssignmentEditor.js) so both stay in sync on the field
    // list and save mutation.
    const staffEditor = useStaffAssignmentEditor(fetchAllUsers);
    // 🟩 Same signed-URL pattern as Settings > Manage Staff Assignments'
    // handleViewLoa -- the loa_documents bucket is private, so this is the
    // only way to actually open one.
    const handleViewLoa = async (path) => {
        const { data, error } = await supabase.storage.from('loa_documents').createSignedUrl(path, 60);
        if (error) {
            showUserError('errors.openLoaDocument', error);
            return;
        }
        if (data) window.open(data.signedUrl, '_blank');
    };
    // 🟩 GHOST-EMPLOYEE DETECTION: on-demand (not auto-run on every dashboard
    // visit -- it's an occasional integrity check, not something that needs
    // to load unconditionally for every supervisor session) server-side
    // comparison of every enrolled face template against every other
    // employee's (see migrations/20260810_add_duplicate_enrollment_detection.sql).
    // 'idle' | 'loading' | 'done'
    const [duplicateCheckStatus, setDuplicateCheckStatus] = useState('idle');
    const [duplicatePairs, setDuplicatePairs] = useState([]);
    const runDuplicateEnrollmentCheck = async () => {
        setDuplicateCheckStatus('loading');
        try {
            const rows = await profilesRepository.findDuplicateEnrollments();
            setDuplicatePairs(rows || []);
            setDuplicateCheckStatus('done');
        } catch (err) {
            showUserError('errors.checkDuplicateEnrollments', err);
            setDuplicateCheckStatus('idle');
        }
    };

    // --- 1. CONFIGURABLE WIDGET STATE ---
    const DEFAULT_WIDGETS = {
        metrics: true,
        attendanceChart: true,
        taskChart: true,
        recentReviews: true,
        contractInfo: true,
        leaderboard: true,
        individualTrend: true,
        outsourceDirectory: true,
        attendanceAnomalies: true,
        engagementSignal: true,
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
    const DEFAULT_WIDGET_ORDER = ['metrics', 'contractInfo', 'leaderboard', 'outsourceDirectory', 'attendanceAnomalies', 'engagementSignal', 'chartsGrid', 'recentReviews'];
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
    // 🟩 PERFORMANCE: these were plain filter/reduce chains re-run on every
    // render (including unrelated ones -- the widget-order effect, the
    // employee dropdown, every keystroke while inline-editing a row via
    // useStaffAssignmentEditor) -- memoized like the sibling attData/
    // taskData calculations elsewhere in this file already are.
    const activeWorkload = useMemo(() => tasks.filter(t => {
        const isActive = t.status === 'To Do' || t.status === 'In Progress' || t.status === 'Revision Needed';
        if (userProfile.role === 'supervisor') return isActive;
        return isActive && (t.assigned_to || []).includes(userProfile.id);
    }).length, [tasks, userProfile.role, userProfile.id]);

    // PENDING APPROVALS (Action Items)
    const { approvalCount, approvalLabel } = useMemo(() => {
        if (userProfile.role === 'supervisor') {
            const pendingLeaves = leaveRequests.filter(r => r.status === 'Pending').length;
            const pendingTaskReviews = tasks.filter(t => t.status === 'Completed').length;
            const count = pendingLeaves + pendingTaskReviews;
            return {
                approvalCount: count,
                approvalLabel: count > 0
                    ? t('dashboard.leaveFormsTasksPending', { leaves: pendingLeaves, tasks: pendingTaskReviews })
                    : t('dashboard.systemOperationsClean'),
            };
        }
        const myPendingLeaves = leaveRequests.filter(r => r.employee_id === userProfile.id && r.status === 'Pending').length;
        const myPendingTasks = tasks.filter(t =>
            (t.assigned_to || []).includes(userProfile.id) && t.status === 'Completed'
        ).length;
        const count = myPendingLeaves + myPendingTasks;
        return {
            approvalCount: count,
            approvalLabel: count > 0 ? t('dashboard.awaitingSupervisorFeedback') : t('dashboard.systemOperationsClean'),
        };
    }, [tasks, leaveRequests, userProfile.role, userProfile.id, t]);

    // Leave Days Taken Calculator
    const getDaysDiff = (start, end) => {
        const date1 = new Date(start);
        const date2 = new Date(end);
        return Math.ceil(Math.abs(date2 - date1) / (1000 * 60 * 60 * 24)) + 1;
    };

    const leaveDaysTaken = useMemo(
        () => leaveRequests
            .filter(req => req.employee_id === userProfile.id && req.status === "Approved")
            .reduce((total, req) => total + getDaysDiff(req.start_date, req.end_date), 0),
        [leaveRequests, userProfile.id]
    );

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
    // 🟩 PERFORMANCE: was a plain function re-invoked on every render
    // (including unrelated ones, like the widget-order localStorage effect
    // firing) that re-scanned the FULL attendance and tasks arrays once per
    // (month × employee) pair — O(months × employees × records). Attendance
    // and tasks are now bucketed by employee+month a single time, turning
    // each cell into an O(1) Map lookup, and the whole thing is memoized so
    // it only recomputes when the underlying data or filter actually changes.
    const { attData, taskData } = useMemo(() => {
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

        const presentByEmpMonth = new Map();
        for (const a of attendance) {
            if (a.status !== 'Present' && a.status !== 'Late') continue;
            const d = new Date(a.date);
            const key = `${a.employee_id}|${d.getFullYear()}-${d.getMonth()}`;
            presentByEmpMonth.set(key, (presentByEmpMonth.get(key) || 0) + 1);
        }

        const completedByEmpMonth = new Map();
        for (const t of tasks) {
            if (t.status !== 'Approved') continue;
            const d = new Date(t.due_date);
            for (const empId of (t.assigned_to || [])) {
                const key = `${empId}|${d.getFullYear()}-${d.getMonth()}`;
                completedByEmpMonth.set(key, (completedByEmpMonth.get(key) || 0) + 1);
            }
        }

        const attData = [];
        const taskData = [];

        monthWindow.forEach(({ label, year, month }) => {
            const attMonth = { name: label };
            const taskMonth = { name: label };

            users.forEach(u => {
                if (selectedEmployee === 'all' || selectedEmployee === u.id) {
                    const key = `${u.id}|${year}-${month}`;
                    attMonth[u.name] = presentByEmpMonth.get(key) || 0;
                    taskMonth[u.name] = completedByEmpMonth.get(key) || 0;
                }
            });
            attData.push(attMonth);
            taskData.push(taskMonth);
        });

        return { attData, taskData };
    }, [allUsers, attendance, tasks, selectedEmployee]);
    const employeeUsers = allUsers.filter(u => u.role === 'employee');
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

    // --- OUTSOURCE DIRECTORY search/filter/sort -- mirrors the Attendance
    // view's filter bar (search + institution/mode/status + sort) but scoped
    // only to this widget's own copy of employeeUsers, so it never affects
    // the Leaderboard/Team widgets that also read employeeUsers directly.
    const [directorySearchTerm, setDirectorySearchTerm] = useState('');
    const [directoryFilterSource, setDirectoryFilterSource] = useState('all');
    const [directoryFilterMode, setDirectoryFilterMode] = useState('all');
    const [directorySortBy, setDirectorySortBy] = useState('name-az');
    const directorySources = [...new Set(employeeUsers.map(e => e.source || e.university).filter(Boolean))];
    const filteredDirectoryUsers = employeeUsers
        .filter(emp => {
            const matchesSearch = (emp.name || '').toLowerCase().includes(directorySearchTerm.toLowerCase());
            const empSource = emp.source || emp.university || '';
            const matchesSource = directoryFilterSource === 'all' || empSource === directoryFilterSource;
            const matchesMode = directoryFilterMode === 'all' || (emp.work_mode || 'WFO') === directoryFilterMode;
            return matchesSearch && matchesSource && matchesMode;
        })
        .sort((a, b) => {
            if (directorySortBy === 'name-za') return (b.name || '').localeCompare(a.name || '');
            return (a.name || '').localeCompare(b.name || '');
        });

    // --- LEADERBOARD: ranks employees by approved/completed task volume,
    // with punctuality as a tiebreaker signal shown alongside it.
    // LRU-memoized (see computeLeaderboard above) since this view re-renders
    // on every notification poll even when tasks/attendance haven't changed. ---
    const leaderboard = computeLeaderboard(employeeUsers, tasks, attendance);

    // 🟩 NEW SUBMODULE: Full Leaderboard -- the widget above deliberately
    // caps at the top 5 (computeLeaderboard itself slices before returning,
    // to keep the LRU-memoized widget cheap), so nothing ever showed
    // where employee #6 and onward stood. A separate, unsliced computation
    // here -- same ranking rule (approved task count, punctuality as a
    // tiebreaker signal) -- rather than changing the shared memoized util
    // and risking the existing widget's behavior/cache-key shape.
    const fullLeaderboard = useMemo(
        () => employeeUsers
            .map(emp => {
                const empTasks = tasks.filter(task => (task.assigned_to || []).includes(emp.id));
                const approvedCount = empTasks.filter(task => task.status === 'Approved').length;
                const empAttendance = attendance.filter(a => a.employee_id === emp.id);
                const punctuality = empAttendance.length > 0
                    ? Math.round((empAttendance.filter(a => a.status === 'Present').length / empAttendance.length) * 100)
                    : null;
                return { id: emp.id, name: emp.name, approvedCount, punctuality };
            })
            .sort((a, b) => b.approvedCount - a.approvedCount),
        [employeeUsers, tasks, attendance]
    );

    // --- ATTENDANCE ANOMALIES: per-employee statistical outliers (median +
    // MAD, robust against masking) against each person's OWN clock-in
    // history -- see domain/attendanceAnomalyDetector.js. Recomputed only
    // when the underlying data actually changes, same LRU-memoized pattern
    // as the leaderboard above (this view re-renders on every notification
    // poll regardless of whether attendance changed).
    const attendanceAnomalies = useMemo(
        () => detectAttendanceAnomalies(attendance),
        [attendance]
    );

    // --- ENGAGEMENT SIGNAL: composite punctuality/task-completion/review-
    // trend/anomaly-count score per employee, worst-first -- see
    // domain/employeeEngagementScore.js for why this is deliberately NOT
    // framed as "flight risk prediction" the way some enterprise HR
    // platforms do it (a well-documented ethical problem with that
    // pattern). Advisory and fully explainable, not a black-box score.
    const engagementScores = useMemo(
        () => computeEngagementScores(employeeUsers, { tasks, attendance, reviews }),
        [employeeUsers, tasks, attendance, reviews]
    );

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
                                {/* 🟩 Supervisor-hidden: the widget this toggles never renders
                                    for a supervisor now (it's the viewer's own assignment/
                                    contract status), so the checkbox would just be dead. */}
                                {userProfile.role !== 'supervisor' && (
                                    <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                        <input type="checkbox" checked={widgets.contractInfo} onChange={() => toggleWidget('contractInfo')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                        <span>{t('dashboard.assignmentAndContract')}</span>
                                    </label>
                                )}
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
                                        <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                            <input type="checkbox" checked={widgets.outsourceDirectory} onChange={() => toggleWidget('outsourceDirectory')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                            <span>{t('dashboard.outsourceDirectory')}</span>
                                        </label>
                                        <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                            <input type="checkbox" checked={widgets.attendanceAnomalies} onChange={() => toggleWidget('attendanceAnomalies')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                            <span>{t('dashboard.attendanceAnomalies')}</span>
                                        </label>
                                        <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                            <input type="checkbox" checked={widgets.engagementSignal} onChange={() => toggleWidget('engagementSignal')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                            <span>{t('dashboard.engagementSignal')}</span>
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

            <ModuleTabBar
                tabs={[
                    { id: 'overview', label: t('dashboard.tabOverview'), icon: Icons.LayoutDashboard },
                    { id: 'fullLeaderboard', label: t('dashboard.tabFullLeaderboard'), icon: Icons.Trophy },
                    { id: 'engagementFull', label: t('dashboard.tabEngagementFull'), icon: Icons.ScatterChart },
                ]}
                activeTab={activeTab}
                onChange={setActiveTab}
            />

            {activeTab === 'fullLeaderboard' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('dashboard.fullLeaderboardTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('dashboard.fullLeaderboardDescription')}</p>
                    {fullLeaderboard.length === 0 ? (
                        <EmptyState icon={Icons.Trophy} title={t('dashboard.noEmployeesYet')} className="py-6" />
                    ) : (
                        <ul className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {fullLeaderboard.map((row, idx) => (
                                <li key={row.id} className="py-3 flex items-center justify-between gap-4">
                                    <div className="flex items-center gap-3">
                                        <span className="text-[10px] font-black text-gray-300 dark:text-gray-600 w-5 text-right">{idx + 1}</span>
                                        <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{row.name}</span>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {row.punctuality !== null && (
                                            <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-900/40 dark:text-gray-300">
                                                {t('dashboard.punctualityPercent', { percent: row.punctuality })}
                                            </span>
                                        )}
                                        <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
                                            {t('dashboard.tasksApproved', { count: row.approvedCount })}
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {activeTab === 'engagementFull' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('dashboard.engagementFullTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('dashboard.engagementFullDescription')}</p>
                    {engagementScores.filter((s) => s.compositeScore !== null).length === 0 ? (
                        <EmptyState icon={Icons.ScatterChart} title={t('dashboard.noEmployeesYet')} className="py-6" />
                    ) : (
                        <ul className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {engagementScores.filter((s) => s.compositeScore !== null).map((s) => (
                                <li key={s.employeeId} className="py-3 flex items-center justify-between gap-4">
                                    <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{getUserName(s.employeeId)}</span>
                                    <span className={`text-[10px] font-bold px-2 py-1 rounded-lg shrink-0 ${
                                        s.compositeScore >= 70
                                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                                            : s.compositeScore >= 40
                                            ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                                            : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                                    }`}>
                                        {s.compositeScore}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {activeTab === 'overview' && (
            <>
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
            {/* 🟩 Supervisor-hidden: this shows the *viewer's own*
                department/contract assignment ("ask your supervisor to set
                this") -- meaningless (and a little odd) from a supervisor's
                own dashboard, since they're the one who'd be doing the
                assigning, not waiting on it. */}
            {widgets.contractInfo && userProfile.role !== 'supervisor' && (
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

            {/* --- OUTSOURCE DIRECTORY: who's on assignment, from where, doing
                what -- the actual purpose of an outsourcing management
                dashboard is knowing this at a glance, not just attendance/task
                metrics. Read-only here; editable via Settings > Manage Staff
                Assignments (position/department/job desk/contract dates). --- */}
            {widgets.outsourceDirectory && userProfile.role === 'supervisor' && (
                <div style={{ order: orderOf('outsourceDirectory') }} className="bg-white rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700/60 overflow-hidden">
                    <div className="p-5 pb-0 flex items-start justify-between gap-4 flex-wrap">
                        <div>
                            <h2 className="text-sm font-bold text-gray-700 mb-1 dark:text-gray-100 uppercase tracking-wider">{t('dashboard.outsourceDirectory')}</h2>
                            <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-4 font-medium">{t('dashboard.outsourceDirectoryDescription')}</p>
                        </div>
                        <button
                            type="button"
                            onClick={runDuplicateEnrollmentCheck}
                            disabled={duplicateCheckStatus === 'loading'}
                            title={t('dashboard.duplicateCheckHint')}
                            className="shrink-0 text-[11px] font-bold text-amber-700 hover:text-amber-900 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 px-3 py-1.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {duplicateCheckStatus === 'loading' ? t('dashboard.duplicateCheckRunning') : `🔍 ${t('dashboard.duplicateCheckButton')}`}
                        </button>
                    </div>

                    {duplicateCheckStatus === 'done' && (
                        <div className="mx-5 mb-4">
                            {duplicatePairs.length === 0 ? (
                                <p className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900/50 rounded-lg px-3 py-2">
                                    ✅ {t('dashboard.duplicateCheckClean')}
                                </p>
                            ) : (
                                <div className="text-xs bg-red-50 border border-red-200 dark:bg-red-950/30 dark:border-red-900/50 rounded-lg p-3 space-y-1.5">
                                    <p className="font-bold text-red-700 dark:text-red-300">
                                        ⚠️ {t('dashboard.duplicateCheckFound', { count: duplicatePairs.length })}
                                    </p>
                                    {duplicatePairs.map((pair, idx) => (
                                        <p key={idx} className="text-red-600 dark:text-red-400">
                                            {t('dashboard.duplicatePairLine', {
                                                a: pair.employee_a_name,
                                                b: pair.employee_b_name,
                                                distance: Number(pair.min_distance).toFixed(3),
                                            })}
                                        </p>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {employeeUsers.length > 0 && (
                        <div className="mx-5 mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 bg-gray-50/60 dark:bg-gray-900/30 p-3 rounded-xl border border-gray-100 dark:border-gray-700/60">
                            <div>
                                <label htmlFor="dir-search" className="block text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-1.5">{t('dashboard.searchStaff')}</label>
                                <input
                                    id="dir-search"
                                    type="text"
                                    value={directorySearchTerm}
                                    onChange={(e) => setDirectorySearchTerm(e.target.value)}
                                    placeholder={t('dashboard.searchStaffPlaceholder')}
                                    className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/60 rounded-lg focus:outline-none focus:border-blue-500 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 font-medium"
                                />
                            </div>
                            <div>
                                <label htmlFor="dir-source" className="block text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-1.5">{t('dashboard.colInstitution')}</label>
                                <select id="dir-source" value={directoryFilterSource} onChange={(e) => setDirectoryFilterSource(e.target.value)} className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/60 rounded-lg focus:outline-none focus:border-blue-500 text-gray-900 dark:text-white font-bold">
                                    <option value="all">{t('dashboard.allInstitutions')}</option>
                                    {directorySources.map(src => <option key={src} value={src}>{src}</option>)}
                                </select>
                            </div>
                            <div>
                                <label htmlFor="dir-mode" className="block text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-1.5">{t('dashboard.colDutyMode')}</label>
                                <select id="dir-mode" value={directoryFilterMode} onChange={(e) => setDirectoryFilterMode(e.target.value)} className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/60 rounded-lg focus:outline-none focus:border-blue-500 text-gray-900 dark:text-white font-bold">
                                    <option value="all">{t('dashboard.allModes')}</option>
                                    <option value="WFO">{t('dashboard.dutyModeOffice')}</option>
                                    <option value="WFH">{t('dashboard.dutyModeRemote')}</option>
                                </select>
                            </div>
                            <div>
                                <label htmlFor="dir-sort" className="block text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-1.5">{t('dashboard.sortConfiguration')}</label>
                                <select id="dir-sort" value={directorySortBy} onChange={(e) => setDirectorySortBy(e.target.value)} className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/60 rounded-lg focus:outline-none focus:border-blue-500 text-gray-900 dark:text-white font-bold">
                                    <option value="name-az">{t('dashboard.nameAZ')}</option>
                                    <option value="name-za">{t('dashboard.nameZA')}</option>
                                </select>
                            </div>
                        </div>
                    )}

                    {filteredDirectoryUsers.length > 0 ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider border-y border-gray-100 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/30">
                                        <th className="px-4 py-2.5">{t('dashboard.colStaffName')}</th>
                                        <th className="px-4 py-2.5">{t('dashboard.colInstitution')}</th>
                                        <th className="px-4 py-2.5">{t('dashboard.colPosition')}</th>
                                        <th className="px-4 py-2.5">{t('dashboard.colDepartment')}</th>
                                        <th className="px-4 py-2.5">{t('dashboard.colDutyMode')}</th>
                                        <th className="px-4 py-2.5">{t('dashboard.colContractPeriod')}</th>
                                        <th className="px-4 py-2.5"></th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/40">
                                    {filteredDirectoryUsers.map((emp) => {
                                        const isEditing = staffEditor.editingId === emp.id;
                                        // 🟩 INLINE EDITING: same shared hook/field-set as Settings
                                        // > Manage Staff Assignments (hooks/useStaffAssignmentEditor.js)
                                        // -- edits happen right in this row instead of redirecting
                                        // away, per explicit request.
                                        const cellInputClass = "w-full p-1.5 text-xs border border-gray-200 rounded-lg dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none";
                                        return (
                                            <tr key={emp.id} className="text-gray-700 dark:text-gray-300 hover:bg-gray-50/60 dark:hover:bg-gray-900/20 align-top">
                                                <td className="px-4 py-2.5 font-bold text-gray-800 dark:text-gray-100 whitespace-nowrap">
                                                    {isEditing ? (
                                                        <input type="text" value={staffEditor.draft.name} onChange={(e) => staffEditor.updateField('name', e.target.value)} className={cellInputClass} />
                                                    ) : emp.name}
                                                </td>
                                                <td className="px-4 py-2.5 whitespace-nowrap">
                                                    {isEditing ? (
                                                        <input type="text" value={staffEditor.draft.source} onChange={(e) => staffEditor.updateField('source', e.target.value)} placeholder={t('settings.institutionPlaceholder')} className={cellInputClass} />
                                                    ) : (emp.source || emp.university || t('dashboard.notSet'))}
                                                </td>
                                                <td className="px-4 py-2.5 whitespace-nowrap" title={!isEditing ? (emp.job_desk || '') : ''}>
                                                    {isEditing ? (
                                                        <input type="text" value={staffEditor.draft.position} onChange={(e) => staffEditor.updateField('position', e.target.value)} placeholder={t('settings.positionPlaceholder')} className={cellInputClass} />
                                                    ) : (emp.position || t('dashboard.notSet'))}
                                                </td>
                                                <td className="px-4 py-2.5 whitespace-nowrap">
                                                    {isEditing ? (
                                                        <input type="text" value={staffEditor.draft.department} onChange={(e) => staffEditor.updateField('department', e.target.value)} placeholder={t('settings.departmentPlaceholder')} className={cellInputClass} />
                                                    ) : (emp.department || t('dashboard.notSet'))}
                                                </td>
                                                <td className="px-4 py-2.5 whitespace-nowrap">
                                                    {isEditing ? (
                                                        <select value={staffEditor.draft.work_mode} onChange={(e) => staffEditor.updateField('work_mode', e.target.value)} className={cellInputClass}>
                                                            <option value="WFO">{t('dashboard.dutyModeOffice')}</option>
                                                            <option value="WFH">{t('dashboard.dutyModeRemote')}</option>
                                                        </select>
                                                    ) : ((emp.work_mode || 'WFO') === 'WFO' ? t('dashboard.dutyModeOffice') : t('dashboard.dutyModeRemote'))}
                                                </td>
                                                <td className="px-4 py-2.5 whitespace-nowrap">
                                                    {isEditing ? (
                                                        <div className="flex gap-1">
                                                            <input type="date" value={staffEditor.draft.contract_start_date} onChange={(e) => staffEditor.updateField('contract_start_date', e.target.value)} className={cellInputClass} />
                                                            <input type="date" value={staffEditor.draft.contract_end_date} onChange={(e) => staffEditor.updateField('contract_end_date', e.target.value)} className={cellInputClass} />
                                                        </div>
                                                    ) : (
                                                        emp.contract_start_date && emp.contract_end_date
                                                            ? `${new Date(emp.contract_start_date).toLocaleDateString('en-GB')} – ${new Date(emp.contract_end_date).toLocaleDateString('en-GB')}`
                                                            : t('dashboard.notSet')
                                                    )}
                                                </td>
                                                <td className="px-4 py-2.5 whitespace-nowrap">
                                                    {isEditing ? (
                                                        <div className="flex gap-2">
                                                            <button type="button" onClick={() => staffEditor.save(emp.id)} disabled={staffEditor.savingId === emp.id} className="text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded-lg disabled:opacity-50">
                                                                {staffEditor.savingId === emp.id ? t('settings.saving') : t('settings.save')}
                                                            </button>
                                                            <button type="button" onClick={staffEditor.cancelEdit} className="text-[11px] font-bold text-gray-500 hover:text-gray-700 dark:text-gray-400 px-2 py-1 rounded-lg">
                                                                {t('settings.cancel')}
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <div className="flex gap-3">
                                                            {emp.loa_file_path && (
                                                                <button type="button" onClick={() => handleViewLoa(emp.loa_file_path)} className="text-[11px] font-bold text-gray-500 hover:text-gray-700 dark:text-gray-400 underline">
                                                                    {t('settings.viewLoa')}
                                                                </button>
                                                            )}
                                                            <button type="button" onClick={() => staffEditor.startEdit(emp)} className="text-[11px] font-bold text-blue-600 hover:text-blue-800 dark:text-blue-400">
                                                                {t('dashboard.editStaff')}
                                                            </button>
                                                        </div>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <p className="text-center text-xs text-gray-400 py-6 dark:text-gray-500 italic">
                            {employeeUsers.length > 0 ? t('dashboard.noDirectoryMatches') : t('dashboard.noEmployeesFound')}
                        </p>
                    )}
                </div>
            )}

            {/* --- ATTENDANCE ANOMALIES: statistical outliers (median + MAD)
                against each employee's OWN clock-in history -- flags what a
                manual scan of the table wouldn't catch. Advisory-only for
                human review, explicitly not an accusation (see the widget's
                own description text). --- */}
            {widgets.attendanceAnomalies && userProfile.role === 'supervisor' && (
                <div style={{ order: orderOf('attendanceAnomalies') }} className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700/60">
                    <h2 className="text-sm font-bold text-gray-700 mb-1 dark:text-gray-100 uppercase tracking-wider">{t('dashboard.attendanceAnomalies')}</h2>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-4 font-medium">{t('dashboard.attendanceAnomaliesDescription')}</p>
                    {attendanceAnomalies.length === 0 ? (
                        <EmptyState icon={Icons.CheckCircle} title={t('dashboard.noAnomalies')} className="py-6" />
                    ) : (
                        <div className="space-y-2">
                            {attendanceAnomalies.slice(0, 10).map((a, idx) => (
                                <div key={idx} className="flex items-center gap-3 p-2.5 rounded-xl bg-amber-50/60 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/30">
                                    <span className="text-lg shrink-0" aria-hidden="true">⚠️</span>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{getUserName(a.employee_id)}</p>
                                        <p className="text-[10px] text-gray-500 dark:text-gray-400">
                                            {t('dashboard.anomalyLine', { date: a.date, time: a.clock_in.slice(0, 5) })}
                                        </p>
                                    </div>
                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 shrink-0">
                                        {t('dashboard.anomalyScore', { score: Math.abs(a.zScore).toFixed(1) })}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* --- ENGAGEMENT SIGNAL: composite, fully-explainable score
                (not a black-box prediction) surfacing who might benefit from
                a supportive check-in -- see domain/employeeEngagementScore.js
                for why this is deliberately NOT framed as "flight risk". --- */}
            {widgets.engagementSignal && userProfile.role === 'supervisor' && (
                <div style={{ order: orderOf('engagementSignal') }} className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700/60">
                    <h2 className="text-sm font-bold text-gray-700 mb-1 dark:text-gray-100 uppercase tracking-wider">{t('dashboard.engagementSignal')}</h2>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-4 font-medium">{t('dashboard.engagementSignalDescription')}</p>
                    {engagementScores.filter((s) => s.compositeScore !== null).length === 0 ? (
                        <EmptyState icon={Icons.ScatterChart} title={t('dashboard.noEngagementData')} className="py-6" />
                    ) : (
                        <div className="space-y-2">
                            {engagementScores.filter((s) => s.compositeScore !== null).slice(0, 8).map((s) => {
                                const categoryStyle = {
                                    urgent: 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300',
                                    attention: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300',
                                    steady: 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300',
                                    thriving: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300',
                                }[s.category];
                                return (
                                    <div key={s.employeeId} className="flex items-center gap-3 p-2.5 rounded-xl bg-gray-50/60 dark:bg-gray-900/30">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{getUserName(s.employeeId)}</p>
                                            <p className="text-[10px] text-gray-500 dark:text-gray-400">
                                                {t('dashboard.engagementBreakdown', {
                                                    punctuality: s.breakdown.punctuality ?? '—',
                                                    tasks: s.breakdown.taskCompletionRate ?? '—',
                                                    anomalies: s.breakdown.anomalyCount,
                                                })}
                                            </p>
                                        </div>
                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-lg shrink-0 ${categoryStyle}`}>
                                            {t(`dashboard.engagementCategory_${s.category}`)} &middot; {s.compositeScore}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
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
                                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} opacity={isDarkMode ? 0.6 : 0.4} />
                                    <XAxis dataKey="name" stroke={chartTheme.axis} fontStyle="bold" />
                                    <YAxis stroke={chartTheme.axis} />
                                    <Tooltip contentStyle={{ backgroundColor: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, color: chartTheme.tooltipText, borderRadius:'12px', fontSize:'11px', fontWeight:'bold' }} />
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
                                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} opacity={isDarkMode ? 0.6 : 0.4} />
                                    <XAxis dataKey="name" stroke={chartTheme.axis} fontStyle="bold" />
                                    <YAxis stroke={chartTheme.axis} />
                                    <Tooltip contentStyle={{ backgroundColor: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, color: chartTheme.tooltipText, borderRadius:'12px', fontSize:'11px', fontWeight:'bold' }} cursor={{fill: 'rgba(255,255,255,0.05)'}}/>
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
                                        <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} opacity={isDarkMode ? 0.6 : 0.4} />
                                        <XAxis dataKey="date" stroke={chartTheme.axis} fontStyle="bold" />
                                        <YAxis stroke={chartTheme.axis} domain={[0, 100]} />
                                        <Tooltip contentStyle={{ backgroundColor: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, color: chartTheme.tooltipText, borderRadius:'12px', fontSize:'11px', fontWeight:'bold' }} />
                                        <Line type="monotone" dataKey="score" name={t('dashboard.scoreLabel')} stroke="#3b82f6" strokeWidth={3} dot={{r:4}} activeDot={{r:6}} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        ) : (
                            <EmptyState icon={Icons.ScatterChart} title={t('dashboard.noTrendData')} className="py-8" />
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
                                // Defensive fallback to '' — safe today since the translation
                                // helper always returns a string, but that's an assumption this
                                // line shouldn't silently depend on to avoid crashing.
                                const textToDisplay = review.comments || review.review_text || t('dashboard.noObservations') || '';
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
            </>
            )}
        </div>
    );
};

export default DashboardView;