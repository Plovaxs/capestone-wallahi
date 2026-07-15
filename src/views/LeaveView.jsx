import React, { useState } from 'react';
import { supabase } from '../supabaseClient'; 
import ExportButton from '../components/ExportButton';
import { showUserError } from '../utils/errorHandling';

/**
 * COMPONENT: LeaveView
 * PURPOSE: Automated Time-Off & Allowance Tracking Portal.
 * FEATURES:
 * 1. Employee Leave Requests & Shared Team Shift Calendars.
 * 2. Supervisor Allocation Controls (Directly adds/subtracts quota pools).
 * 3. Transactional Deductions: Dynamic date validation deducting days on approval.
 */
// 🟩 FIX: Added createNotification to the props
const LeaveView = ({ userProfile, allUsers = [], leaveRequests = [], fetchLeaveRequests, fetchProfile, createNotification }) => {

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

    // Filters active employee rows for supervisor form drop-downs
    const employeeUsers = (allUsers || []).filter(u => u.role === 'employee');

    /**
     * HELPER UTILITY: statusColor
     * PURPOSE: Resolves glassmorphic color mapping profiles for approval tags.
     */
    const statusColor = (status) => ({
        'Pending': 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-300 dark:border-yellow-900/50',
        'Approved': 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-900/50',
        'Denied': 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900/50',
    }[status] || 'bg-gray-100 dark:bg-gray-700');

    const getUserName = (id) => allUsers.find(u => u.id === id)?.name || 'Unknown Officer';
    
    const getUserCampus = (id) => {
        const u = allUsers.find(user => user.id === id);
        return u?.source || u?.university || 'President University';
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
    const leaveExportPayload = filteredLeaveRequests.map(req => ({
        Date: req.created_at ? new Date(req.created_at).toLocaleDateString('en-GB') : 'N/A',
        Intern: getUserName(req.employee_id),
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
            alert('Please fill out all dates.');
            return;
        }
        
        setLoading(true);
        const { error } = await supabase.from('leave_requests').insert({
            ...newRequest,
            employee_id: userProfile.id,
            status: 'Pending' 
        });

        if (error) {
            showUserError('Failed to submit leave request', error);
        } else {
            // 🟩 FIX: Ping all supervisors that a new leave form is waiting
            const supervisors = allUsers.filter(u => u.role === 'supervisor');
            supervisors.forEach(async (sup) => {
                await createNotification(sup.id, `📅 Leave Request: ${userProfile.name} has submitted a new ${newRequest.type} form.`);
            });

            setNewRequest({ type: 'Paid Holiday', start_date: '', end_date: '', reason: '' });
            fetchLeaveRequests(); 
            alert('Leave request filed cleanly in system queues.');
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
        if (!selectedTargetUser) return alert("Please highlight an intern entry to adjust.");

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
                alert(`Successfully allocated updated balances for ${targetProfile.name}!`);
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
        if (!confirm(`Are you sure you want to ${status} this request?`)) return;

        const { error: updateError } = await supabase.from('leave_requests')
            .update({ status: status })
            .eq('id', id);

        if (updateError) {
            showUserError('Failed to update leave request', updateError);
            return;
        }

        // Runs dynamic allowance deduction if the supervisor grants approval
        if (status === 'Approved' && (request.type === 'Paid Holiday' || request.type === 'Sick Leave')) {
            const start = new Date(request.start_date);
            const end = new Date(request.end_date);
            // Computes explicit timeline differences including the active baseline start cell day
            const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1; 

            const leaveType = request.type === 'Sick Leave' ? 'sick_days' : 'vacation_days';
            
            const { data: targetProfile, error: fetchError } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', request.employee_id)
                .single();
            
            if (targetProfile && !fetchError) {
                const currentDays = targetProfile[leaveType] || 0;
                const newDays = Math.max(0, currentDays - daysDiff); // Locks deductions to positive coordinates

                const { error: profileError } = await supabase.from('profiles')
                    .update({ [leaveType]: newDays })
                    .eq('id', request.employee_id);

                if (profileError) console.error('Error deducting days:', profileError);
            }
        }
        
        // 🟩 FIX: Send notification back to the intern about the decision!
        await createNotification(request.employee_id, `📅 Leave Request Update: Your request for ${request.type} has been ${status}.`);

        await fetchLeaveRequests(); 
        if (request.employee_id === userProfile.id) {
            fetchProfile(); // Refreshes local profile states if the supervisor requested their own time off
        }
    };

    /**
     * GRID RENDERER: renderCalendar
     * PURPOSE: Dynamically draws shared workspace calendar cells for the active month.
     * LOGIC: Checks loop iterations against valid start/end intervals to map intern indicators safely.
     */
    const renderCalendar = () => {
        const today = new Date();
        const year = today.getFullYear();
        const month = today.getMonth(); 
        
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
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">Leave Management</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400">Request leaves, review rosters, and export historical logs.</p>
                </div>
                {userProfile.role === 'supervisor' && (
                    <ExportButton data={leaveExportPayload} filename="Handpicked_Leave_Report" label="Export Leave Logs" />
                )}
            </div>

            {/* --- SECTION 1: ALLOWANCE CARDS & SUBMISSION FIELDS --- */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                
                {/* Visual Metric Allocation Card */}
                <div className="bg-gradient-to-br from-blue-600 to-indigo-800 p-6 rounded-2xl shadow-md text-white flex flex-col justify-between">
                    <div>
                        <h3 className="font-bold text-xs text-blue-100 uppercase tracking-wider mb-4">My Remaining Allowance</h3>
                        <div className="text-4xl font-black mb-1">{userProfile?.vacation_days || 0} <span className="text-xs font-bold text-blue-200 uppercase tracking-wide block sm:inline">Vacation Days</span></div>
                        <div className="text-2xl font-bold">{userProfile?.sick_days || 0} <span className="text-xs font-bold text-blue-200 uppercase tracking-wide block sm:inline">Sick Days</span></div>
                    </div>
                    <p className="text-[11px] text-blue-200/70 mt-6 italic">Approved items systematically calculate deduction quotas automatically.</p>
                </div>

                {/* Inline Action Forms Wrapper */}
                <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                    {userProfile.role === 'supervisor' ? (
                        /* ================= SUPERVISOR ALLOCATION CONSOLE ================= */
                        <>
                            <h2 className="text-lg font-bold mb-1 text-gray-800 dark:text-gray-100">⚖️ Intern Balance Allowance Matrix</h2>
                            <p className="text-xs text-gray-400 mb-4">Allocate new monthly balances (+1, +2 days) or reset quotas directly inside the portal layout.</p>
                            <form onSubmit={handleAdjustBalances} className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end text-xs font-semibold text-gray-500 dark:text-gray-400">
                                <div className="sm:col-span-3 space-y-1">
                                    <label className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">Target Intern student</label>
                                    <select
                                        value={selectedTargetUser}
                                        onChange={e => setSelectedTargetUser(e.target.value)}
                                        className="w-full p-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-bold text-xs"
                                        required
                                    >
                                        <option value="">Select an intern...</option>
                                        {employeeUsers.map(emp => (
                                            <option key={emp.id} value={emp.id}>
                                                {emp.name} (Vac: {emp.vacation_days || 0} | Sick: {emp.sick_days || 0})
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div className="space-y-1">
                                    <label className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">Vacation (+/-)</label>
                                    <input 
                                        type="number"
                                        value={adjustVacationAmount}
                                        onChange={e => setAdjustVacationAmount(e.target.value)}
                                        className="w-full p-2 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-medium"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">Sick Days (+/-)</label>
                                    <input 
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
                                    {isAdjusting ? 'Processing...' : 'Apply Allocations'}
                                </button>
                            </form>
                        </>
                    ) : (
                        /* ================= EMPLOYEE REGISTRATION FORM ================= */
                        <>
                            <h2 className="text-lg font-bold mb-4 text-gray-800 dark:text-gray-100">Submit Absence Form Request</h2>
                            <form onSubmit={handleSubmitRequest} className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-semibold text-gray-500 dark:text-gray-400">
                                <div className="space-y-1">
                                    <label className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">Absence Form Type</label>
                                    <select
                                        value={newRequest.type}
                                        onChange={e => setNewRequest({...newRequest, type: e.target.value})}
                                        className="w-full p-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-bold text-xs"
                                    >
                                        <option>Paid Holiday</option>
                                        <option>Sick Leave</option>
                                        <option>Unpaid Leave</option>
                                    </select>
                                </div>
                                <div className="space-y-1">
                                    <label className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">Contextual Reason</label>
                                    <input
                                        type="text"
                                        value={newRequest.reason}
                                        onChange={e => setNewRequest({...newRequest, reason: e.target.value})}
                                        placeholder="e.g. Medical Appointment"
                                        className="w-full p-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-medium"
                                        required
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">Boundary Start Date</label>
                                    <input
                                        type="date"
                                        value={newRequest.start_date}
                                        onChange={e => setNewRequest({...newRequest, start_date: e.target.value})}
                                        className="w-full p-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-medium"
                                        required
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider pl-1">Boundary End Date</label>
                                    <input
                                        type="date"
                                        value={newRequest.end_date}
                                        onChange={e => setNewRequest({...newRequest, end_date: e.target.value})}
                                        className="w-full p-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none font-medium"
                                        required
                                    />
                                </div>
                                <div className="sm:col-span-2 flex justify-end mt-2">
                                    <button disabled={loading} type="submit" className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-6 rounded-xl shadow transition-all disabled:opacity-50 text-xs shadow-blue-500/10">
                                        {loading ? 'Transmitting...' : 'File Request'}
                                    </button>
                                </div>
                            </form>
                        </>
                    )}
                </div>
            </div>

            {/* --- SECTION 2: GRID SCHEDULE CALENDAR OVERVIEW --- */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                <h2 className="text-sm font-bold text-gray-800 mb-4 dark:text-gray-100 uppercase tracking-wider text-gray-400">Leave Calendar Overview (Current Month)</h2>
                <div className="grid grid-cols-7 gap-0 border border-gray-200 dark:border-gray-700 rounded-2xl overflow-hidden shadow-sm">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                        <div key={d} className="bg-gray-50 p-2.5 text-center text-xs font-bold text-gray-400 border-b border-gray-200 dark:bg-gray-700/60 dark:text-gray-400 dark:border-gray-600">{d}</div>
                    ))}
                    {renderCalendar()}
                </div>
            </div>

            {/* --- SECTION 3: REVISION FILTERS ROW HUB --- */}
            {userProfile.role === 'supervisor' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700">
                    <div>
                        <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Search Intern / Keyword</label>
                        <input 
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Type a name or reason..."
                            className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-900 dark:text-white"
                        />
                    </div>
                    <div>
                        <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Filter Form Categories</label>
                        <select
                            value={filterType}
                            onChange={(e) => setFilterType(e.target.value)}
                            className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-900 dark:text-white"
                        >
                            <option value="all">All Leave Types</option>
                            <option value="Paid Holiday">Paid Holiday</option>
                            <option value="Sick Leave">Sick Leave</option>
                            <option value="Unpaid Leave">Unpaid Leave</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Filter Approval Status</label>
                        <select
                            value={filterStatus}
                            onChange={(e) => setFilterStatus(e.target.value)}
                            className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-900 dark:text-white"
                        >
                            <option value="all">All Request Statuses</option>
                            <option value="Pending">Pending</option>
                            <option value="Approved">Approved</option>
                            <option value="Denied">Denied</option>
                        </select>
                    </div>
                </div>
            )}

            {/* --- SECTION 4: HISTORICAL DATA TABLE LISTS --- */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
                 <div className="p-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-700/30">
                     <h2 className="text-sm font-bold text-gray-800 dark:text-gray-100 uppercase tracking-wider text-gray-400">
                        {userProfile.role === 'supervisor' ? 'Roster Management Table Queue' : 'Personal Request Log History'}
                     </h2>
                 </div>
                 <div className="overflow-x-auto">
                     <table className="w-full text-left border-collapse">
                        <thead className="bg-gray-50/80 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                            <tr>
                                <th className="p-4">Intern Name</th>
                                <th className="p-4">Category</th>
                                <th className="p-4">Calendar Boundaries</th>
                                <th className="p-4">Reason Context</th>
                                <th className="p-4">Status</th>
                                {userProfile.role === 'supervisor' && <th className="p-4 text-right">Evaluation actions</th>}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700 text-xs">
                            {filteredLeaveRequests.map(req => (
                                <tr key={req.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-700/20 transition-all font-semibold">
                                    <td className="p-4 text-gray-900 dark:text-gray-100">
                                        <div className="flex flex-col gap-0.5">
                                            <span className="text-sm font-bold">{getUserName(req.employee_id)}</span>
                                            <span className="text-[10px] text-gray-400 font-bold uppercase font-mono">{getUserCampus(req.employee_id)}</span>
                                        </div>
                                    </td>
                                    <td className="p-4 text-gray-600 dark:text-gray-300 font-bold">{req.type}</td>
                                    <td className="p-4 text-gray-700 dark:text-gray-300 font-mono font-bold">
                                        🗓️ {req.start_date} <span className="text-gray-400 font-sans font-medium">to</span> {req.end_date}
                                    </td>
                                    <td className="p-4 text-gray-500 dark:text-gray-400 italic max-w-xs truncate">
                                        "{req.reason || 'None Specified'}"
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
                                                    <button type="button" onClick={() => handleApproval(req.id, 'Approved', req)} className="bg-green-600 hover:bg-green-700 text-white text-xs font-bold py-1.5 px-3 rounded-xl shadow-sm transition-all">Approve</button>
                                                    <button type="button" onClick={() => handleApproval(req.id, 'Denied', req)} className="bg-red-500 hover:bg-red-600 text-white text-xs font-bold py-1.5 px-3 rounded-xl shadow-sm transition-all">Deny</button>
                                                </div>
                                            ) : (
                                                <span className="text-gray-400 text-xs italic font-medium pr-2">Evaluated</span>
                                            )}
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                     </table>
                 </div>
                 {filteredLeaveRequests.length === 0 && (
                    <p className="text-center text-gray-400 text-xs py-12 italic dark:text-gray-500">No leave requests match your search criteria.</p>
                 )}
            </div>
        </div>
    );
};

export default LeaveView;