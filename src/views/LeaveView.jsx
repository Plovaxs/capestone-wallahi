import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../supabaseClient';
import ExportButton from '../components/ExportButton';
import { showUserError } from '../utils/errorHandling';
import { sanitizeUserInput } from '../utils/sanitize';

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

    const getUserName = (id) => allUsers.find(u => u.id === id)?.name || t('leave.unknownOfficer');

    const getUserCampus = (id) => {
        const u = allUsers.find(user => user.id === id);
        return u?.source || u?.university || t('leave.presidentUniversity');
    };

    // =========================================================================
    // 🔍 REAL-TIME DATA INDEX FILTER PIPELINES
    // =========================================================================
    const filteredLeaveRequests = leaveRequests.filter(req => {
        const empName = getUserName(req.employee_id).toLowerCase();
        const matchesSearch = empName.includes(searchTerm.toLowerCase()) || 
                              (req.reason || '').toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = filterStatus === 'all' || req.status === filterStatus;
        const matchesType = filterType === 'all' || req.type === filterType;

        return matchesSearch && matchesStatus && matchesType;
    });

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
            alert(t('leave.fillDates'));
            return;
        }

        const start = new Date(newRequest.start_date);
        const end = new Date(newRequest.end_date);
        const requestedDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

        if (requestedDays <= 0) {
            alert(t('leave.endDateError'));
            return;
        }

        // 🟩 QUOTA GUARD: Paid Holiday and Sick Leave draw from the intern's
        // profile balance. Block the submission client-side if it would
        // exceed what they currently have — supervisors can still override
        // shortfalls later at approval time if there's a genuine emergency.
        const isQuotaType = newRequest.type === 'Paid Holiday' || newRequest.type === 'Sick Leave';
        if (isQuotaType) {
            const leaveType = newRequest.type === 'Sick Leave' ? 'sick_days' : 'vacation_days';
            const available = userProfile[leaveType] || 0;
            const label = leaveType === 'sick_days' ? t('leave.sick') : t('leave.vacation');

            if (requestedDays > available) {
                alert(t('leave.quotaExceeded', { requested: requestedDays, available, label }));
                return;
            }
        }

        setLoading(true);
        const { error } = await supabase.from('leave_requests').insert({
            ...newRequest,
            reason: sanitizeUserInput(newRequest.reason, { maxLength: 500 }),
            employee_id: userProfile.id,
            status: 'Pending' 
        });

        if (error) {
            showUserError('Failed to submit leave request', error);
        } else {
            // Notifying supervisors is now handled server-side by the
            // notify_leave_submitted trigger — the client can no longer
            // insert into notifications directly (RLS).
            setNewRequest({ type: 'Paid Holiday', start_date: '', end_date: '', reason: '' });
            fetchLeaveRequests();
            alert(t('leave.requestFiled'));
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
        if (!selectedTargetUser) return alert(t('leave.selectStaffFirst'));

        setIsAdjusting(true);
        const targetProfile = allUsers.find(u => u.id === selectedTargetUser);
        
        if (targetProfile) {
            const currentVacation = targetProfile.vacation_days || 0;
            const currentSick = targetProfile.sick_days || 0;

            const newVacation = Math.max(0, currentVacation + parseInt(adjustVacationAmount));
            const newSick = Math.max(0, currentSick + parseInt(adjustSickAmount));

            const { error } = await supabase
                .from('profiles')
                .update({ 
                    vacation_days: newVacation,
                    sick_days: newSick
                })
                .eq('id', selectedTargetUser);

            if (error) {
                showUserError('Failed to update leave allocation', error);
            } else {
                alert(t('leave.allocationSuccess', { name: targetProfile.name }));
                window.location.reload(); // Performs a clean context sync to flush visual tracking states
            }
        }
        setIsAdjusting(false);
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
        const isQuotaType = request.type === 'Paid Holiday' || request.type === 'Sick Leave';
        let daysDiff = 0;
        let leaveType = null;
        let currentDays = null;

        // 🟩 QUOTA GUARD: for quota-drawing types, check the balance BEFORE
        // committing the status change. If the request overruns the
        // intern's remaining days, the supervisor gets an explicit warning
        // and has to knowingly confirm the override — the system no longer
        // silently approves-and-clamps-to-zero.
        if (status === 'Approved' && isQuotaType) {
            const start = new Date(request.start_date);
            const end = new Date(request.end_date);
            // Computes explicit timeline differences including the active baseline start cell day
            daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
            leaveType = request.type === 'Sick Leave' ? 'sick_days' : 'vacation_days';

            const { data: targetProfile, error: fetchError } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', request.employee_id)
                .single();

            if (targetProfile && !fetchError) {
                currentDays = targetProfile[leaveType] || 0;
            }

            const overageDays = currentDays !== null ? daysDiff - currentDays : 0;
            const label = leaveType === 'sick_days' ? t('leave.sick') : t('leave.vacation');

            if (overageDays > 0) {
                const overrideConfirmed = confirm(
                    t('leave.overrideConfirm', { name: getUserName(request.employee_id), current: currentDays, label, requested: daysDiff, overage: overageDays })
                );
                if (!overrideConfirmed) return;
            } else {
                if (!confirm(t('leave.confirmApprove'))) return;
            }
        } else {
            if (!confirm(t('leave.confirmStatusChange', { status }))) return;
        }

        const { error: updateError } = await supabase.from('leave_requests')
            .update({ status: status })
            .eq('id', id);

        if (updateError) {
            showUserError('Failed to update leave request', updateError);
            return;
        }

        // Runs dynamic allowance deduction if the supervisor grants approval
        if (status === 'Approved' && isQuotaType && leaveType && currentDays !== null) {
            const newDays = Math.max(0, currentDays - daysDiff); // Locks deductions to positive coordinates

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
        if (!confirm(t('leave.confirmBulkApprove', { count: selectedRequests.length }))) return;

        setIsBulkProcessingLeave(true);
        const overages = [];

        for (const request of selectedRequests) {
            const isQuotaType = request.type === 'Paid Holiday' || request.type === 'Sick Leave';
            let leaveType = null;
            let daysDiff = 0;
            let currentDays = null;

            if (isQuotaType) {
                const start = new Date(request.start_date);
                const end = new Date(request.end_date);
                daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
                leaveType = request.type === 'Sick Leave' ? 'sick_days' : 'vacation_days';

                const { data: targetProfile } = await supabase.from('profiles').select('*').eq('id', request.employee_id).single();
                currentDays = targetProfile ? (targetProfile[leaveType] || 0) : 0;

                if (daysDiff > currentDays) {
                    overages.push(t('leave.overrideConfirm', {
                        name: getUserName(request.employee_id),
                        current: currentDays,
                        label: leaveType === 'sick_days' ? t('leave.sick') : t('leave.vacation'),
                        requested: daysDiff,
                        overage: daysDiff - currentDays,
                    }));
                }
            }

            const { error: updateError } = await supabase.from('leave_requests').update({ status: 'Approved' }).eq('id', request.id);
            if (updateError) {
                showUserError('Failed to update leave request', updateError);
                continue;
            }

            if (isQuotaType && leaveType && currentDays !== null) {
                const newDays = Math.max(0, currentDays - daysDiff);
                await supabase.from('profiles').update({ [leaveType]: newDays }).eq('id', request.employee_id);
            }
        }

        setSelectedLeaveIds(new Set());
        setIsBulkProcessingLeave(false);
        await fetchLeaveRequests();
        if (selectedRequests.some(r => r.employee_id === userProfile.id)) fetchProfile();

        if (overages.length > 0) {
            alert(t('leave.bulkOverageSummary', { count: overages.length }) + '\n\n' + overages.join('\n'));
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

    const renderCalendar = () => {
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
    };

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-6">
            
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
                    {renderCalendar()}
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
                 <div className="overflow-x-auto">
                     <table className="w-full text-left border-collapse">
                        <thead className="bg-gray-50/80 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                            <tr>
                                {userProfile.role === 'supervisor' && <th className="p-4 w-8"></th>}
                                <th className="p-4">{t('leave.colStaffName')}</th>
                                <th className="p-4">{t('leave.colCategory')}</th>
                                <th className="p-4">{t('leave.colBoundaries')}</th>
                                <th className="p-4">{t('leave.colReason')}</th>
                                <th className="p-4">{t('leave.colStatus')}</th>
                                {userProfile.role === 'supervisor' && <th className="p-4 text-right">{t('leave.colActions')}</th>}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700 text-xs">
                            {filteredLeaveRequests.map(req => (
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
                                                    <button type="button" onClick={() => handleApproval(req.id, 'Approved', req)} className="bg-green-600 hover:bg-green-700 text-white text-xs font-bold py-1.5 px-3 rounded-xl shadow-sm transition-all">{t('leave.approve')}</button>
                                                    <button type="button" onClick={() => handleApproval(req.id, 'Denied', req)} className="bg-red-500 hover:bg-red-600 text-white text-xs font-bold py-1.5 px-3 rounded-xl shadow-sm transition-all">{t('leave.deny')}</button>
                                                </div>
                                            ) : (
                                                <span className="text-gray-400 text-xs italic font-medium pr-2">{t('leave.evaluated')}</span>
                                            )}
                                        </td>
                                    )}
                                </tr>
                            ))}
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