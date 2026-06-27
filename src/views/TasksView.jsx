import React, { useState } from 'react';
import { supabase } from '../supabaseClient';
import Modal from '../components/Modal';
import ExportButton from '../components/ExportButton';

/**
 * SUB-COMPONENT: UserAvatar
 * PURPOSE: Renders an employee's circular profile image or initial character placeholder.
 * DEPENDENCIES: Accurately checks profile avatar URLs or defaults to nickname initials.
 */
const UserAvatar = ({ user, size = "w-6 h-6", textSize = "text-[9px]" }) => {
    if (!user) return null;

    if (user.avatar_url) {
        return (
            <img
                src={user.avatar_url}
                alt={user.name}
                title={user.name}
                className={`${size} rounded-full border border-white object-cover shadow-sm dark:border-gray-800`}
            />
        );
    }

    return (
         <div 
            title={user.name} 
            className={`${size} rounded-full bg-gray-200 border border-white flex items-center justify-center ${textSize} font-bold text-gray-600 shadow-sm dark:border-gray-800 dark:bg-gray-700 dark:text-gray-300`}
         >
            {user.name?.charAt(0) || '?'}
        </div>
    );
};

/**
 * MAIN VIEW COMPONENT: TasksView
 * PURPOSE: Manages the Kanban sprint boards, assignment creation workflows, and task deadline adjustments.
 * ACCESS ROLES: Employees view personal streams; Supervisors modify target parameters globally.
 */
