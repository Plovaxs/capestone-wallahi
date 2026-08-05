import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { supabase } from '../supabaseClient';
import ExportButton from '../components/ExportButton';
import SortableTh from '../components/SortableTh';
import { LeaveQuotaPolicy } from '../domain/LeaveQuotaPolicy';
import { offlineMutationQueue } from '../offline/OfflineMutationQueue';
import { showUserError } from '../utils/errorHandling';
import { confirmDialog } from '../utils/confirm';
import { sanitizeUserInput } from '../utils/sanitize';
import { useVirtualizedRows } from '../hooks/useVirtualizedRows';

/**
 * COMPONENT: LeaveView
 * PURPOSE: Automated Time-Off & Allowance Tracking Portal.
 * FEATURES:
 * 1. Employee Leave Requests & Shared Team Shift Calendars.
 * 2. Supervisor Allocation Controls (Directly adds/subtracts quota pools).
 * 3. Transactional Deductions: Dynamic date validation deducting days on approval.
 */
const LeaveView = ({ userProfile, allUsers = [], leaveRequests = [], fetchLeaveRequests, fetchProfile }) => {
    const { t } = useTranslation();

    // --- FORM DATA CONTROLLER STATES ---
    const [newRequest, setNewRequest] = useState({ type: 'Paid Holiday', start_date: '', end_date: '', reason: '' });
    const [loading, setLoading] = useState(false);

    // --- INTERN SEARCH & FILTER CONTROLS STATE ---
    const [searchTerm, setSearchTerm] = useState('');
    const [filterStatus, setFilterStatus] = useState('all');
    const [filterType, setFilterType] = useState('all');

    // --- SUPERVISOR BALANCES ADJUSTMENT CONTROL STATE ---
    const [selectedTargetUser, setSelectedTargetUser] = useState('');
    const [adjustVacationAmount, setAdjustVacationAmount] = useState(1);
    const [adjustSickAmount, setAdjustSickAmount] = useState(1);
    const [isAdjusting, setIsAdjusting] = useState(false);

    // --- BULK APPROVAL SELECTION (supervisor only, Pending requests) ---
    const [selectedLeaveIds, setSelectedLeaveIds] = useState(new Set());
    const [isBulkProcessingLeave, setIsBulkProcessingLeave] = useState(false);
    // 🟩 DOUBLE-SUBMIT GUARD: handleApproval used to have no in-flight
    // tracking at all — a supervisor double-clicking "Approve" (or clicking
    // again before the confirm dialog's promise settled) could fire two
    // concurrent approvals for the same request, each reading the same
    // pre-deduction quota balance and writing back independently, silently
    // deducting the leave days TWICE for one approved request.
    const [processingRequestIds, setProcessingRequestIds] = useState(new Set());

    // --- SORTABLE TABLE COLUMNS (request log) ---
    const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });
    const toggleSort = (key) => {
        setSortConfig(prev => (
            prev.key === key
                ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
                : { key, direction: 'asc' }
        ));
    };

    // 🟩 NEW: Lets users browse the leave calendar to other months instead of
    // being locked to whatever month it currently is.
    const [calendarDate, setCalendarDate] = useState(() => {
        const now = new Date();
        return { year: now.getFullYear(), month: now.getMonth() };
    });

    // Filters active employee rows for supervisor form drop-downs
    const employeeUsers = (allUsers || []).filter(u => u.role === 'employee');

    // 🟩 FIX: The "My Remaining Allowance" card reads userProfile.vacation_days /
    // sick_days directly, but userProfile was only ever refreshed at login.
    // If a supervisor approved this leave elsewhere, the balance in this
    // session went stale even though the DB was correct. Refresh on mount.
    useEffect(() => {
        if (fetchProfile) fetchProfile();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * HELPER UTILITY: statusColor
     * PURPOSE: Resolves glassmorphic color mapping profiles for approval tags.
     */
    const statusColor = (status) => ({
        'Pending': 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-300 dark:border-yellow-900/50',
        'Approved': 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-900/50',
        'Denied': 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900/50',
    }[status] || 'bg-gray-100 dark:bg-gray-700');

    // 🟩 PERFORMANCE: getUserName/getUserCampus were O(n) allUsers.find()
    // calls, and sortedLeaveRequests' comparator called getUserName twice
    // per comparison — an O(n log n × m) pattern. A Map built once per
    // allUsers change turns every lookup into O(1).
    const usersById = useMemo(() => {
        const map = new Map();
        for (const u of (allUsers || [])) map.set(u.id, u);
        return map;
    }, [allUsers]);

    const getUserName = (id) => usersById.get(id)?.name || t('leave.unknownOfficer');

    // 🟩 Drives both the "days remaining" readout on the allowance card and
    // the submission-time cap check — kept in sync by deriving both from
    // the same leaveRequests prop instead of duplicating the calculation.
    const unpaidLeaveUsedDays = useMemo(
        () => LeaveQuotaPolicy.calculateUnpaidLeaveUsedDays(leaveRequests, userProfile?.id),
        [leaveRequests, userProfile?.id]
    );

    const getUserCampus = (id) => {
        const u = usersById.get(id);
        return u?.source || u?.university || t('leave.presidentUniversity');
    };

    // =========================================================================
    // 🔍 REAL-TIME DATA INDEX FILTER PIPELINES
    // =========================================================================
    const filteredLeaveRequests = useMemo(() => leaveRequests.filter(req => {
        const empName = getUserName(req.employee_id).toLowerCase();
        const matchesSearch = empName.includes(searchTerm.toLowerCase()) ||
                              (req.reason || '').toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = filterStatus === 'all' || req.status === filterStatus;
        const matchesType = filterType === 'all' || req.type === filterType;

        return matchesSearch && matchesStatus && matchesType;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getUserName is a plain function recreated every render, fully determined by usersById/t which are already listed
    }), [leaveRequests, searchTerm, filterStatus, filterType, usersById, t]);

    const sortedLeaveRequests = useMemo(() => [...filteredLeaveRequests].sort((a, b) => {
        if (!sortConfig.key) return 0;
        let aVal, bVal;
        switch (sortConfig.key) {
            case 'name': aVal = getUserName(a.employee_id); bVal = getUserName(b.employee_id); break;
            case 'type': aVal = a.type; bVal = b.type; break;
            case 'start_date': aVal = a.start_date; bVal = b.start_date; break;
            case 'status': aVal = a.status; bVal = b.status; break;
            default: return 0;
        }
        const cmp = String(aVal).localeCompare(String(bVal));
        return sortConfig.direction === 'asc' ? cmp : -cmp;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [filteredLeaveRequests, sortConfig, usersById, t]);

    // 🟩 VIRTUALIZATION: leave requests only ever accumulate — past a
    // threshold, render just the rows in view instead of the whole log.
    const LEAVE_VIRTUALIZE_THRESHOLD = 30;
    const LEAVE_ROW_HEIGHT = 61;
    const leaveVirtual = useVirtualizedRows(sortedLeaveRequests.length, LEAVE_ROW_HEIGHT, { containerHeight: 480 });
    const shouldVirtualizeLeave = sortedLeaveRequests.length > LEAVE_VIRTUALIZE_THRESHOLD;
    const visibleLeaveRequests = shouldVirtualizeLeave
        ? sortedLeaveRequests.slice(leaveVirtual.startIndex, leaveVirtual.endIndex)
        : sortedLeaveRequests;
    const leaveTableColSpan = userProfile.role === 'supervisor' ? 7 : 5;

    // Reformats filtered leave objects before passing data into Excel exports
    const [exportEmployeeId, setExportEmployeeId] = useState('all'); // 🟩 NEW: single-employee export filter
    const leaveExportPayload = filteredLeaveRequests
        .filter(req => exportEmployeeId === 'all' || req.employee_id === exportEmployeeId)
        .map(req => ({
        Date: req.created_at ? new Date(req.created_at).toLocaleDateString('en-GB') : 'N/A',
        "Outsourcing Staff": getUserName(req.employee_id),
        Origin: getUserCampus(req.employee_id),
        Category: req.type,
        Duration: `${req.start_date} to ${req.end_date}`,
        Reason: req.reason || 'Not Specified',
        Status: req.status
    }));

    // =========================================================================
    // ⚙️ SYSTEM BACK-END ENGINE MUTATION PIPELINES (SUPABASE CONTROLLERS)
    // =========================================================================

    /**
     * TRANSACTION: handleSubmitRequest (Intern Time-Off Submission)
     * PURPOSE: Dispatches a pending time-off request string directly to Supabase tables.
     */
    const handleSubmitRequest = async (e) => {
        e.preventDefault();
        if (!newRequest.start_date || !newRequest.end_date) {
            toast.error(t('leave.fillDates'));
            return;
        }

        const requestedDays = LeaveQuotaPolicy.calculateRequestedDays(newRequest.start_date, newRequest.end_date);

        if (requestedDays <= 0) {
            toast.error(t('leave.endDateError'));
            return;
        }

        // 🟩 QUOTA GUARD: Paid Holiday and Sick Leave draw from the intern's
        // profile balance. Block the submission client-side if it would
        // exceed what they currently have — supervisors can still override
        // shortfalls later at approval time if there's a genuine emergency.
        if (LeaveQuotaPolicy.isQuotaType(newRequest.type)) {
            const leaveType = LeaveQuotaPolicy.quotaFieldFor(newRequest.type);
            const available = userProfile[leaveType] || 0;
            const label = leaveType === 'sick_days' ? t('leave.sick') : t('leave.vacation');

            if (requestedDays > available) {
                toast.error(t('leave.quotaExceeded', { requested: requestedDays, available, label }));
                return;
            }
        } else if (newRequest.type === 'Unpaid Leave') {
            // 🟩 BUG FIX: Unpaid Leave never drew from a stored balance, so
            // it previously had no limit enforcement at all — an intern
            // could submit any number of unpaid-leave requests of any
            // length. Caps it against an annual total instead, computed
            // from their own existing requests (no new database column).
            const alreadyUsed = LeaveQuotaPolicy.calculateUnpaidLeaveUsedDays(leaveRequests, userProfile.id);
            const remaining = LeaveQuotaPolicy.UNPAID_LEAVE_ANNUAL_CAP_DAYS - alreadyUsed;
            if (requestedDays > remaining) {
                toast.error(t('leave.unpaidLeaveCapExceeded', {
                    requested: requestedDays,
                    remaining: Math.max(0, remaining),
                    cap: LeaveQuotaPolicy.UNPAID_LEAVE_ANNUAL_CAP_DAYS,
                }));
                return;
            }
        }

        const payload = {
            ...newRequest,
            reason: sanitizeUserInput(newRequest.reason, { maxLength: 500 }),
            employee_id: userProfile.id,
            status: 'Pending'
        };

        // 🟩 OFFLINE QUEUE: if there's no connectivity, queue the submission
        // (IndexedDB-backed) instead of failing outright — it's replayed
        // automatically once the browser comes back online (see
        // OfflineMutationQueue / the 'online' event listener + Background
        // Sync API registration it attempts where supported).
        if (!navigator.onLine) {
            await offlineMutationQueue.enqueue('submitLeaveRequest', payload);
            setNewRequest({ type: 'Paid Holiday', start_date: '', end_date: '', reason: '' });
            toast(t('offline.queuedForSync'), { icon: '📴' });
            return;
        }

        setLoading(true);
        const { error } = await supabase.from('leave_requests').insert(payload);

        if (error) {
            showUserError('errors.submitLeaveRequest', error);
        } else {
            // Notifying supervisors is now handled server-side by the
            // notify_leave_submitted trigger — the client can no longer
            // insert into notifications directly (RLS).
            setNewRequest({ type: 'Paid Holiday', start_date: '', end_date: '', reason: '' });
            fetchLeaveRequests();
            toast.success(t('leave.requestFiled'));
        }
        setLoading(false);
    };

    /**
     * TRANSACTION: handleAdjustBalances (Supervisor Quota Injection tool)
     * PURPOSE: Lets supervisors dynamically adjust individual intern day allowances.
     * CALCULATIONS: Employs Math.max protection locks to ensure day allotments never dip below 0.
     */
    const handleAdjustBalances = async (e) => {
        e.preventDefault();
        // 🟩 Defense-in-depth: the form itself is only rendered for
        // supervisors, but the handler had no guard of its own — mirrors
        // the same fix applied to the other supervisor-only actions.
        if (userProfile.role !== 'supervisor') return;
        if (!selectedTargetUser) return toast.error(t('leave.selectStaffFirst'));

        setIsAdjusting(true);
        try {
            const targetProfile = allUsers.find(u => u.id === selectedTargetUser);

            if (targetProfile) {
                const currentVacation = targetProfile.vacation_days || 0;
                const currentSick = targetProfile.sick_days || 0;

                // 🟩 NaN GUARD: parseInt('') is NaN, and NaN + N is NaN — an
                // emptied input field previously silently corrupted the
                // balance to NaN in the database. `|| 0` treats a
                // non-numeric/empty adjustment as "no change" instead.
                const vacationDelta = parseInt(adjustVacationAmount, 10) || 0;
                const sickDelta = parseInt(adjustSickAmount, 10) || 0;
                const newVacation = Math.max(0, currentVacation + vacationDelta);
                const newSick = Math.max(0, currentSick + sickDelta);

                const { error } = await supabase
                    .from('profiles')
                    .update({
                        vacation_days: newVacation,
                        sick_days: newSick
                    })
                    .eq('id', selectedTargetUser);

                if (error) {
                    showUserError('errors.updateLeaveAllocation', error);
                } else {
                    toast.success(t('leave.allocationSuccess', { name: targetProfile.name }));
                    window.location.reload(); // Performs a clean context sync to flush visual tracking states
                }
            }
        } finally {
            setIsAdjusting(false);
        }
    };

    /**
     * REFACTOR TRANSACTIONEngine: handleApproval (Supervisor Evaluation Gateway)
     * PURPOSE: Updates request rows to 'Approved' or 'Denied'.
     * CRITICAL LOGIC DETAILED:
     * If status resolves to 'Approved' AND leave type matches an extractable pool, the system:
     * 1. Runs a mathematical date delta calculation to count the total time off days requested.
     * 2. Pulls the target profile's current day counts from the database.
     * 3. Deducts the requested days using strict constraints to protect against allocation overflows.
     */
    const handleApproval = async (id, status, request) => {
        if (processingRequestIds.has(id)) return;
        setProcessingRequestIds((prev) => new Set(prev).add(id));
        try {
            await handleApprovalInner(id, status, request);
        } finally {
            setProcessingRequestIds((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    const handleApprovalInner = async (id, status, request) => {
        const isQuotaType = LeaveQuotaPolicy.isQuotaType(request.type);
        let daysDiff = 0;
        let leaveType = null;
        let currentDays = null;

        // 🟩 QUOTA GUARD: for quota-drawing types, check the balance BEFORE
        // committing the status change. If the request overruns the
        // intern's remaining days, the supervisor gets an explicit warning
        // and has to knowingly confirm the override — the system no longer
        // silently approves-and-clamps-to-zero.
        if (status === 'Approved' && isQuotaType) {
            daysDiff = LeaveQuotaPolicy.calculateRequestedDays(request.start_date, request.end_date);
            leaveType = LeaveQuotaPolicy.quotaFieldFor(request.type);

            const { data: targetProfile, error: fetchError } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', request.employee_id)
                .single();

            if (targetProfile && !fetchError) {
                currentDays = targetProfile[leaveType] || 0;
            }

            const overageDays = currentDays !== null ? LeaveQuotaPolicy.calculateOverage(currentDays, daysDiff) : 0;
            const label = leaveType === 'sick_days' ? t('leave.sick') : t('leave.vacation');

            if (overageDays > 0) {
                const overrideConfirmed = await confirmDialog(
                    t('leave.overrideConfirm', { name: getUserName(request.employee_id), current: currentDays, label, requested: daysDiff, overage: overageDays }),
                    { variant: 'danger' }
                );
                if (!overrideConfirmed) return;
            } else {
                if (!(await confirmDialog(t('leave.confirmApprove')))) return;
            }
        } else {
            if (!(await confirmDialog(t('leave.confirmStatusChange', { status })))) return;
        }

        const { error: updateError } = await supabase.from('leave_requests')
            .update({ status: status })
            .eq('id', id);

        if (updateError) {
            showUserError('errors.updateLeaveRequest', updateError);
            return;
        }

        // Runs dynamic allowance deduction if the supervisor grants approval
        if (status === 'Approved' && isQuotaType && leaveType && currentDays !== null) {
            const newDays = LeaveQuotaPolicy.deduct(currentDays, daysDiff);

            const { error: profileError } = await supabase.from('profiles')
                .update({ [leaveType]: newDays })
                .eq('id', request.employee_id);

            if (profileError) console.error('Error deducting days:', profileError);
        }
        
        // Notifying the requester is now handled server-side by the
        // notify_leave_status_change trigger — the client can no longer
        // insert into notifications directly (RLS).

        await fetchLeaveRequests();
        if (request.employee_id === userProfile.id) {
            fetchProfile(); // Refreshes local profile states if the supervisor requested their own time off
        }
    };

    const toggleLeaveSelection = (id) => {
        setSelectedLeaveIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    /**
     * TRANSACTION: handleBulkApproveLeave
     * PURPOSE: Approves every selected Pending request in one pass. Quota
     * overages are auto-overridden (the supervisor already confirmed intent
     * once for the whole batch) rather than prompting per-row like the
     * single-approval flow does; any overages are summarized afterward.
     */
    const handleBulkApproveLeave = async () => {
        const selectedRequests = leaveRequests.filter(r => selectedLeaveIds.has(r.id) && r.status === 'Pending');
        if (selectedRequests.length === 0) return;
        if (!(await confirmDialog(t('leave.confirmBulkApprove', { count: selectedRequests.length })))) return;

        setIsBulkProcessingLeave(true);
        const overages = [];

        // 🟩 PERFORMANCE: this used to process every selected request one at
        // a time — up to 3 sequential network round trips per row, so
        // approving 20 requests meant ~40-60 round trips waiting on each
        // other in sequence. The read step (fetching each employee's
        // current balance) is independent per request and now runs in
        // parallel.
        const quotaFetches = await Promise.all(selectedRequests.map(async (request) => {
            const isQuotaType = LeaveQuotaPolicy.isQuotaType(request.type);
            if (!isQuotaType) return { request, isQuotaType };
            const leaveType = LeaveQuotaPolicy.quotaFieldFor(request.type);
            const daysDiff = LeaveQuotaPolicy.calculateRequestedDays(request.start_date, request.end_date);
            const { data: targetProfile } = await supabase.from('profiles').select('*').eq('id', request.employee_id).single();
            const currentDays = targetProfile ? (targetProfile[leaveType] || 0) : 0;
            return { request, isQuotaType, leaveType, daysDiff, currentDays };
        }));

        // 🟩 Requests for the SAME employee + same quota field must still be
        // applied in order: two "Sick Leave" requests approved in one batch
        // both reading the same starting balance before either writes back
        // would silently deduct only once instead of twice (the exact race
        // just fixed in the single-row handleApproval above). Requests for
        // different employees/fields don't share any state, so those groups
        // run fully in parallel — the common case for a bulk approval.
        const groups = new Map();
        for (const item of quotaFetches) {
            const key = item.isQuotaType ? `${item.request.employee_id}|${item.leaveType}` : `solo|${item.request.id}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        }

        await Promise.all(Array.from(groups.values()).map(async (group) => {
            let runningBalance = group[0].isQuotaType ? group[0].currentDays : null;

            for (const { request, isQuotaType, leaveType, daysDiff } of group) {
                if (isQuotaType && daysDiff > runningBalance) {
                    overages.push(t('leave.overrideConfirm', {
                        name: getUserName(request.employee_id),
                        current: runningBalance,
                        label: leaveType === 'sick_days' ? t('leave.sick') : t('leave.vacation'),
                        requested: daysDiff,
                        overage: LeaveQuotaPolicy.calculateOverage(runningBalance, daysDiff),
                    }));
                }

                const { error: updateError } = await supabase.from('leave_requests').update({ status: 'Approved' }).eq('id', request.id);
                if (updateError) {
                    showUserError('errors.updateLeaveRequest', updateError);
                    continue;
                }

                if (isQuotaType) {
                    const newDays = LeaveQuotaPolicy.deduct(runningBalance, daysDiff);
                    await supabase.from('profiles').update({ [leaveType]: newDays }).eq('id', request.employee_id);
                    runningBalance = newDays;
                }
            }
        }));

        setSelectedLeaveIds(new Set());
        setIsBulkProcessingLeave(false);
        await fetchLeaveRequests();
        if (selectedRequests.some(r => r.employee_id === userProfile.id)) fetchProfile();

        if (overages.length > 0) {
            toast.error(
                t('leave.bulkOverageSummary', { count: overages.length }) + '\n\n' + overages.join('\n'),
                { style: { whiteSpace: 'pre-line' }, duration: 8000 }
            );
        }
    };

    /**
     * GRID RENDERER: renderCalendar
     * PURPOSE: Dynamically draws shared workspace calendar cells for the active month.
     * LOGIC: Checks loop iterations against valid start/end intervals to map intern indicators safely.
     */
    const goToPrevMonth = () => {
        setCalendarDate(prev => {
            const newMonth = prev.month === 0 ? 11 : prev.month - 1;
            const newYear = prev.month === 0 ? prev.year - 1 : prev.year;
            return { year: newYear, month: newMonth };
        });
    };

    const goToNextMonth = () => {
        setCalendarDate(prev => {
            const newMonth = prev.month === 11 ? 0 : prev.month + 1;
            const newYear = prev.month === 11 ? prev.year + 1 : prev.year;
            return { year: newYear, month: newMonth };
        });
    };

    const goToCurrentMonth = () => {
        const now = new Date();
        setCalendarDate({ year: now.getFullYear(), month: now.getMonth() });
    };

    // 🟩 PERFORMANCE: was a plain function re-invoked (and re-filtering the
    // whole leaveRequests array once per day of the month) on every render,
    // including unrelated ones like typing in the search box. Only the
    // visible month's approved leaves are in scope here, which stays small
    // regardless of how much leave history accumulates over time, but
    // there's no reason to recompute it on every keystroke either.
    const calendarDays = useMemo(() => {
        const { year, month } = calendarDate;

        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const firstDayOfMonth = new Date(year, month, 1).getDay();

        const days = [];
        // Draws empty spacer slots to realign month columns based on weekday starts
        for (let i = 0; i < firstDayOfMonth; i++) {
            days.push(<div key={`empty-${i}`} className="h-24 bg-gray-50/50 dark:bg-gray-800/30 border border-gray-100 dark:border-gray-700/60"></div>);
        }

        // Populates valid date grid indices
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dayLeaves = leaveRequests.filter(req =>
                req.status === 'Approved' &&
                req.start_date <= dateStr &&
                req.end_date >= dateStr
            );

            days.push(
                <div key={d} className="h-24 border border-gray-100 bg-white p-1 overflow-y-auto dark:bg-gray-800 dark:border-gray-700 relative hover:bg-gray-50/20 transition-all">
                    <span className="text-xs font-bold text-gray-400 dark:text-gray-500 absolute top-1 left-2">{d}</span>
                    <div className="mt-5 space-y-1">
                        {dayLeaves.map(leave => (
                            <div key={leave.id} className="text-[10px] font-bold bg-blue-50 text-blue-700 rounded-md px-1.5 py-0.5 truncate border border-blue-100/50 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900/40" title={`${getUserName(leave.employee_id)}: ${leave.type}`}>
                                🌴 {getUserName(leave.employee_id).split(' ')[0]}
                            </div>
                        ))}
                    </div>
                </div>
            );
        }

        return days;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getUserName is a plain function fully determined by usersById/t, already listed
    }, [calendarDate, leaveRequests, usersById, t]);

    return (
        <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6">
            
            {/* --- LAYOUT HEADER CONTROLS --- */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-gray-200 dark:border-gray-700 pb-4 gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">{t('leave.title')}</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{t('leave.subtitle')}</p>
                </div>
                {userProfile.role === 'supervisor' && (
                    <div className="flex items-center gap-2">
                        <select
                            value={exportEmployeeId}
                            onChange={(e) => setExportEmployeeId(e.target.value)}
                            className="text-xs font-bold bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-xl px-2 py-2 focus:outline-none focus:border-blue-500"
                        >
                            <option value="all">{t('leave.allEmployees')}</option>
                            {employeeUsers.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                        </select>
                        <ExportButton data={leaveExportPayload} filename={exportEmployeeId === 'all' ? "Handpicked_Leave_Report" : `Leave_${employeeUsers.find(e => e.id === exportEmployeeId)?.name || 'Employee'}`} label={t('leave.exportLeaveLogs')} />
                    </div>
                )}
            </div>

            {/* --- SECTION 1: ALLOWANCE CARDS & SUBMISSION FIELDS --- */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                
                {/* Visual Metric Allocation Card */}
                <div className="bg-gradient-to-br from-blue-600 to-indigo-800 p-6 rounded-2xl shadow-md text-white flex flex-col justify-between">
                    <div>
                        <h3 className="font-bold text-xs text-blue-100 uppercase tracking-wider mb-4">{t('leave.myRemainingAllowance')}</h3>
                        <div className="text-4xl font-black mb-1">{userProfile?.vacation_days || 0} <span className="text-xs font-bold text-blue-200 uppercase tracking-wide block sm:inline">{t('leave.vacationDays')}</span></div>
                        <div className="text-2xl font-bold">{userProfile?.sick_days || 0} <span className="text-xs font-bold text-blue-200 uppercase tracking-wide block sm:inline">{t('leave.sickDays')}</span></div>
                        {/* 🟩 Surfaces the same annual cap now enforced on submission (see
                            LeaveQuotaPolicy.calculateUnpaidLeaveUsedDays) — previously unpaid
                            leave had no visible limit at all, paid or otherwise. */}
                        <div className="text-lg font-bold text-blue-200 mt-1">
                            {Math.max(0, LeaveQuotaPolicy.UNPAID_LEAVE_ANNUAL_CAP_DAYS - unpaidLeaveUsedDays)} <span className="text-xs font-bold text-blue-300 uppercase tracking-wide block sm:inline">{t('leave.unpaidDaysRemaining', { cap: LeaveQuotaPolicy.UNPAID_LEAVE_ANNUAL_CAP_DAYS })}</span>
                        </div>
                    </div>
                    <p className="text-[11px] text-blue-200/70 mt-6 italic">{t('leave.autoDeductionNote')}</p>
                </div>

                {/* Inline Action Forms Wrapper */}
                <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                    {userProfile.role === 'supervisor' ? (
                        /* ================= SUPERVISOR ALLOCATION CONSOLE ================= */
                        <>
                            <h2 className="text-lg font-bold mb-1 text-gray-800 dark:text-gray-100">{t('leave.supervisorConsoleTitle')}</h2>
                            <p className="text-xs text-gray-400 mb-4">{t('leave.supervisorConsoleDescription')}</p>
                            <form onSubmit={handleAdjustBalances} className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end text-xs font-semibold text-gray-500 dark:text-gray-400">
                                <div className="sm:col-span-3 space-y-1">
                                    <label htmlFor="leave-target-staff" className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">{t('leave.targetStaffMember')}</label>
                                    <select
                                        id="leave-target-staff"
                                        value={selectedTargetUser}
                                        onChange={e => setSelectedTargetUser(e.target.value)}
                                        className="w-full p-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-bold text-xs"
                                        required
                                    >
                                        <option value="">{t('leave.selectStaffMember')}</option>
                                        {employeeUsers.map(emp => (
                                            <option key={emp.id} value={emp.id}>
                                                {emp.name} ({t('leave.vacShort')}: {emp.vacation_days || 0} | {t('leave.sickShort')}: {emp.sick_days || 0})
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div className="space-y-1">
                                    <label htmlFor="leave-adjust-vacation" className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">{t('leave.vacationAdjust')}</label>
                                    <input
                                        id="leave-adjust-vacation"
                                        type="number"
                                        value={adjustVacationAmount}
                                        onChange={e => setAdjustVacationAmount(e.target.value)}
                                        className="w-full p-2 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-medium"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label htmlFor="leave-adjust-sick" className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">{t('leave.sickAdjust')}</label>
                                    <input
                                        id="leave-adjust-sick"
                                        type="number"
                                        value={adjustSickAmount}
                                        onChange={e => setAdjustSickAmount(e.target.value)}
                                        className="w-full p-2 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-medium"
                                    />
                                </div>
                                <button
                                    type="submit"
                                    disabled={isAdjusting}
                                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-xl shadow transition-all disabled:opacity-50 text-xs shadow-blue-500/10"
                                >
                                    {isAdjusting ? t('leave.processing') : t('leave.applyAllocations')}
                                </button>
                            </form>
                        </>
                    ) : (
                        /* ================= EMPLOYEE REGISTRATION FORM ================= */
                        <>
                            <h2 className="text-lg font-bold mb-4 text-gray-800 dark:text-gray-100">{t('leave.submitAbsenceForm')}</h2>
                            <form onSubmit={handleSubmitRequest} className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-semibold text-gray-500 dark:text-gray-400">
                                <div className="space-y-1">
                                    <label htmlFor="leave-type" className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">{t('leave.absenceFormType')}</label>
                                    <select
                                        id="leave-type"
                                        value={newRequest.type}
                                        onChange={e => setNewRequest({...newRequest, type: e.target.value})}
                                        className="w-full p-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-bold text-xs"
                                    >
                                        <option value="Paid Holiday">{t('leave.paidHoliday')}</option>
                                        <option value="Sick Leave">{t('leave.sickLeave')}</option>
                                        <option value="Unpaid Leave">{t('leave.unpaidLeave')}</option>
                                    </select>
                                </div>
                                <div className="space-y-1">
                                    <label htmlFor="leave-reason" className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">{t('leave.contextualReason')}</label>
                                    <input
                                        id="leave-reason"
                                        type="text"
                                        value={newRequest.reason}
                                        onChange={e => setNewRequest({...newRequest, reason: e.target.value})}
                                        placeholder={t('leave.reasonPlaceholder')}
                                        className="w-full p-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-medium"
                                        required
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label htmlFor="leave-start-date" className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">{t('leave.startDate')}</label>
                                    <input
                                        id="leave-start-date"
                                        type="date"
                                        value={newRequest.start_date}
                                        onChange={e => setNewRequest({...newRequest, start_date: e.target.value})}
                                        className="w-full p-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-medium"
                                        required
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label htmlFor="leave-end-date" className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">{t('leave.endDate')}</label>
                                    <input
                                        id="leave-end-date"
                                        type="date"
                                        value={newRequest.end_date}
                                        onChange={e => setNewRequest({...newRequest, end_date: e.target.value})}
                                        className="w-full p-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-medium"
                                        required
                                    />
                                </div>
                                <div className="sm:col-span-2 flex justify-end mt-2">
                                    <button disabled={loading} type="submit" className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-6 rounded-xl shadow transition-all disabled:opacity-50 text-xs shadow-blue-500/10">
                                        {loading ? t('leave.transmitting') : t('leave.fileRequest')}
                                    </button>
                                </div>
                            </form>
                        </>
                    )}
                </div>
            </div>

            {/* --- SECTION 2: GRID SCHEDULE CALENDAR OVERVIEW --- */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
                    <h2 className="text-sm font-bold text-gray-800 dark:text-gray-100 uppercase tracking-wider text-gray-400">
                        {t('leave.calendarOverview', { monthYear: new Date(calendarDate.year, calendarDate.month, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }) })}
                    </h2>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={goToPrevMonth} className="p-2 text-xs font-bold rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition">{t('leave.prev')}</button>
                        <button type="button" onClick={goToCurrentMonth} className="px-3 py-2 text-xs font-bold rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition">{t('leave.today')}</button>
                        <button type="button" onClick={goToNextMonth} className="p-2 text-xs font-bold rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition">{t('leave.next')}</button>
                    </div>
                </div>
                <div className="grid grid-cols-7 gap-0 border border-gray-200 dark:border-gray-700 rounded-2xl overflow-hidden shadow-sm">
                    {[t('leave.sun'), t('leave.mon'), t('leave.tue'), t('leave.wed'), t('leave.thu'), t('leave.fri'), t('leave.sat')].map(d => (
                        <div key={d} className="bg-gray-50 p-2.5 text-center text-xs font-bold text-gray-400 border-b border-gray-200 dark:bg-gray-700/60 dark:text-gray-400 dark:border-gray-600">{d}</div>
                    ))}
                    {calendarDays}
                </div>
            </div>

            {/* --- SECTION 3: REVISION FILTERS ROW HUB --- */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700">
                    <div>
                        <label htmlFor="leave-search" className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                            {userProfile.role === 'supervisor' ? t('leave.searchStaffKeyword') : t('leave.searchReasonKeyword')}
                        </label>
                        <input
                            id="leave-search"
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder={t('leave.searchPlaceholder')}
                            className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-900 dark:text-white"
                        />
                    </div>
                    <div>
                        <label htmlFor="leave-filter-type" className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('leave.filterCategories')}</label>
                        <select
                            id="leave-filter-type"
                            value={filterType}
                            onChange={(e) => setFilterType(e.target.value)}
                            className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-900 dark:text-white"
                        >
                            <option value="all">{t('leave.allLeaveTypes')}</option>
                            <option value="Paid Holiday">{t('leave.paidHoliday')}</option>
                            <option value="Sick Leave">{t('leave.sickLeave')}</option>
                            <option value="Unpaid Leave">{t('leave.unpaidLeave')}</option>
                        </select>
                    </div>
                    <div>
                        <label htmlFor="leave-filter-status" className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('leave.filterApprovalStatus')}</label>
                        <select
                            id="leave-filter-status"
                            value={filterStatus}
                            onChange={(e) => setFilterStatus(e.target.value)}
                            className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-900 dark:text-white"
                        >
                            <option value="all">{t('leave.allRequestStatuses')}</option>
                            <option value="Pending">{t('leave.pending')}</option>
                            <option value="Approved">{t('leave.approved')}</option>
                            <option value="Denied">{t('leave.denied')}</option>
                        </select>
                    </div>
            </div>

            {/* --- BULK APPROVAL ACTION BAR (supervisor, appears once requests are checked) --- */}
            {userProfile.role === 'supervisor' && selectedLeaveIds.size > 0 && (
                <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-2xl px-4 py-3">
                    <span className="text-xs font-bold text-blue-700 dark:text-blue-300">
                        {t('leave.selectedCount', { count: selectedLeaveIds.size })}
                    </span>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => setSelectedLeaveIds(new Set())}
                            className="text-xs font-bold text-gray-500 hover:text-gray-700 dark:text-gray-400 px-3 py-1.5"
                        >
                            {t('leave.clearSelection')}
                        </button>
                        <button
                            type="button"
                            onClick={handleBulkApproveLeave}
                            disabled={isBulkProcessingLeave}
                            className="text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-1.5 rounded-xl shadow-sm"
                        >
                            {isBulkProcessingLeave ? t('leave.processing') : t('leave.approveSelected')}
                        </button>
                    </div>
                </div>
            )}

            {/* --- SECTION 4: HISTORICAL DATA TABLE LISTS --- */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
                 <div className="p-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-700/30">
                     <h2 className="text-sm font-bold text-gray-800 dark:text-gray-100 uppercase tracking-wider text-gray-400">
                        {userProfile.role === 'supervisor' ? t('leave.rosterManagementQueue') : t('leave.personalRequestLog')}
                     </h2>
                 </div>
                 <div
                     className="overflow-x-auto"
                     style={shouldVirtualizeLeave ? { maxHeight: leaveVirtual.containerHeight, overflowY: 'auto' } : undefined}
                     onScroll={shouldVirtualizeLeave ? leaveVirtual.onScroll : undefined}
                 >
                     <table className="w-full text-left border-collapse">
                        <thead className="bg-gray-50/80 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                            <tr>
                                {userProfile.role === 'supervisor' && <th className="p-4 w-8"></th>}
                                <SortableTh label={t('leave.colStaffName')} sortKey="name" sortConfig={sortConfig} onSort={toggleSort} />
                                <SortableTh label={t('leave.colCategory')} sortKey="type" sortConfig={sortConfig} onSort={toggleSort} />
                                <SortableTh label={t('leave.colBoundaries')} sortKey="start_date" sortConfig={sortConfig} onSort={toggleSort} />
                                <th className="p-4">{t('leave.colReason')}</th>
                                <SortableTh label={t('leave.colStatus')} sortKey="status" sortConfig={sortConfig} onSort={toggleSort} />
                                {userProfile.role === 'supervisor' && <th className="p-4 text-right">{t('leave.colActions')}</th>}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700 text-xs">
                            {shouldVirtualizeLeave && leaveVirtual.topPadding > 0 && (
                                <tr aria-hidden="true"><td colSpan={leaveTableColSpan} style={{ height: leaveVirtual.topPadding, padding: 0 }} /></tr>
                            )}
                            {visibleLeaveRequests.map(req => (
                                <tr key={req.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-700/20 transition-all font-semibold">
                                    {userProfile.role === 'supervisor' && (
                                        <td className="p-4">
                                            {req.status === 'Pending' && (
                                                <input
                                                    type="checkbox"
                                                    checked={selectedLeaveIds.has(req.id)}
                                                    onChange={() => toggleLeaveSelection(req.id)}
                                                    aria-label={t('leave.selectForBulkApprove')}
                                                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-3.5 w-3.5"
                                                />
                                            )}
                                        </td>
                                    )}
                                    <td className="p-4 text-gray-900 dark:text-gray-100">
                                        <div className="flex flex-col gap-0.5">
                                            <span className="text-sm font-bold">{getUserName(req.employee_id)}</span>
                                            <span className="text-[10px] text-gray-400 font-bold uppercase font-mono">{getUserCampus(req.employee_id)}</span>
                                        </div>
                                    </td>
                                    <td className="p-4 text-gray-600 dark:text-gray-300 font-bold">{req.type}</td>
                                    <td className="p-4 text-gray-700 dark:text-gray-300 font-mono font-bold">
                                        🗓️ {req.start_date} <span className="text-gray-400 font-sans font-medium">{t('leave.to')}</span> {req.end_date}
                                    </td>
                                    <td className="p-4 text-gray-500 dark:text-gray-400 italic max-w-xs truncate">
                                        "{req.reason || t('leave.notSpecified')}"
                                    </td>
                                    <td className="p-4">
                                        <span className={`px-2.5 py-0.5 text-[11px] font-bold rounded-full border ${statusColor(req.status)}`}>
                                            {req.status}
                                        </span>
                                    </td>
                                    {userProfile.role === 'supervisor' && (
                                        <td className="p-4 text-right">
                                            {req.status === 'Pending' ? (
                                                <div className="inline-flex gap-2">
                                                    <button type="button" onClick={() => handleApproval(req.id, 'Approved', req)} disabled={processingRequestIds.has(req.id)} className="bg-green-600 hover:bg-green-700 text-white text-xs font-bold py-1.5 px-3 rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed">{t('leave.approve')}</button>
                                                    <button type="button" onClick={() => handleApproval(req.id, 'Denied', req)} disabled={processingRequestIds.has(req.id)} className="bg-red-500 hover:bg-red-600 text-white text-xs font-bold py-1.5 px-3 rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed">{t('leave.deny')}</button>
                                                </div>
                                            ) : (
                                                <span className="text-gray-400 text-xs italic font-medium pr-2">{t('leave.evaluated')}</span>
                                            )}
                                        </td>
                                    )}
                                </tr>
                            ))}
                            {shouldVirtualizeLeave && leaveVirtual.bottomPadding > 0 && (
                                <tr aria-hidden="true"><td colSpan={leaveTableColSpan} style={{ height: leaveVirtual.bottomPadding, padding: 0 }} /></tr>
                            )}
                        </tbody>
                     </table>
                 </div>
                 {filteredLeaveRequests.length === 0 && (
                    <p className="text-center text-gray-400 text-xs py-12 italic dark:text-gray-500">{t('leave.noRequestsMatch')}</p>
                 )}
            </div>
        </div>
    );
};

export default LeaveView;