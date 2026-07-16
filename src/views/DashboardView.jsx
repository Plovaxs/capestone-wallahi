import React, { useState, useEffect } from 'react';
import { 
    LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, 
    Tooltip, Legend, ResponsiveContainer 
} from 'recharts';

/**
 * COMPONENT: DashboardView
 * PURPOSE: Executive Telemetry Dashboard Aggregator.
 * FIXED: Shifted month index processing from (Jul-Dec) to (Jan-Jun) to perfectly match active internship timeline data.
 */
const DashboardView = ({ userProfile, tasks = [], leaveRequests = [], attendance = [], allUsers = [], reviews = [], setActiveView }) => {
    const [selectedEmployee, setSelectedEmployee] = useState(userProfile.role === 'supervisor' ? 'all' : userProfile.id);
    const [showSettings, setShowSettings] = useState(false);

    // --- 1. CONFIGURABLE WIDGET STATE ---
    const [widgets, setWidgets] = useState(() => {
        const saved = localStorage.getItem('dashboard_widgets');
        return saved ? JSON.parse(saved) : {
            metrics: true,
            attendanceChart: true,
            taskChart: true,
            recentReviews: true
        };
    });

    useEffect(() => {
        localStorage.setItem('dashboard_widgets', JSON.stringify(widgets));
    }, [widgets]);

    const toggleWidget = (key) => {
        setWidgets(prev => ({ ...prev, [key]: !prev[key] }));
    };

    // --- 2. SYNCHRONIZED METRICS ---
    
    // PENDING TASKS (Active Workload)
    const activeWorkload = tasks.filter(t => {
        const isActive = t.status === 'To Do' || t.status === 'In Progress' || t.status === 'Revision Needed';
        if (userProfile.role === 'supervisor') return isActive; 
        return isActive && (t.assigned_to || []).includes(userProfile.id);
    }).length;

    // PENDING APPROVALS (Action Items)
    let approvalCount = 0;
    let approvalLabel = "System operations clean";

    if (userProfile.role === 'supervisor') {
        const pendingLeaves = leaveRequests.filter(r => r.status === 'Pending').length;
        const pendingTaskReviews = tasks.filter(t => t.status === 'Completed').length;
        
        approvalCount = pendingLeaves + pendingTaskReviews;
        if (approvalCount > 0) {
            approvalLabel = `${pendingLeaves} leave forms, ${pendingTaskReviews} tasks pending review`;
        }
    } else {
        const myPendingLeaves = leaveRequests.filter(r => r.employee_id === userProfile.id && r.status === 'Pending').length;
        const myPendingTasks = tasks.filter(t => 
            (t.assigned_to || []).includes(userProfile.id) && t.status === 'Completed'
        ).length;
        
        approvalCount = myPendingLeaves + myPendingTasks;
        if (approvalCount > 0) approvalLabel = "Awaiting supervisor confirmation feedback";
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
        if (!allUsers || !id) return 'Unknown Officer';
        const match = allUsers.find(u => String(u.id) === String(id));
        return match ? match.name : 'Unknown Officer';
    };

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

    return (
        <div className="p-8 relative space-y-6">
            
            {/* --- HEADER --- */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-gray-200 dark:border-gray-700/60 pb-4">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">Welcome, {userProfile.name}!</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Operational monitoring systems status review matrix.</p>
                </div>
                
                <div className="relative self-end sm:self-center">
                    <button 
                        type="button"
                        onClick={() => setShowSettings(!showSettings)} 
                        className="flex items-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2 px-4 rounded-xl border transition text-xs dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700 dark:hover:bg-gray-700"
                    >
                        <span>⚙️ Configure Metrics</span>
                    </button>

                    {showSettings && (
                        <div className="absolute right-0 mt-2 w-64 bg-white rounded-xl shadow-xl border border-gray-100 z-50 p-4 dark:bg-gray-800 dark:border-gray-700 animate-scale-up">
                            <h3 className="font-bold text-xs text-gray-400 uppercase tracking-wider mb-3">Visible UI Cards</h3>
                            <div className="space-y-2.5 text-xs font-bold text-gray-700 dark:text-gray-300">
                                <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                    <input type="checkbox" checked={widgets.metrics} onChange={() => toggleWidget('metrics')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                    <span>Key Metrics Summary</span>
                                </label>
                                <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                    <input type="checkbox" checked={widgets.attendanceChart} onChange={() => toggleWidget('attendanceChart')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                    <span>Attendance Trends Line</span>
                                </label>
                                <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                    <input type="checkbox" checked={widgets.taskChart} onChange={() => toggleWidget('taskChart')} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                    <span>Task Completion Bars</span>
                                </label>
                                <label className="flex items-center space-x-3 cursor-pointer hover:opacity-80">
                                    <input type="checkbox" checked={widgets.recentReviews} onChange={() => toggleWidget('recentReviews')} className="form-checkbox rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"/>
                                    <span>Recent Appraisals Sheet</span>
                                </label>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* --- ADMIN INTERN SELECTOR --- */}
            {(widgets.attendanceChart || widgets.taskChart) && userProfile.role === 'supervisor' && (
                <div className="flex justify-end bg-white p-3 rounded-2xl border border-gray-100 dark:bg-gray-800 dark:border-gray-700 shadow-sm">
                    <select
                        value={selectedEmployee}
                        onChange={(e) => setSelectedEmployee(e.target.value)}
                        className="p-2 text-xs border border-gray-200 rounded-xl shadow-sm bg-gray-50 dark:bg-gray-900 dark:border-gray-600 dark:text-white focus:outline-none font-bold"
                    >
                        <option value="all">All Outsourcing Staff Roster Entries</option>
                        {employeeUsers.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                    </select>
                </div>
            )}

            {/* --- CORE STAT WIDGET CARDS --- */}
            {widgets.metrics && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-fade-in-down">
                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 border-l-4 border-l-blue-500 dark:bg-gray-800 dark:border-gray-700/60 dark:border-l-blue-500">
                        <h3 className="font-bold text-xs text-gray-400 uppercase tracking-wider">
                            {userProfile.role === 'supervisor' ? 'Team Active Workload' : 'My Pending Tasks'}
                        </h3>
                        <div className="flex items-baseline gap-2 mt-2">
                            <p className="text-4xl font-extrabold text-gray-800 dark:text-gray-100">{activeWorkload}</p>
                            <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">Tasks Active</span>
                        </div>
                    </div>

                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 border-l-4 border-l-green-500 dark:bg-gray-800 dark:border-gray-700/60 dark:border-l-green-500">
                        <h3 className="font-bold text-xs text-gray-400 uppercase tracking-wider">Accredited Leave Days</h3>
                        <div className="flex items-baseline gap-2 mt-2">
                            <p className="text-4xl font-extrabold text-gray-800 dark:text-gray-100">{leaveDaysTaken}</p>
                            <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">Days Closed</span>
                        </div>
                    </div>

                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 border-l-4 border-l-yellow-500 dark:bg-gray-800 dark:border-gray-700/60 dark:border-l-yellow-500">
                        <h3 className="font-bold text-xs text-gray-400 uppercase tracking-wider">
                            {userProfile.role === 'supervisor' ? 'Approvals Outstanding' : 'Awaiting Operational Approval'}
                        </h3>
                        <div className="flex flex-col mt-2 justify-center">
                            <div className="flex items-baseline gap-2">
                                <p className="text-4xl font-extrabold text-gray-800 dark:text-gray-100">{approvalCount}</p>
                                <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">Items Flagged</span>
                            </div>
                            {approvalCount > 0 && (
                                <p className="text-[10px] font-bold text-amber-600 dark:text-amber-400 italic mt-1 bg-amber-50 dark:bg-amber-950/20 px-2 py-0.5 rounded w-fit">{approvalLabel}</p>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* --- RECHARTS TIMELINE GRAPH GRIDS --- */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {widgets.attendanceChart && (
                    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700/60">
                        <h2 className="text-sm font-bold text-gray-700 mb-4 dark:text-gray-100 uppercase tracking-wider">Attendance Trends Timeline</h2>
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
                        <h2 className="text-sm font-bold text-gray-700 mb-4 dark:text-gray-100 uppercase tracking-wider">Deliverables Completed Volume</h2>
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
            </div>

            {/* --- RECENT APPRAISAL LOGS TRANSCRIPTS --- */}
            {widgets.recentReviews && (
                <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700/60">
                    <h2 className="text-sm font-bold text-gray-700 mb-4 dark:text-gray-100 uppercase tracking-wider">Institutional Performance Transcript Log</h2>
                    {reviews && reviews.length > 0 ? (
                        <div className="space-y-4">
                            {reviews.slice(0, 3).map(review => {
                                const textToDisplay = review.comments || review.review_text || 'No technical observations recorded.';
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
                                                    Appraisal filed by: <span className="text-blue-600 dark:text-blue-400">{getUserName(review.supervisor_id)}</span>
                                                </p>
                                                {review.final_score !== undefined && (
                                                    <div className="flex items-center gap-2">
                                                        <div className="flex text-yellow-400 text-xs tracking-tighter">
                                                            {[...Array(Math.max(1, Math.min(5, Math.round((review.final_score / 100) * 5))))].map((_, i) => <span key={i}>★</span>)}
                                                        </div>
                                                        <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400">
                                                            Index: {review.final_score} Pts
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                            <p className="text-[10px] font-bold text-gray-400 font-mono uppercase">
                                                {review.created_at ? new Date(review.created_at).toLocaleDateString('en-GB') : (review.date || 'Pending Log')}
                                            </p>
                                        </div>
                                        <p className="text-gray-600 dark:text-gray-300 text-xs italic pl-1 leading-relaxed bg-gray-50/40 dark:bg-gray-900/20 p-3 rounded-xl border border-dashed dark:border-gray-700/40">
                                            "{truncatedText}"
                                        </p>
                                        <span className="mt-2 inline-block text-[10px] font-bold text-blue-600 dark:text-blue-400 group-hover:underline">
                                            View Full Rubric Report →
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="text-center text-xs text-gray-400 py-8 dark:text-gray-500 italic">No formal framework appraisal scores logged inside data systems yet.</p>
                    )}
                </div>
            )}
        </div>
    );
};

export default DashboardView;