const TasksView = ({ userProfile, tasks = [], allUsers = [], fetchTasks, createNotification }) => {
    
    // Safety check ensuring authentication state is resolved before mounting DOM branches
    if (!userProfile) {
        return <div className="p-8 text-gray-500">Initializing Task System...</div>;
    }

    // --- VIEWPORT VIEW CONFIGURATIONS ---
    const [viewMode, setViewMode] = useState('board'); // Toggles layout profiles ('board' vs 'timeline')
    const [isModalOpen, setIsModalOpen] = useState(false); // Controls new task generation modal visibility
    
    // --- ADVANCED TIMELINE EXTENSION INTERACTIVE STATES ---
    const [isExtensionModalOpen, setIsExtensionModalOpen] = useState(false); // Controls scheduling modal mask
    const [extensionTask, setExtensionTask] = useState(null); // Active database task row context target
    const [extensionDate, setExtensionDate] = useState(''); // Selected updated calendar date value
    const [extensionFeedback, setExtensionFeedback] = useState(''); // Text description logs for revisions
    const [extensionMode, setExtensionMode] = useState('extend'); // Directs modal layout logic ('extend' vs 'reject')

    // --- NEW TASK INITIALIZATION COMPOSER STATE ---
    const [newTask, setNewTask] = useState({ 
        title: '', 
        description: '', 
        assigned_to: [], 
        due_date: '',
        priority: 'Normal' 
    });
    
    // --- LOCAL FILE HANDLING BUFFER MATRICES ---
    const [selectedFiles, setSelectedFiles] = useState({}); // Indexes files locally before upload validation
    const [uploading, setUploading] = useState(null); // Keeps track of active loading states per row ID

    // --- SEARCH FILTERS AND CONTROLS ---
    const [searchTerm, setSearchTerm] = useState('');
    const [filterEmployee, setFilterEmployee] = useState('all');
    const [filterPriority, setFilterPriority] = useState('all');

    // Filters active employee roster records for select option loops
    const employeeUsers = (allUsers || []).filter(u => u.role === 'employee');
    
    // Calculates a dynamic baseline tomorrow constraint string used to validate minimum extension boundaries
    const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    // Static layout configuration definitions matching Kanban column rules
    const COLUMNS = [
        { id: 'col_todo', label: 'To Do', color: 'bg-purple-600' },
        { id: 'col_doing', label: 'In Progress', color: 'bg-orange-500' },
        { id: 'col_review', label: 'Ready for Review', color: 'bg-pink-500' }, 
        { id: 'col_done', label: 'Done', color: 'bg-green-500' }
    ];

    /**
     * UTILITY FUNCTION: getColumnId
     * PURPOSE: Maps custom database task status string fields onto respective Kanban columns.
     */
    const getColumnId = (status) => {
        switch (status) {
            case 'To Do': return 'col_todo';
            case 'In Progress': return 'col_doing';
            case 'Revision Needed': return 'col_doing'; // Locks revisions inside 'In Progress' columns
            case 'Completed': return 'col_review';      
            case 'Approved': return 'col_done';
            default: return 'col_todo';
        }
    };

    /**
     * UTILITY FUNCTION: getPriorityStyle
     * PURPOSE: Resolves aesthetic color themes for high-contrast priority tags.
     */
    const getPriorityStyle = (p) => ({
        'High': 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800',
        'Normal': 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800',
        'Low': 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600'
    }[p] || 'bg-gray-100 text-gray-700');

    /**
     * UTILITY FUNCTION: getDeadlineStatus
     * PURPOSE: Performs system real-time date evaluation vectors to trigger warning alerts.
     */
    const getDeadlineStatus = (dueDate, status) => {
        if (['Approved', 'Completed'].includes(status)) return 'Safe';
        if (!dueDate) return 'Normal';
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const due = new Date(dueDate);
        due.setHours(0, 0, 0, 0);
        
        const diffTime = due - today;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        if (diffDays < 0) return 'Overdue';
        if (diffDays <= 2) return 'Near Deadline'; 
        return 'Normal';
    };

    // =========================================================================
    // 🔍 ENGINE LOGIC DATA PRE-PROCESSING & FILTER CHANNELS
    // =========================================================================
    const processedTasks = (tasks || []).filter(t => {
        const matchesSearch = t.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
                              t.description.toLowerCase().includes(searchTerm.toLowerCase());
        
        // Security logic: Enforces scope boundaries so interns can never look into others' card files
        const effectiveTargetEmp = userProfile.role === 'supervisor' ? filterEmployee : userProfile.id;
        const matchesEmployee = effectiveTargetEmp === 'all' || (t.assigned_to || []).includes(effectiveTargetEmp);
        const matchesPriority = filterPriority === 'all' || t.priority === filterPriority;

        return matchesSearch && matchesEmployee && matchesPriority;
    });

    const getAssigneeNames = (ids) => {
        if (!ids || !Array.isArray(ids)) return 'Unassigned';
        return ids.map(id => {
            const user = allUsers.find(u => String(u.id) === String(id));
            return user ? user.name : 'Unknown';
        }).join(', ');
    };

    // Formats filtered parameters into a sanitized format before generating spreadsheet reports
    const exportData = processedTasks.map(t => ({
        Task: t.title,
        Description: t.description,
        Priority: t.priority,
        Status: t.status,
        "Due Date": t.due_date,
        "Deadline Warning": getDeadlineStatus(t.due_date, t.status),
        "Assigned To": getAssigneeNames(t.assigned_to),
        Feedback: t.feedback || 'None'
    }));

    // Generates a forward-facing 7-day row block array to construct layout cells for the timeline view
    const timelineDates = (() => {
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() + i);
            days.push(d.toISOString().split('T')[0]);
        }
        return days;
    })();

    // =========================================================================
    // ⚙️ CORE BACKEND MUTATION CONTROLLERS (SUPABASE DISPATCH PIPELINES)
    // =========================================================================

    /**
     * TRANSACTION: handleCreateTask
     * PURPOSE: Inserts a freshly configured task assignment row into the public database.
     * TELEMETRY: Loops through every selected assignee array slot to dispatch matching workspace notice cards.
     */
    const handleCreateTask = async () => {
        if (!newTask.title || newTask.assigned_to.length === 0 || !newTask.due_date) {
            alert('Please fill out all required fields.');
            return;
        }
        const { error } = await supabase.from('tasks').insert({
            title: newTask.title,
            description: newTask.description,
            assigned_to: newTask.assigned_to, 
            due_date: newTask.due_date,
            priority: newTask.priority,
            status: 'To Do', 
            is_extended: false
        });
        if (error) alert('Error: ' + error.message);
        else {
            newTask.assigned_to.forEach(async (userId) => await createNotification(userId, `New Task Assigned: ${newTask.title}`));
            alert('Task assigned successfully.');
            setNewTask({ title: '', description: '', assigned_to: [], due_date: '', priority: 'Normal' });
            setIsModalOpen(false);
            fetchTasks(); 
        }
    };

    /**
     * TRANSACTION: handleApproveTask
     * PURPOSE: Mutates task row status profiles to 'Approved' upon verification.
     * TELEMETRY: Transmits confirmation logs straight to intern notification feeds.
     */
    const handleApproveTask = async (task) => {
        const { error } = await supabase
            .from('tasks')
            .update({ status: 'Approved' })
            .eq('id', task.id);

        if (error) {
            alert("Database Error during approval: " + error.message);
        } else {
            (task.assigned_to || []).forEach(async (userId) => {
                await createNotification(userId, `🎉 Task Approved: Your submission for "${task.title}" has been successfully approved!`);
            });
            fetchTasks();
        }
    };

    /**
     * TRANSACTION: handleSaveDeadlineExtension
     * PURPOSE: Unified controller processing layout timeline modifications.
     * CRITICAL LOGIC: If mode evaluates to 'reject', applies text data feedback parameters 
     * alongside setting the required 'is_extended: true' database tracking flags.
     */
    const handleSaveDeadlineExtension = async () => {
        if (!extensionTask || !extensionDate) return;

        // Hard minimum constraint verification safety layer
        if (extensionDate < tomorrowStr) {
            alert("⚠️ Scheduling Contradiction: Earliest extension threshold starts from tomorrow.");
            return;
        }

        const updatePayload = { due_date: extensionDate, is_extended: true };
        let noticeText = '';

        if (extensionMode === 'reject') {
            if (!extensionFeedback.trim()) {
                alert("Please add a reason for the revision.");
                return;
            }
            updatePayload.status = 'Revision Needed';
            updatePayload.feedback = extensionFeedback.trim();
            noticeText = `Revision Required for "${extensionTask.title}". Extended Target: ${extensionDate}`;
        } else {
            noticeText = `🎉 Breathing Room: Deadline extended for "${extensionTask.title}" to ${extensionDate}.`;
        }

        const { error } = await supabase.from('tasks').update(updatePayload).eq('id', extensionTask.id);
        if (!error) {
            extensionTask.assigned_to.forEach(async (uid) => await createNotification(uid, noticeText));
            setIsExtensionModalOpen(false);
            setExtensionTask(null);
            fetchTasks();
        } else {
            alert("Database transmission error: " + error.message);
        }
    };

    /**
     * HELPER CALCULATOR: applyPresetDays
     * PURPOSE: Populates calendar inputs using calculated future date preset windows.
     */
    const applyPresetDays = (daysCount) => {
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + daysCount);
        setExtensionDate(targetDate.toISOString().split('T')[0]);
    };

    const toggleAssignee = (userId) => {
        setNewTask(prev => {
            const current = prev.assigned_to;
            return current.includes(userId) 
                ? { ...prev, assigned_to: current.filter(id => id !== userId) }
                : { ...prev, assigned_to: [...current, userId] };
        });
    };

    const handleFileChange = (e, taskId) => { 
        const currentTask = tasks.find(t => t.id === taskId);
        if (!currentTask?.assigned_to?.includes(userProfile.id)) {
            alert("⚠️ Access Denied: Task assigned to another employee.");
            e.target.value = null; 
            return;
        }
        if (e.target.files?.[0]) {
            setSelectedFiles(prev => ({ ...prev, [taskId]: e.target.files[0] })); 
        }
    };

   const handleFileUpload = async (taskId) => {
        const currentTask = tasks.find(t => t.id === taskId);
        if (!currentTask?.assigned_to?.includes(userProfile.id)) return;

        const file = selectedFiles[taskId];
        if (!file) return;

        setUploading(taskId);
        const filePath = `${userProfile.id}/${taskId}/${Date.now()}.${file.name.split('.').pop()}`;
        await supabase.storage.from('task_submission').upload(filePath, file);
        await supabase.from('tasks').update({ submitted_file_path: filePath, status: 'Completed', feedback: null }).eq('id', taskId);
        
        // 🟩 NEW: Ping all supervisors that a task is ready for review
        const supervisors = allUsers.filter(u => u.role === 'supervisor');
        supervisors.forEach(async (sup) => {
            await createNotification(sup.id, `📌 Task Ready for Review: ${userProfile.name} has submitted "${currentTask.title}".`);
        });

        fetchTasks();
        setUploading(null);
    };

    const handleStatusChange = async (taskId, newStatus) => {
        await supabase.from('tasks').update({ status: newStatus }).eq('id', taskId);
        fetchTasks();
    };

    const handleViewSubmission = async (path) => {
        const { data } = await supabase.storage.from('task_submission').createSignedUrl(path, 60);
        if (data) window.open(data.signedUrl, '_blank');
    };

    // =========================================================================
    // 🧱 UI SUB-RENDER CONTEXTS (CARD MODULES & SHEETS)
    // =========================================================================

    const TaskCard = ({ task }) => {
        const deadlineStatus = getDeadlineStatus(task.due_date, task.status);

        return (
            <div className={`bg-white p-4 rounded-xl border shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3 h-fit dark:bg-gray-800 dark:border-gray-700 ${
                task.status === 'Revision Needed' 
                ? 'border-l-4 border-l-red-500' 
                : (deadlineStatus === 'Overdue' ? 'border-l-4 border-l-red-600 dark:border-l-red-500' : 'border-gray-200')
            }`}>
                
                {/* STATUS BADGES FLEX LAYOUT ROW */}
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md border ${getPriorityStyle(task.priority)}`}>
                        {task.priority}
                    </span>

                    {task.is_extended && (
                        <span className="text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-900/50 px-2 py-0.5 rounded-md tracking-wide shadow-sm flex items-center gap-1">
                            ⏳ Extended
                        </span>
                    )}

                    {task.status === 'Revision Needed' && (
                        <span className="text-[10px] font-bold bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900/50 px-2 py-0.5 rounded-md flex items-center gap-1">
                            🛠️ Needs Fix
                        </span>
                    )}
                    {deadlineStatus === 'Overdue' && (
                        <span className="text-[10px] font-bold bg-red-100 text-red-700 border border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900 px-2 py-0.5 rounded-md tracking-wide animate-pulse flex items-center gap-1">
                            ⚠️ Overdue
                        </span>
                    )}
                    {deadlineStatus === 'Near Deadline' && (
                        <span className="text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900/50 px-2 py-0.5 rounded-md flex items-center gap-1">
                            ⏳ Due Soon
                        </span>
                    )}
                </div>

                {/* Card Title Content Block */}
                <div>
                    <h4 className="font-bold text-gray-800 text-sm mb-1 dark:text-gray-100 leading-snug">{task.title}</h4>
                    <div className={`text-xs flex items-center gap-1 font-medium ${deadlineStatus === 'Overdue' ? 'text-red-500 font-bold' : 'text-gray-500 dark:text-gray-400'}`}>
                        <span>📅 Due: {task.due_date}</span>
                    </div>
                    {task.feedback && task.status === 'Revision Needed' && (
                        <div className="mt-2 text-xs bg-red-50 text-red-600 p-2 rounded border border-red-100 italic dark:bg-red-900/10 dark:text-red-400 dark:border-red-900/30">
                            "Supervisor: {task.feedback}"
                        </div>
                    )}
                </div>
                
                {/* Bottom Profile Mapping & Inline Action Triggers */}
                <div className="mt-2 pt-3 border-t border-gray-100 flex justify-between items-center dark:border-gray-700">
                    <div className="flex -space-x-2">
                        {(task.assigned_to || []).map(uid => {
                            const u = allUsers.find(user => String(user.id) === String(uid));
                            return <UserAvatar key={uid} user={u} size="w-6 h-6" textSize="text-[9px]" />;
                        })}
                    </div>
                    
                    <div className="flex gap-1.5 text-xs font-bold items-center">
                        {userProfile.role !== 'supervisor' && (
                            <>
                                {task.status === 'To Do' && <button onClick={() => handleStatusChange(task.id, 'In Progress')} className="text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-1 rounded dark:bg-blue-900/20 dark:text-blue-400">Start</button>}
                                {(task.status === 'In Progress' || task.status === 'Revision Needed') && (
                                    <label className="cursor-pointer text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-1 rounded dark:bg-blue-900/20 dark:text-blue-400">
                                        {uploading === task.id ? '...' : (task.status === 'Revision Needed' ? 'Re-Upload' : 'Upload')}
                                        <input type="file" className="hidden" onChange={(e) => handleFileChange(e, task.id)} />
                                        {selectedFiles[task.id] && <button onClick={() => handleFileUpload(task.id)} className="ml-1 underline font-bold text-indigo-600 dark:text-indigo-400">Send</button>}
                                    </label>
                                )}
                                {task.status === 'Completed' && <span className="text-gray-400 italic font-medium">Waiting...</span>}
                            </>
                        )}
                        {task.submitted_file_path && <button onClick={() => handleViewSubmission(task.submitted_file_path)} className="text-gray-600 hover:text-gray-900 dark:text-gray-300 font-semibold underline">View File</button>}
                        
                        {/* Master Supervisor Action Controls Matrix */}
                        {userProfile.role === 'supervisor' && task.status === 'Completed' && (
                            <>
                                <button onClick={() => handleApproveTask(task)} className="text-green-600 hover:text-green-800 font-bold bg-green-50 px-2 py-1 rounded dark:bg-green-900/20 dark:text-green-400">Approve</button>
                                <button onClick={() => { 
                                    setExtensionTask(task);
                                    setExtensionDate(tomorrowStr);
                                    setExtensionFeedback('');
                                    setExtensionMode('reject');
                                    setIsExtensionModalOpen(true);
                                }} className="text-red-600 hover:text-red-800 bg-red-50 px-2 py-1 rounded dark:bg-red-900/20 dark:text-red-400">Reject</button>
                            </>
                        )}

                        {userProfile.role === 'supervisor' && ['In Progress', 'Revision Needed'].includes(task.status) && deadlineStatus === 'Overdue' && (
                            <button
                                type="button"
                                onClick={() => {
                                    setExtensionTask(task);
                                    setExtensionDate(tomorrowStr);
                                    setExtensionMode('extend');
                                    setIsExtensionModalOpen(true);
                                }}
                                className="text-amber-600 hover:text-amber-800 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300 px-2 py-1 rounded font-bold border border-amber-200 dark:border-amber-900/50 transition-all active:scale-95"
                            >
                                ⏳ Extend
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    const ProgressCard = ({ employee }) => {
        const empTasks = (tasks || []).filter(t => (t.assigned_to || []).includes(employee.id));
        const total = empTasks.length;
        const done = empTasks.filter(t => t.status === 'Approved' || t.status === 'Completed').length;
        const percentage = total === 0 ? 0 : Math.round((done / total) * 100);

        return (
            <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700 flex flex-col gap-3 min-w-[250px]">
                <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                         <UserAvatar user={employee} size="w-8 h-8" textSize="text-sm" />
                        <h4 className="font-bold text-gray-800 dark:text-gray-100">{employee.name}</h4>
                    </div>
                    <span className="text-xs text-gray-400 font-medium">{done}/{total} Tasks</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2.5 dark:bg-gray-700">
                    <div className="bg-blue-600 h-2.5 rounded-full transition-all duration-500" style={{ width: `${percentage}%` }}></div>
                </div>
                <div className="flex justify-between text-xs font-bold mt-1">
                    <span className="text-blue-600">{percentage}% Complete</span>
                </div>
            </div>
        );
    };

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-6">
            
            {/* --- LAYOUT HEADER CONTROLS --- */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-gray-200 dark:border-gray-700 pb-4 gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">Task Management</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400">Track project progress, critical timelines, and deliverables.</p>
                </div>
                
                <div className="flex flex-wrap gap-2 items-center w-full md:w-auto justify-end">
                    {userProfile.role === 'supervisor' && (
                        <ExportButton data={exportData} filename="Handpicked_Task_Report" label="Export Hand-Picked Tasks" />
                    )}

                    <div className="flex gap-2 bg-gray-100 p-1 rounded-xl dark:bg-gray-700 border dark:border-gray-600">
                        <button type="button" onClick={() => setViewMode('board')} className={`px-4 py-1.5 text-xs font-bold rounded-lg transition-all ${viewMode === 'board' ? 'bg-white shadow text-blue-600 dark:bg-gray-600 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>Board</button>
                        <button type="button" onClick={() => setViewMode('timeline')} className={`px-4 py-1.5 text-xs font-bold rounded-lg transition-all ${viewMode === 'timeline' ? 'bg-white shadow text-blue-600 dark:bg-gray-600 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>Timeline</button>
                    </div>

                    {userProfile.role === 'supervisor' && (
                        <button type="button" onClick={() => setIsModalOpen(true)} className="bg-blue-700 hover:bg-blue-800 text-white text-xs font-bold py-2.5 px-4 rounded-xl shadow-sm transition">
                            + Assign Task
                        </button>
                    )}
                </div>
            </div>

            {/* --- CONTROL PANEL FILTERS BAR --- */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700">
                <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Search Keywords</label>
                    <input 
                        type="text"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder="Filter by title..."
                        className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-700 dark:text-white"
                    />
                </div>

                <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Assigned Intern</label>
                    {userProfile.role === 'supervisor' ? (
                        <select
                            value={filterEmployee}
                            onChange={(e) => setFilterEmployee(e.target.value)}
                            className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-700 dark:text-white"
                        >
                            <option value="all">All Interns</option>
                            {employeeUsers.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                        </select>
                    ) : (
                        <input 
                            type="text" 
                            disabled 
                            value={userProfile.name}
                            className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed"
                        />
                    )}
                </div>

                <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Task Priority</label>
                    <select
                        value={filterPriority}
                        onChange={(e) => setFilterPriority(e.target.value)}
                        className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-700 dark:text-white"
                    >
                        <option value="all">All Priorities</option>
                        <option value="High">🔴 High</option>
                        <option value="Normal">🔵 Normal</option>
                        <option value="Low">⚪ Low</option>
                    </select>
                </div>
            </div>

            {/* --- CREATION MODAL CONTAINER --- */}
            <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="New Task Assignment">
                <div className="space-y-4">
                    <div>
                        <label className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">Title</label>
                        <input type="text" value={newTask.title} onChange={e => setNewTask({...newTask, title: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"/>
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">Description</label>
                        <textarea value={newTask.description} onChange={e => setNewTask({...newTask, description: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white resize-none" rows="2"></textarea>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">Priority</label>
                            <select value={newTask.priority} onChange={e => setNewTask({...newTask, priority: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                                <option>Low</option>
                                <option>Normal</option>
                                <option>High</option>
                            </select>
                        </div>
                        <div>
                             <label className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">Due Date</label>
                             <input type="date" value={newTask.due_date} onChange={e => setNewTask({...newTask, due_date: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"/>
                        </div>
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">Assignees</label>
                        <div className="mt-1 border border-gray-300 rounded max-h-32 overflow-y-auto p-2 bg-gray-50 dark:bg-gray-700 dark:border-gray-600">
                            {employeeUsers.map(emp => (
                                <label key={emp.id} className="flex items-center space-x-2 p-1 hover:bg-gray-200 rounded cursor-pointer dark:hover:bg-gray-600">
                                    <input type="checkbox" checked={newTask.assigned_to.includes(emp.id)} onChange={() => toggleAssignee(emp.id)} />
                                    <span className="text-sm dark:text-gray-200">{emp.name}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                    <button type="button" onClick={handleCreateTask} className="w-full bg-blue-700 text-white font-bold py-2 rounded text-sm hover:bg-blue-800">Confirm Assignment</button>
                </div>
            </Modal>

            {/* --- TIMELINE ADJUSTMENT / REVISION CONTROL PANEL MODAL --- */}
            <Modal 
                isOpen={isExtensionModalOpen} 
                onClose={() => { setIsExtensionModalOpen(false); setExtensionTask(null); }} 
                title={extensionMode === 'reject' ? "🚨 Flag Revision Required" : "⏳ Grant Project Breathing Room"}
            >
                <div className="space-y-4 text-xs">
                    {extensionMode === 'reject' && (
                        <div>
                            <label className="block font-bold text-gray-400 uppercase tracking-wider mb-1">Reason for Revision / Notes</label>
                            <textarea
                                required
                                value={extensionFeedback}
                                onChange={(e) => setExtensionFeedback(e.target.value)}
                                placeholder="Specify details, issues, or sections that need fixing..."
                                className="w-full p-2.5 border rounded-xl dark:bg-gray-700 dark:border-gray-600 dark:text-white resize-none focus:outline-none"
                                rows="3"
                            />
                        </div>
                    )}

                    <div>
                        <label className="block font-bold text-gray-400 uppercase tracking-wider mb-1">Select Extended Due Date</label>
                        <input 
                            type="date"
                            required
                            min={tomorrowStr} 
                            value={extensionDate}
                            onChange={(e) => setExtensionDate(e.target.value)}
                            className="w-full p-2.5 border rounded-xl dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                    </div>

                    <div>
                        <label className="block font-bold text-gray-400 uppercase tracking-wider mb-1.5">Quick Date Presets</label>
                        <div className="flex gap-2">
                            <button type="button" onClick={() => applyPresetDays(1)} className="flex-1 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 p-2 rounded-lg font-bold text-[10px] transition-colors dark:text-white">Tomorrow</button>
                            <button type="button" onClick={() => applyPresetDays(3)} className="flex-1 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 p-2 rounded-lg font-bold text-[10px] transition-colors dark:text-white">+3 Days</button>
                            <button type="button" onClick={() => applyPresetDays(7)} className="flex-1 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 p-2 rounded-lg font-bold text-[10px] transition-colors dark:text-white">+1 Week</button>
                        </div>
                    </div>

                    <button 
                        type="button" 
                        onClick={handleSaveDeadlineExtension}
                        className={`w-full py-2.5 rounded-xl font-bold text-white shadow shadow-blue-500/10 transition-all ${
                            extensionMode === 'reject' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
                        }`}
                    >
                        {extensionMode === 'reject' ? 'Confirm Rejection & Set Deadline' : 'Approve Extension'}
                    </button>
                </div>
            </Modal>

            {/* --- VIEW COMPONENT 1: KANBAN BOARD PROFILE --- */}
            {viewMode === 'board' && (
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 pb-12">
                    {COLUMNS.map(col => {
                        const columnTasks = processedTasks.filter(t => getColumnId(t.status) === col.id);
                        return (
                            <div key={col.id} className="flex flex-col min-h-[500px] bg-gray-50 rounded-2xl border border-gray-200 dark:bg-gray-800/40 dark:border-gray-700/80 overflow-hidden shadow-sm">
                                <div className={`${col.color} p-3 text-white shadow-sm`}>
                                    <div className="flex justify-between items-center">
                                        <h3 className="font-bold text-sm tracking-wide">{col.label}</h3>
                                        <span className="bg-white/20 px-2 py-0.5 rounded text-xs font-bold">{columnTasks.length}</span>
                                    </div>
                                </div>
                                <div className="p-3 space-y-3 flex-1 overflow-y-auto max-h-[600px]">
                                    {columnTasks.map(task => <TaskCard key={task.id} task={task} />)}
                                    {columnTasks.length === 0 && <div className="text-center text-gray-400 text-xs py-8 italic">No tasks active</div>}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* --- VIEW COMPONENT 2: TIMELINE GRID PROFILE --- */}
            {viewMode === 'timeline' && (
                <div className="space-y-8 animate-fade-in-down">
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto dark:bg-gray-800 dark:border-gray-700">
                        <div className="min-w-[800px]">
                            <div className="grid grid-cols-8 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50">
                                <div className="p-4 font-bold text-gray-500 text-xs uppercase tracking-wider">Employee</div>
                                {timelineDates.map(date => { 
                                    const d = new Date(date); 
                                    const isWeekend = d.getDay() === 0 || d.getDay() === 6; 
                                    return (
                                        <div key={date} className={`p-3 text-center border-l border-gray-100 dark:border-gray-700 ${isWeekend ? 'bg-gray-100/50 dark:bg-gray-800/30' : ''}`}>
                                            <div className="text-xs text-gray-400 font-bold uppercase">{d.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                                            <div className="text-sm font-bold text-gray-800 dark:text-gray-200">{d.getDate()}</div>
                                        </div>
                                    ); 
                                })}
                            </div>
                            {employeeUsers.map(emp => (
                                <div key={emp.id} className="grid grid-cols-8 border-b border-gray-50 hover:bg-gray-50/50 transition-colors dark:border-gray-700 dark:hover:bg-gray-700/30">
                                    <div className="p-4 flex items-center gap-2">
                                        <UserAvatar user={emp} size="w-6 h-6" textSize="text-xs" />
                                        <span className="text-sm font-bold text-gray-700 truncate dark:text-gray-200">{emp.name.split(' ')[0]}</span>
                                    </div>
                                    {timelineDates.map(date => {
                                        const dailyTasks = processedTasks.filter(t => (t.assigned_to || []).includes(emp.id) && t.due_date === date);
                                        return (
                                            <div key={date} className="border-l border-gray-50 p-1 relative dark:border-gray-700 min-h-[60px]">
                                                {dailyTasks.map(t => {
                                                    const dl = getDeadlineStatus(t.due_date, t.status);
                                                    return (
                                                        <div 
                                                            key={t.id} 
                                                            className={`text-[10px] p-1.5 rounded mb-1 truncate shadow-sm font-semibold border ${
                                                                t.status === 'Approved' 
                                                                ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-300' 
                                                                : (dl === 'Overdue' ? 'bg-red-600 text-white border-red-700 animate-pulse' : 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300')
                                                            }`} 
                                                            title={t.title}
                                                        >
                                                            {t.title}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TasksView;