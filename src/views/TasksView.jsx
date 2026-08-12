import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { supabase } from '../supabaseClient';
import { confirmDialog } from '../utils/confirm';
import Modal from '../components/Modal';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';
import ExportButton from '../components/ExportButton';
import { generateTablePdf } from '../utils/generateTablePdf';
import { checkRateLimit, formatRateLimitMessage } from '../utils/rateLimit';
import { validateTaskSubmissionFile } from '../utils/validateMime';
import { sanitizeTaskSubmissionExtension } from '../utils/sanitize';
import { sanitizeUserInput } from '../utils/sanitize';
import { showUserError } from '../utils/errorHandling';
import { TaskDeadlinePolicy } from '../domain/TaskDeadlinePolicy';
import { getLocalDateString, parseLocalDateOnly } from '../utils/dateOnly';
import { firstError } from '../validation/schemaRegistry';
import { useUndoableAction } from '../patterns/useUndoableAction';
import { canTransitionTo } from '../state-machines/taskWorkflowMachine';
import { evaluateTaskEscalation } from '../rule-engine/taskEscalationRules';
import { useFeatureFlag } from '../feature-flags/useFeatureFlag';

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
const TasksView = ({ userProfile, tasks = [], taskSubmissions = [], allUsers = [], fetchTasks, fetchTaskSubmissions }) => {
    const { t } = useTranslation();
    const { runUndoable } = useUndoableAction();
    const bulkActionsEnabled = useFeatureFlag('bulkActions');
    // 🟩 REVISION TARGET: which assignee a "Revision Needed" request is
    // aimed at -- null/'' means general (applies to every assignee).
    const [revisionTarget, setRevisionTarget] = useState('');
    // --- OPTIMISTIC UI: taskId -> status overlay applied on top of the
    // `tasks` prop while a status-change write is in flight (see
    // handleStatusChange below) ---
    const [optimisticStatusOverrides, setOptimisticStatusOverrides] = useState({});

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
        priority: 'Normal',
        // 🟩 NEW: 'multiple' = every assignee must submit before the task is
        // ready for review (real group work); 'singular' = any ONE of them
        // submitting is enough (duplicate-effort/"whoever gets to it first"
        // assignments). Only meaningfully different once >1 person is
        // assigned -- see migrations/20260805_add_task_submission_mode.sql.
        submission_mode: 'multiple'
    });
    
    // --- TASK EDIT COMPOSER STATE (supervisor-only, locked once 'Completed') ---
    const [editingTask, setEditingTask] = useState(null); // task row currently being edited, or null
    const [editDraft, setEditDraft] = useState({ title: '', description: '', assigned_to: [], due_date: '', priority: 'Normal', submission_mode: 'multiple' });
    const [isSavingEdit, setIsSavingEdit] = useState(false);

    // --- LOCAL FILE HANDLING BUFFER MATRICES ---
    const [selectedFiles, setSelectedFiles] = useState({}); // Indexes files locally before upload validation
    const [uploading, setUploading] = useState(null); // Keeps track of active loading states per row ID

    // 🟩 NEW: Lets the timeline scroll forward/backward instead of being
    // permanently locked to "today + 7 days".
    const [timelineOffsetDays, setTimelineOffsetDays] = useState(0);

    // --- SEARCH FILTERS AND CONTROLS ---
    const [searchTerm, setSearchTerm] = useState('');
    const [filterEmployee, setFilterEmployee] = useState('all');
    const [filterPriority, setFilterPriority] = useState('all');
    const [exportEmployeeId, setExportEmployeeId] = useState('all'); // 🟩 NEW: single-employee export filter

    // --- BULK APPROVAL SELECTION (supervisor only, Completed tasks) ---
    const [selectedTaskIds, setSelectedTaskIds] = useState(new Set());
    const [isBulkApproving, setIsBulkApproving] = useState(false);
    // 🟩 DOUBLE-SUBMIT GUARDS: unlike Contributions/Helpdesk/Leave's create
    // flows, task creation and single-task approval had no in-flight
    // tracking — a double-click fired two inserts (duplicate task rows) or
    // two redundant/racing updates.
    const [isCreatingTask, setIsCreatingTask] = useState(false);
    const [approvingTaskIds, setApprovingTaskIds] = useState(new Set());

    /**
     * UTILITY FUNCTION: getDeadlineStatus
     * PURPOSE: Performs system real-time date evaluation vectors to trigger warning alerts.
     */
    const getDeadlineStatus = (dueDate, status) => TaskDeadlinePolicy.getStatus(dueDate, status);

    // =========================================================================
    // 🔍 ENGINE LOGIC DATA PRE-PROCESSING & FILTER CHANNELS
    // =========================================================================
    // 🟩 PERFORMANCE: this whole pipeline (map -> filter -> map) used to be
    // plain consts recomputed on every render — including on every
    // keystroke in the search box, since the state that drives it lives in
    // this same component. Wrapping each stage in useMemo means typing a
    // character only reruns the stages that actually depend on searchTerm,
    // not the whole chain plus every child render.
    //
    // These live ABOVE the `if (!userProfile) return` guard below, together
    // with every other hook — see that guard's own comment for why hooks
    // can never sit after a conditional return in this component.
    const usersById = useMemo(() => {
        const map = new Map();
        for (const u of (allUsers || [])) map.set(String(u.id), u);
        return map;
    }, [allUsers]);

    const tasksWithOptimisticUpdates = useMemo(() => (tasks || []).map(task =>
        optimisticStatusOverrides[task.id] ? { ...task, status: optimisticStatusOverrides[task.id] } : task
    ), [tasks, optimisticStatusOverrides]);

    // 🟩 PER-ASSIGNEE SUBMISSIONS: task_id -> [{ employee_id, file_path, submitted_at }, ...]
    const submissionsByTask = useMemo(() => {
        const map = new Map();
        for (const sub of (taskSubmissions || [])) {
            if (!map.has(sub.task_id)) map.set(sub.task_id, []);
            map.get(sub.task_id).push(sub);
        }
        return map;
    }, [taskSubmissions]);

    const processedTasks = useMemo(() => tasksWithOptimisticUpdates.filter(t => {
        // 🟩 NULL-SAFETY: description is a nullable column — a task with no
        // description previously crashed this filter (and therefore the
        // whole Kanban/timeline view, for every viewer) the instant it
        // rendered, since `.toLowerCase()` on `undefined`/`null` throws.
        const matchesSearch = (t.title || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                              (t.description || '').toLowerCase().includes(searchTerm.toLowerCase());

        // Security logic: Enforces scope boundaries so interns can never look into others' card files
        const effectiveTargetEmp = userProfile?.role === 'supervisor' ? filterEmployee : userProfile?.id;
        const matchesEmployee = effectiveTargetEmp === 'all' || (t.assigned_to || []).includes(effectiveTargetEmp);
        const matchesPriority = filterPriority === 'all' || t.priority === filterPriority;

        return matchesSearch && matchesEmployee && matchesPriority;
    }), [tasksWithOptimisticUpdates, searchTerm, filterEmployee, filterPriority, userProfile?.role, userProfile?.id]);

    // 🟩 PERFORMANCE: was allUsers.find() per assignee per task (an O(n) scan
    // repeated for every card, every render) — now an O(1) Map lookup.
    const getAssigneeNames = (ids) => {
        if (!ids || !Array.isArray(ids)) return t('tasks.unassigned');
        return ids.map(id => {
            const user = usersById.get(String(id));
            return user ? user.name : t('tasks.unknown');
        }).join(', ');
    };

    // Formats filtered parameters into a sanitized format before generating spreadsheet reports
    const exportData = useMemo(() => processedTasks
        .filter(task => exportEmployeeId === 'all' || (task.assigned_to || []).includes(exportEmployeeId))
        .map(task => ({
        Task: task.title,
        Description: task.description,
        Priority: task.priority,
        Status: task.status,
        "Due Date": task.due_date,
        "Deadline Warning": getDeadlineStatus(task.due_date, task.status),
        "Assigned To": getAssigneeNames(task.assigned_to),
        Feedback: task.feedback || t('tasks.noneFeedback')
    // getAssigneeNames/getDeadlineStatus are plain functions recreated every
    // render; their actual behavior is fully determined by usersById/t,
    // which are already listed — including the functions themselves would
    // invalidate this memo every render and defeat the point of memoizing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    })), [processedTasks, exportEmployeeId, usersById, t]);

    // Generates a 7-day row block array to construct layout cells for the timeline view,
    // shifted by timelineOffsetDays so the view can scroll to other weeks/months.
    const timelineDates = useMemo(() => {
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() + timelineOffsetDays + i);
            // 🟩 TIMEZONE FIX: toISOString() returns the UTC calendar date,
            // which can land on the wrong day relative to `d`'s actual
            // local calendar date depending on the viewer's timezone.
            days.push(getLocalDateString(d));
        }
        return days;
    }, [timelineOffsetDays]);

    // 🟩 PERFORMANCE: the timeline grid used to run
    // `processedTasks.filter(...)` once per (employee × visible day) cell —
    // O(employees × days × tasks), recomputed on every render including
    // unrelated ones (typing in search, an unrelated filter change). This
    // groups tasks by employee+date once per processedTasks change, so each
    // cell is an O(1) Map lookup instead of a full re-scan of every task.
    const tasksByEmployeeAndDate = useMemo(() => {
        const map = new Map();
        for (const t of processedTasks) {
            if (!t.due_date) continue;
            for (const empId of (t.assigned_to || [])) {
                const key = `${empId}|${t.due_date}`;
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(t);
            }
        }
        return map;
    }, [processedTasks]);

    // 🟩 FIX: This guard used to sit ABOVE all the useState calls, which meant
    // React ran 0 hooks while userProfile was still loading and then suddenly
    // ~14 hooks once it resolved — a Rules-of-Hooks violation that throws
    // "Rendered fewer/more hooks than expected" and crashes the view whenever
    // userProfile transitions from null to loaded while this is mounted.
    // Hooks must always run in the same order every render, so the guard now
    // comes after every hook declaration instead of before.
    if (!userProfile) {
        return <div className="p-8 text-gray-500">{t('tasks.initializing')}</div>;
    }

    // Filters active employee roster records for select option loops
    const employeeUsers = (allUsers || []).filter(u => u.role === 'employee');

    // Calculates a dynamic baseline tomorrow constraint string used to validate minimum extension boundaries
    // 🟩 TIMEZONE FIX: toISOString() returns the UTC calendar date, which
    // can silently compute today's date (not tomorrow's) for part of the
    // day depending on the viewer's timezone.
    const tomorrowStr = getLocalDateString(new Date(Date.now() + 86400000));

    // Static layout configuration definitions matching Kanban column rules
    const COLUMNS = [
        { id: 'col_todo', label: t('tasks.colToDo'), color: 'bg-purple-600' },
        { id: 'col_doing', label: t('tasks.colInProgress'), color: 'bg-orange-500' },
        { id: 'col_review', label: t('tasks.colReview'), color: 'bg-pink-500' },
        { id: 'col_done', label: t('tasks.colDone'), color: 'bg-green-500' }
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

    const shiftTimeline = (deltaDays) => setTimelineOffsetDays(prev => prev + deltaDays);
    const resetTimelineToToday = () => setTimelineOffsetDays(0);

    // =========================================================================
    // ⚙️ CORE BACKEND MUTATION CONTROLLERS (SUPABASE DISPATCH PIPELINES)
    // =========================================================================

    /**
     * TRANSACTION: handleCreateTask
     * PURPOSE: Inserts a freshly configured task assignment row into the public database.
     * TELEMETRY: Loops through every selected assignee array slot to dispatch matching workspace notice cards.
     */
    const handleCreateTask = async () => {
        if (isCreatingTask) return;
        // Zod is the real validation engine here (schemaRegistry.taskAssignment);
        // the toast still shows the app's translated generic message so this
        // doesn't regress the i18n coverage with hardcoded English text.
        if (firstError('taskAssignment', newTask)) {
            toast.error(t('tasks.fillRequiredFields'));
            return;
        }
        setIsCreatingTask(true);
        try {
            const { error } = await supabase.from('tasks').insert({
                title: sanitizeUserInput(newTask.title, { maxLength: 150 }),
                description: sanitizeUserInput(newTask.description, { maxLength: 2000 }),
                assigned_to: newTask.assigned_to,
                due_date: newTask.due_date,
                priority: newTask.priority,
                status: 'To Do',
                is_extended: false,
                submission_mode: newTask.assigned_to.length > 1 ? newTask.submission_mode : 'multiple'
            });
            if (error) showUserError('errors.createTask', error);
            else {
                // Notifying assignees is now handled server-side by the
                // notify_task_assigned trigger — the client can no longer
                // insert into notifications directly (RLS).
                toast.success(t('tasks.taskAssignedSuccess'));
                setNewTask({ title: '', description: '', assigned_to: [], due_date: '', priority: 'Normal', submission_mode: 'multiple' });
                setIsModalOpen(false);
                fetchTasks();
            }
        } finally {
            setIsCreatingTask(false);
        }
    };

    /**
     * TRANSACTION: handleApproveTask
     * PURPOSE: Mutates task row status profiles to 'Approved' upon verification.
     * TELEMETRY: Transmits confirmation logs straight to intern notification feeds.
     */
    const handleApproveTask = async (task) => {
        if (approvingTaskIds.has(task.id)) return;
        setApprovingTaskIds((prev) => new Set(prev).add(task.id));
        try {
            const { error } = await supabase
                .from('tasks')
                .update({ status: 'Approved' })
                .eq('id', task.id);

            if (error) {
                showUserError('errors.updateTaskStatus', error);
            } else {
                // Notifying assignees is now handled server-side by the
                // notify_task_status_change trigger — the client can no longer
                // insert into notifications directly (RLS).
                fetchTasks();
            }
        } finally {
            setApprovingTaskIds((prev) => {
                const next = new Set(prev);
                next.delete(task.id);
                return next;
            });
        }
    };

    const toggleTaskSelection = (taskId) => {
        setSelectedTaskIds(prev => {
            const next = new Set(prev);
            if (next.has(taskId)) next.delete(taskId);
            else next.add(taskId);
            return next;
        });
    };

    const handleBulkApproveTasks = async () => {
        if (selectedTaskIds.size === 0) return;
        if (!(await confirmDialog(t('tasks.confirmBulkApprove', { count: selectedTaskIds.size })))) return;

        setIsBulkApproving(true);
        const { error } = await supabase
            .from('tasks')
            .update({ status: 'Approved' })
            .in('id', Array.from(selectedTaskIds));

        if (error) {
            showUserError('errors.bulkApproveTasks', error);
        } else {
            setSelectedTaskIds(new Set());
            await fetchTasks();
        }
        setIsBulkApproving(false);
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
            toast.error(t('tasks.schedulingContradiction'));
            return;
        }

        if (!extensionFeedback.trim()) {
            toast.error(extensionMode === 'reject'
                ? t('tasks.reasonForRevision')
                : t('tasks.reasonForExtension'));
            return;
        }

        const updatePayload = {
            due_date: extensionDate,
            is_extended: true,
            feedback: sanitizeUserInput(extensionFeedback, { maxLength: 1000 })
        };

        if (extensionMode === 'reject') {
            updatePayload.status = 'Revision Needed';
            // 🟩 TARGETED REVISION: empty/'' means general -- every assignee's
            // submission gets cleared and everyone's notified (DB trigger,
            // see migrations/20260805_add_task_submissions.sql). Picking one
            // specific assignee only clears/notifies that person, so their
            // teammates' already-good work isn't thrown out too.
            updatePayload.revision_target_employee_id = revisionTarget || null;
        }

        // Notifying assignees is now handled server-side: a status change
        // (reject) fires notify_task_status_change, a plain extension fires
        // notify_task_extended — the client can no longer insert into
        // notifications directly (RLS).
        const { error } = await supabase.from('tasks').update(updatePayload).eq('id', extensionTask.id);
        if (!error) {
            setIsExtensionModalOpen(false);
            setExtensionTask(null);
            setRevisionTarget('');
            await Promise.all([fetchTasks(), fetchTaskSubmissions?.()]);
        } else {
            showUserError('errors.submitTask', error);
        }
    };

    /**
     * HELPER CALCULATOR: applyPresetDays
     * PURPOSE: Populates calendar inputs using calculated future date preset windows.
     */
    const applyPresetDays = (daysCount) => {
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + daysCount);
        setExtensionDate(getLocalDateString(targetDate));
    };

    const toggleAssignee = (userId) => {
        setNewTask(prev => {
            const current = prev.assigned_to;
            return current.includes(userId)
                ? { ...prev, assigned_to: current.filter(id => id !== userId) }
                : { ...prev, assigned_to: [...current, userId] };
        });
    };

    const toggleEditAssignee = (userId) => {
        setEditDraft(prev => {
            const current = prev.assigned_to;
            return current.includes(userId)
                ? { ...prev, assigned_to: current.filter(id => id !== userId) }
                : { ...prev, assigned_to: [...current, userId] };
        });
    };

    const openEditTask = (task) => {
        setEditingTask(task);
        setEditDraft({
            title: task.title || '',
            description: task.description || '',
            assigned_to: task.assigned_to || [],
            due_date: task.due_date || '',
            priority: task.priority || 'Normal',
            submission_mode: task.submission_mode || 'multiple',
        });
    };

    /**
     * TRANSACTION: handleSaveTaskEdit
     * PURPOSE: Supervisor-only update of an existing task's own fields
     * (title/description/assignees/due date/priority/submission mode) --
     * distinct from handleSaveDeadlineExtension (deadline-only nudge) and
     * the status-transition handlers. Blocked client-side once a task is
     * 'Completed' (see the Edit button's own guard) to preserve that
     * record as-is; RLS already restricts this update to supervisors.
     */
    const handleSaveTaskEdit = async () => {
        if (!editingTask || isSavingEdit) return;
        if (firstError('taskAssignment', editDraft)) {
            toast.error(t('tasks.fillRequiredFields'));
            return;
        }
        setIsSavingEdit(true);
        try {
            const { error } = await supabase.from('tasks').update({
                title: sanitizeUserInput(editDraft.title, { maxLength: 150 }),
                description: sanitizeUserInput(editDraft.description, { maxLength: 2000 }),
                assigned_to: editDraft.assigned_to,
                due_date: editDraft.due_date,
                priority: editDraft.priority,
                submission_mode: editDraft.assigned_to.length > 1 ? editDraft.submission_mode : 'multiple',
            }).eq('id', editingTask.id);

            if (error) showUserError('errors.updateTask', error);
            else {
                toast.success(t('tasks.taskUpdatedSuccess'));
                setEditingTask(null);
                fetchTasks();
            }
        } finally {
            setIsSavingEdit(false);
        }
    };

    const handleFileChange = (e, taskId) => { 
        const currentTask = tasks.find(t => t.id === taskId);
        if (!currentTask?.assigned_to?.includes(userProfile.id)) {
            toast.error(t('tasks.accessDeniedTask'));
            e.target.value = null; 
            return;
        }

        const file = e.target.files?.[0];
        if (!file) return;

        // 🟩 FIX: Validate the moment a file is picked, not just when the user
        // clicks Send. Previously any file type (.exe, .stl, anything) could
        // sit selected with zero feedback until the later Send-time check.
        const validation = validateTaskSubmissionFile(file);
        if (!validation.valid) {
            showUserError('errors.wrongFileType', { message: validation.error });
            e.target.value = null;
            setSelectedFiles(prev => {
                const next = { ...prev };
                delete next[taskId];
                return next;
            });
            return;
        }

        setSelectedFiles(prev => ({ ...prev, [taskId]: file })); 
    };

   const handleFileUpload = async (taskId) => {
        const currentTask = tasks.find(t => t.id === taskId);
        if (!currentTask?.assigned_to?.includes(userProfile.id)) return;

        const file = selectedFiles[taskId];
        if (!file) return;

        const validation = validateTaskSubmissionFile(file);
        if (!validation.valid) {
            showUserError('errors.uploadTaskSubmission', { message: validation.error });
            return;
        }

        const rateLimit = await checkRateLimit('task-submission-upload', { maxRequests: 5, windowSeconds: 30 });
        if (!rateLimit.allowed) {
           toast.error(formatRateLimitMessage(rateLimit.retryAfterMs));
           return;
        }

        setUploading(taskId);
        const ext = sanitizeTaskSubmissionExtension(file.name);
        const filePath = `${userProfile.id}/${taskId}/${Date.now()}.${ext}`;
        
        const { error: uploadError } = await supabase.storage.from('task_submission').upload(filePath, file);
        if (uploadError) {
            showUserError('errors.uploadTaskSubmission', uploadError);
            setUploading(null);
            return;
        }

        // 🟩 PER-ASSIGNEE SUBMISSION: one row per (task, employee) instead of
        // a single shared "the task is done" flag -- a DB trigger only flips
        // the task itself to 'Completed' once every assignee has a row here
        // (see migrations/20260805_add_task_submissions.sql), so a task
        // assigned to several people isn't marked done the moment the FIRST
        // one uploads something.
        const { error: submitError } = await supabase
            .from('task_submissions')
            .upsert(
                { task_id: taskId, employee_id: userProfile.id, file_path: filePath, submitted_at: new Date().toISOString() },
                { onConflict: 'task_id,employee_id' }
            );
        if (submitError) {
            showUserError('errors.markTaskSubmitted', submitError);
            setUploading(null);
            return;
        }

        setSelectedFiles(prev => {
            const next = { ...prev };
            delete next[taskId];
            return next;
        });
        await Promise.all([fetchTasks(), fetchTaskSubmissions?.()]);
        setUploading(null);
    };

    const handleStatusChange = async (taskId, newStatus) => {
        const task = tasks.find(t => t.id === taskId);
        const previousStatus = task?.status;

        if (previousStatus && !canTransitionTo(previousStatus, newStatus)) {
            toast.error(t('tasks.illegalStatusTransition', { from: previousStatus, to: newStatus }));
            return;
        }

        // Optimistic UI: move the card to its new column immediately instead
        // of waiting on the round trip, then reconcile with the real row —
        // rolling the override back out if the write actually fails.
        setOptimisticStatusOverrides(prev => ({ ...prev, [taskId]: newStatus }));

        try {
            await runUndoable({
                label: t('tasks.statusChangedTo', { status: newStatus }),
                do: async () => {
                    await supabase.from('tasks').update({ status: newStatus }).eq('id', taskId);
                    await fetchTasks();
                },
                undo: async () => {
                    await supabase.from('tasks').update({ status: previousStatus }).eq('id', taskId);
                    await fetchTasks();
                },
            }, { undoLabel: t('tasks.undo') });
        } catch (err) {
            showUserError('errors.updateTaskStatus', err);
        } finally {
            // Either fetchTasks() already brought the prop data in line, or the
            // write failed — either way the override has served its purpose.
            setOptimisticStatusOverrides(prev => {
                const next = { ...prev };
                delete next[taskId];
                return next;
            });
        }
    };

    const handleViewSubmission = async (path) => {
        const { data, error } = await supabase.storage.from('task_submission').createSignedUrl(path, 60);
        if (error) {
            showUserError('errors.openSubmittedFile', error);
            return;
        }
        if (data) window.open(data.signedUrl, '_blank');
    };

    // =========================================================================
    // 🧱 UI SUB-RENDER CONTEXTS (CARD MODULES & SHEETS)
    // =========================================================================

    const TaskCard = ({ task }) => {
        const deadlineStatus = getDeadlineStatus(task.due_date, task.status);
        const escalation = evaluateTaskEscalation(task, deadlineStatus);
        const taskSubmissionsList = submissionsByTask.get(task.id) || [];
        const mySubmission = taskSubmissionsList.find(s => s.employee_id === userProfile.id);
        const assigneeCount = (task.assigned_to || []).length;
        const isSingularMode = task.submission_mode === 'singular';
        const requiredSubmissionCount = isSingularMode ? Math.min(1, assigneeCount) : assigneeCount;

        return (
            <div className={`bg-white p-4 rounded-xl border shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3 h-fit dark:bg-gray-800 dark:border-gray-700 ${
                task.status === 'Revision Needed' 
                ? 'border-l-4 border-l-red-500' 
                : (deadlineStatus === 'Overdue' ? 'border-l-4 border-l-red-600 dark:border-l-red-500' : 'border-gray-200')
            }`}>
                
                {/* STATUS BADGES FLEX LAYOUT ROW */}
                <div className="flex flex-wrap items-center gap-1.5">
                    {bulkActionsEnabled && userProfile.role === 'supervisor' && task.status === 'Completed' && (
                        <input
                            type="checkbox"
                            checked={selectedTaskIds.has(task.id)}
                            onChange={() => toggleTaskSelection(task.id)}
                            aria-label={t('tasks.selectForBulkApprove')}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-3.5 w-3.5"
                        />
                    )}
                    <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md border ${getPriorityStyle(task.priority)}`}>
                        {task.priority}
                    </span>

                    {task.is_extended && (
                        <span className="text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-900/50 px-2 py-0.5 rounded-md tracking-wide shadow-sm flex items-center gap-1">
                            {t('tasks.extended')}
                        </span>
                    )}

                    {task.status === 'Revision Needed' && (
                        <span className="text-[10px] font-bold bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900/50 px-2 py-0.5 rounded-md flex items-center gap-1">
                            {t('tasks.needsFix')}
                        </span>
                    )}
                    {deadlineStatus === 'Overdue' && (
                        <span className="text-[10px] font-bold bg-red-100 text-red-700 border border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900 px-2 py-0.5 rounded-md tracking-wide animate-pulse flex items-center gap-1">
                            {t('tasks.overdue')}
                        </span>
                    )}
                    {deadlineStatus === 'Near Deadline' && (
                        <span className="text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900/50 px-2 py-0.5 rounded-md flex items-center gap-1">
                            {t('tasks.dueSoon')}
                        </span>
                    )}
                    {escalation?.action.severity === 'critical' && (
                        <span className="text-[10px] font-bold bg-red-600 text-white px-2 py-0.5 rounded-md tracking-wide shadow-sm flex items-center gap-1" title={t('tasks.escalationCriticalHint')}>
                            🚨 {t('tasks.escalationCritical')}
                        </span>
                    )}
                </div>

                {/* Card Title Content Block */}
                <div>
                    <h4 className="font-bold text-gray-800 text-sm mb-1 dark:text-gray-100 leading-snug">{task.title}</h4>
                    <div className={`text-xs flex items-center gap-1 font-medium ${deadlineStatus === 'Overdue' ? 'text-red-500 font-bold' : 'text-gray-500 dark:text-gray-400'}`}>
                        <span>{t('tasks.due', { date: task.due_date })}</span>
                    </div>
                    {task.feedback && task.status === 'Revision Needed' && (
                        <div className="mt-2 text-xs bg-red-50 text-red-600 p-2 rounded border border-red-100 italic dark:bg-red-900/10 dark:text-red-400 dark:border-red-900/30">
                            {t('tasks.supervisorFeedback', { feedback: task.feedback })}
                        </div>
                    )}
                </div>

                {/* 🟩 GROUP SUBMISSION PROGRESS: only meaningful once more than
                    one person is assigned -- shows who's submitted so far
                    instead of the task just silently sitting there while
                    teammates are still working. Supervisors get a link to
                    each individual file as it comes in, not just once
                    everyone's done. */}
                {assigneeCount > 1 && task.status !== 'Approved' && (
                    <div className="text-[10px] bg-gray-50 dark:bg-gray-900/40 border border-gray-100 dark:border-gray-700 rounded-lg p-2 space-y-1">
                        <div className="font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide flex items-center gap-1.5">
                            <span>{isSingularMode
                                ? (taskSubmissionsList.length > 0 ? t('tasks.submissionProgressSingularDone') : t('tasks.submissionProgressSingularPending'))
                                : t('tasks.submissionProgress', { done: taskSubmissionsList.length, total: requiredSubmissionCount })}
                            </span>
                            {isSingularMode && (
                                <span className="normal-case font-semibold text-gray-400 dark:text-gray-500" title={t('tasks.submissionModeSingularHint')}>
                                    ({t('tasks.submissionModeSingular')})
                                </span>
                            )}
                        </div>
                        {userProfile.role === 'supervisor' && (
                            <ul className="space-y-0.5">
                                {(task.assigned_to || []).map(uid => {
                                    const u = usersById.get(String(uid));
                                    const sub = taskSubmissionsList.find(s => s.employee_id === uid);
                                    if (isSingularMode && !sub) return null; // singular mode: no point showing everyone as "pending" when only one submission was ever needed
                                    return (
                                        <li key={uid} className="flex items-center justify-between gap-2">
                                            <span className="text-gray-600 dark:text-gray-300 truncate">{sub ? '✅' : '⏳'} {u?.name || t('tasks.unknown')}</span>
                                            {sub && (
                                                <button onClick={() => handleViewSubmission(sub.file_path)} className="text-blue-600 dark:text-blue-400 font-bold underline shrink-0">
                                                    {t('tasks.viewFile')}
                                                </button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                )}

                {/* Bottom Profile Mapping & Inline Action Triggers */}
                <div className="mt-2 pt-3 border-t border-gray-100 flex justify-between items-center dark:border-gray-700">
                    <div className="flex -space-x-2">
                        {(task.assigned_to || []).map(uid => {
                            const u = usersById.get(String(uid));
                            return <UserAvatar key={uid} user={u} size="w-6 h-6" textSize="text-[9px]" />;
                        })}
                    </div>
                    
                    <div className="flex gap-1.5 text-xs font-bold items-center">
                        {userProfile.role !== 'supervisor' && (
                            <>
                                {task.status === 'To Do' && <button onClick={() => handleStatusChange(task.id, 'In Progress')} className="text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-1 rounded dark:bg-blue-900/20 dark:text-blue-400">{t('tasks.start')}</button>}
                                {(task.status === 'In Progress' || task.status === 'Revision Needed') && (
                                    mySubmission ? (
                                        // 🟩 Already submitted their part -- a multi-assignee task
                                        // only becomes 'Completed' once EVERY assignee has, so
                                        // this person is just waiting on their teammates now.
                                        <span className="text-gray-400 italic font-medium text-[11px]">{t('tasks.waitingForTeammates')}</span>
                                    ) : (
                                        <label className="cursor-pointer text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-1 rounded dark:bg-blue-900/20 dark:text-blue-400">
                                            {uploading === task.id ? '...' : (task.status === 'Revision Needed' ? t('tasks.reUpload') : t('tasks.upload'))}
                                            <input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" className="hidden" onChange={(e) => handleFileChange(e, task.id)} />
                                            {selectedFiles[task.id] && <button onClick={() => handleFileUpload(task.id)} className="ml-1 underline font-bold text-indigo-600 dark:text-indigo-400">{t('tasks.send')}</button>}
                                        </label>
                                    )
                                )}
                                {task.status === 'Completed' && <span className="text-gray-400 italic font-medium">{t('tasks.waiting')}</span>}
                            </>
                        )}
                        {mySubmission && (
                            <button onClick={() => handleViewSubmission(mySubmission.file_path)} className="text-gray-600 hover:text-gray-900 dark:text-gray-300 font-semibold underline">{t('tasks.viewFile')}</button>
                        )}
                        {/* Legacy single-file tasks from before per-assignee submissions existed */}
                        {!mySubmission && task.submitted_file_path && (
                            <button onClick={() => handleViewSubmission(task.submitted_file_path)} className="text-gray-600 hover:text-gray-900 dark:text-gray-300 font-semibold underline">{t('tasks.viewFile')}</button>
                        )}

                        {/* Master Supervisor Action Controls Matrix */}
                        {userProfile.role === 'supervisor' && task.status === 'Completed' && (
                            <>
                                <button onClick={() => handleApproveTask(task)} disabled={approvingTaskIds.has(task.id)} className="text-green-600 hover:text-green-800 font-bold bg-green-50 px-2 py-1 rounded dark:bg-green-900/20 dark:text-green-400 disabled:opacity-50 disabled:cursor-not-allowed">{t('tasks.approve')}</button>
                                <button onClick={() => {
                                    setExtensionTask(task);
                                    setExtensionDate(tomorrowStr);
                                    setExtensionFeedback('');
                                    setExtensionMode('reject');
                                    setRevisionTarget('');
                                    setIsExtensionModalOpen(true);
                                }} className="text-red-600 hover:text-red-800 bg-red-50 px-2 py-1 rounded dark:bg-red-900/20 dark:text-red-400">{t('tasks.reject')}</button>
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
                                {t('tasks.extend')}
                            </button>
                        )}

                        {/* 🟩 NEW: full edit (title/description/assignees/due date/
                            priority/submission mode), not just status transitions or a
                            deadline nudge -- per revision feedback, supervisors need
                            flexibility to correct task details after creation. Locked
                            out once 'Completed' to preserve that record as-is. */}
                        {userProfile.role === 'supervisor' && task.status !== 'Completed' && (
                            <button
                                type="button"
                                onClick={() => openEditTask(task)}
                                className="text-indigo-600 hover:text-indigo-800 bg-indigo-50 dark:bg-indigo-950/40 dark:text-indigo-300 px-2 py-1 rounded font-bold border border-indigo-200 dark:border-indigo-900/50 transition-all active:scale-95"
                            >
                                {t('tasks.editTask')}
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
                    <span className="text-xs text-gray-400 font-medium">{t('tasks.tasksCount', { done, total })}</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2.5 dark:bg-gray-700">
                    <div className="bg-blue-600 h-2.5 rounded-full transition-all duration-500" style={{ width: `${percentage}%` }}></div>
                </div>
                <div className="flex justify-between text-xs font-bold mt-1">
                    <span className="text-blue-600">{t('tasks.percentComplete', { percent: percentage })}</span>
                </div>
            </div>
        );
    };

    return (
        <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6">
            
            {/* --- LAYOUT HEADER CONTROLS --- */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-gray-200 dark:border-gray-700 pb-4 gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">{t('tasks.title')}</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{t('tasks.subtitle')}</p>
                </div>

                <div className="flex flex-wrap gap-2 items-center w-full md:w-auto justify-end">
                    {userProfile.role === 'supervisor' && (
                        <>
                            <select
                                value={exportEmployeeId}
                                onChange={(e) => setExportEmployeeId(e.target.value)}
                                className="text-xs font-bold bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-xl px-2 py-2 focus:outline-none focus:border-blue-500"
                            >
                                <option value="all">{t('tasks.allEmployees')}</option>
                                {employeeUsers.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                            </select>
                            <ExportButton data={exportData} filename={exportEmployeeId === 'all' ? "Handpicked_Task_Report" : `Tasks_${employeeUsers.find(e => e.id === exportEmployeeId)?.name || 'Employee'}`} label={t('tasks.exportHandPicked')} />
                            <button
                                type="button"
                                onClick={() => generateTablePdf({
                                    title: t('tasks.title'),
                                    subtitle: exportEmployeeId === 'all' ? t('tasks.allEmployees') : employeeUsers.find(e => e.id === exportEmployeeId)?.name || '',
                                    columns: [
                                        { key: 'Task', label: t('tasks.taskTitle') },
                                        { key: 'Priority', label: t('tasks.priority') },
                                        { key: 'Status', label: t('tasks.status') },
                                        { key: 'Due Date', label: t('tasks.dueDate') },
                                        { key: 'Deadline Warning', label: t('tasks.deadlineWarning') },
                                        { key: 'Assigned To', label: t('tasks.assignedTo') },
                                        { key: 'Feedback', label: t('tasks.feedback') },
                                    ],
                                    rows: exportData,
                                    filename: exportEmployeeId === 'all' ? 'Task_Report' : `Tasks_${employeeUsers.find(e => e.id === exportEmployeeId)?.name || 'Employee'}`,
                                })}
                                className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg shadow-sm transition-all text-sm border border-red-700"
                                title={t('common.exportPdf')}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                                {t('common.exportPdf')}
                            </button>
                        </>
                    )}

                    <div className="flex gap-2 bg-gray-100 p-1 rounded-xl dark:bg-gray-700 border dark:border-gray-600">
                        <button type="button" onClick={() => setViewMode('board')} className={`px-4 py-1.5 text-xs font-bold rounded-lg transition-all ${viewMode === 'board' ? 'bg-white shadow text-blue-600 dark:bg-gray-600 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>{t('tasks.board')}</button>
                        <button type="button" onClick={() => setViewMode('timeline')} className={`px-4 py-1.5 text-xs font-bold rounded-lg transition-all ${viewMode === 'timeline' ? 'bg-white shadow text-blue-600 dark:bg-gray-600 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>{t('tasks.timeline')}</button>
                    </div>

                    {userProfile.role === 'supervisor' && (
                        <button type="button" onClick={() => setIsModalOpen(true)} className="bg-blue-700 hover:bg-blue-800 text-white text-xs font-bold py-2.5 px-4 rounded-xl shadow-sm transition">
                            {t('tasks.assignTask')}
                        </button>
                    )}
                </div>
            </div>

            {/* --- CONTROL PANEL FILTERS BAR --- */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700">
                <div>
                    <label htmlFor="task-search" className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('tasks.searchKeywords')}</label>
                    <input
                        id="task-search"
                        type="text"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder={t('tasks.filterByTitle')}
                        className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-700 dark:text-white"
                    />
                </div>

                <div>
                    <label htmlFor="task-filter-employee" className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('tasks.assignedStaff')}</label>
                    {userProfile.role === 'supervisor' ? (
                        <select
                            id="task-filter-employee"
                            value={filterEmployee}
                            onChange={(e) => setFilterEmployee(e.target.value)}
                            className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-700 dark:text-white"
                        >
                            <option value="all">{t('tasks.allStaff')}</option>
                            {employeeUsers.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                        </select>
                    ) : (
                        <input
                            id="task-filter-employee"
                            type="text"
                            disabled
                            value={userProfile.name}
                            className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed"
                        />
                    )}
                </div>

                <div>
                    <label htmlFor="task-filter-priority" className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('tasks.taskPriority')}</label>
                    <select
                        id="task-filter-priority"
                        value={filterPriority}
                        onChange={(e) => setFilterPriority(e.target.value)}
                        className="w-full p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50 dark:bg-gray-700 dark:text-white"
                    >
                        <option value="all">{t('tasks.allPriorities')}</option>
                        <option value="High">{t('tasks.priorityHigh')}</option>
                        <option value="Normal">{t('tasks.priorityNormal')}</option>
                        <option value="Low">{t('tasks.priorityLow')}</option>
                    </select>
                </div>
            </div>

            {/* --- BULK APPROVAL ACTION BAR (supervisor, appears once tasks are checked) --- */}
            {bulkActionsEnabled && userProfile.role === 'supervisor' && selectedTaskIds.size > 0 && (
                <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-2xl px-4 py-3">
                    <span className="text-xs font-bold text-blue-700 dark:text-blue-300">
                        {t('tasks.selectedCount', { count: selectedTaskIds.size })}
                    </span>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => setSelectedTaskIds(new Set())}
                            className="text-xs font-bold text-gray-500 hover:text-gray-700 dark:text-gray-400 px-3 py-1.5"
                        >
                            {t('tasks.clearSelection')}
                        </button>
                        <button
                            type="button"
                            onClick={handleBulkApproveTasks}
                            disabled={isBulkApproving}
                            className="text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-1.5 rounded-xl shadow-sm"
                        >
                            {isBulkApproving ? t('tasks.processing') : t('tasks.approveSelected')}
                        </button>
                    </div>
                </div>
            )}

            {/* --- CREATION MODAL CONTAINER --- */}
            <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={t('tasks.newTaskAssignment')}>
                <div className="space-y-4">
                    <div>
                        <label htmlFor="new-task-title" className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.taskTitle')}</label>
                        <input id="new-task-title" type="text" value={newTask.title} onChange={e => setNewTask({...newTask, title: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"/>
                    </div>
                    <div>
                        <label htmlFor="new-task-description" className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.description')}</label>
                        <textarea id="new-task-description" value={newTask.description} onChange={e => setNewTask({...newTask, description: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white resize-none" rows="2"></textarea>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label htmlFor="new-task-priority" className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.priority')}</label>
                            <select id="new-task-priority" value={newTask.priority} onChange={e => setNewTask({...newTask, priority: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                                <option value="Low">{t('tasks.low')}</option>
                                <option value="Normal">{t('tasks.normal')}</option>
                                <option value="High">{t('tasks.high')}</option>
                            </select>
                        </div>
                        <div>
                             <label htmlFor="new-task-due-date" className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.dueDate')}</label>
                             <input id="new-task-due-date" type="date" value={newTask.due_date} onChange={e => setNewTask({...newTask, due_date: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"/>
                        </div>
                    </div>
                    <div>
                        <span className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.assignees')}</span>
                        <div className="mt-1 border border-gray-300 rounded max-h-32 overflow-y-auto p-2 bg-gray-50 dark:bg-gray-700 dark:border-gray-600">
                            {employeeUsers.map(emp => (
                                <label key={emp.id} className="flex items-center space-x-2 p-1 hover:bg-gray-200 rounded cursor-pointer dark:hover:bg-gray-600">
                                    <input type="checkbox" checked={newTask.assigned_to.includes(emp.id)} onChange={() => toggleAssignee(emp.id)} />
                                    <span className="text-sm dark:text-gray-200">{emp.name}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    {/* 🟩 NEW: only meaningful once more than one person is picked
                        above -- a solo-assigned task behaves identically either way. */}
                    {newTask.assigned_to.length > 1 && (
                        <div>
                            <span className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.submissionMode')}</span>
                            <div className="mt-1 space-y-1.5">
                                <label className="flex items-start gap-2 p-2 border border-gray-300 dark:border-gray-600 rounded cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700">
                                    <input type="radio" name="submission-mode" className="mt-0.5" checked={newTask.submission_mode === 'multiple'} onChange={() => setNewTask({ ...newTask, submission_mode: 'multiple' })} />
                                    <span>
                                        <span className="block text-sm font-bold dark:text-gray-200">{t('tasks.submissionModeMultiple')}</span>
                                        <span className="block text-[11px] text-gray-500 dark:text-gray-400">{t('tasks.submissionModeMultipleHint')}</span>
                                    </span>
                                </label>
                                <label className="flex items-start gap-2 p-2 border border-gray-300 dark:border-gray-600 rounded cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700">
                                    <input type="radio" name="submission-mode" className="mt-0.5" checked={newTask.submission_mode === 'singular'} onChange={() => setNewTask({ ...newTask, submission_mode: 'singular' })} />
                                    <span>
                                        <span className="block text-sm font-bold dark:text-gray-200">{t('tasks.submissionModeSingular')}</span>
                                        <span className="block text-[11px] text-gray-500 dark:text-gray-400">{t('tasks.submissionModeSingularHint')}</span>
                                    </span>
                                </label>
                            </div>
                        </div>
                    )}

                    <button type="button" onClick={handleCreateTask} disabled={isCreatingTask} className="w-full bg-blue-700 text-white font-bold py-2 rounded text-sm hover:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed">{t('tasks.confirmAssignment')}</button>
                </div>
            </Modal>

            {/* --- EDIT TASK MODAL: same fields as creation, bound to editDraft
                instead of newTask -- supervisor-only, not offered once a task
                is 'Completed' (see the Edit button's own guard on TaskCard). --- */}
            <Modal isOpen={!!editingTask} onClose={() => setEditingTask(null)} title={t('tasks.editTaskTitle')}>
                <div className="space-y-4">
                    <div>
                        <label htmlFor="edit-task-title" className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.taskTitle')}</label>
                        <input id="edit-task-title" type="text" value={editDraft.title} onChange={e => setEditDraft({...editDraft, title: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"/>
                    </div>
                    <div>
                        <label htmlFor="edit-task-description" className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.description')}</label>
                        <textarea id="edit-task-description" value={editDraft.description} onChange={e => setEditDraft({...editDraft, description: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white resize-none" rows="2"></textarea>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label htmlFor="edit-task-priority" className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.priority')}</label>
                            <select id="edit-task-priority" value={editDraft.priority} onChange={e => setEditDraft({...editDraft, priority: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                                <option value="Low">{t('tasks.low')}</option>
                                <option value="Normal">{t('tasks.normal')}</option>
                                <option value="High">{t('tasks.high')}</option>
                            </select>
                        </div>
                        <div>
                             <label htmlFor="edit-task-due-date" className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.dueDate')}</label>
                             <input id="edit-task-due-date" type="date" value={editDraft.due_date} onChange={e => setEditDraft({...editDraft, due_date: e.target.value})} className="w-full p-2 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"/>
                        </div>
                    </div>
                    <div>
                        <span className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.assignees')}</span>
                        <div className="mt-1 border border-gray-300 rounded max-h-32 overflow-y-auto p-2 bg-gray-50 dark:bg-gray-700 dark:border-gray-600">
                            {employeeUsers.map(emp => (
                                <label key={emp.id} className="flex items-center space-x-2 p-1 hover:bg-gray-200 rounded cursor-pointer dark:hover:bg-gray-600">
                                    <input type="checkbox" checked={editDraft.assigned_to.includes(emp.id)} onChange={() => toggleEditAssignee(emp.id)} />
                                    <span className="text-sm dark:text-gray-200">{emp.name}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    {editDraft.assigned_to.length > 1 && (
                        <div>
                            <span className="text-xs font-bold text-gray-700 uppercase dark:text-gray-200">{t('tasks.submissionMode')}</span>
                            <div className="mt-1 space-y-1.5">
                                <label className="flex items-start gap-2 p-2 border border-gray-300 dark:border-gray-600 rounded cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700">
                                    <input type="radio" name="edit-submission-mode" className="mt-0.5" checked={editDraft.submission_mode === 'multiple'} onChange={() => setEditDraft({ ...editDraft, submission_mode: 'multiple' })} />
                                    <span>
                                        <span className="block text-sm font-bold dark:text-gray-200">{t('tasks.submissionModeMultiple')}</span>
                                        <span className="block text-[11px] text-gray-500 dark:text-gray-400">{t('tasks.submissionModeMultipleHint')}</span>
                                    </span>
                                </label>
                                <label className="flex items-start gap-2 p-2 border border-gray-300 dark:border-gray-600 rounded cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700">
                                    <input type="radio" name="edit-submission-mode" className="mt-0.5" checked={editDraft.submission_mode === 'singular'} onChange={() => setEditDraft({ ...editDraft, submission_mode: 'singular' })} />
                                    <span>
                                        <span className="block text-sm font-bold dark:text-gray-200">{t('tasks.submissionModeSingular')}</span>
                                        <span className="block text-[11px] text-gray-500 dark:text-gray-400">{t('tasks.submissionModeSingularHint')}</span>
                                    </span>
                                </label>
                            </div>
                        </div>
                    )}

                    <button type="button" onClick={handleSaveTaskEdit} disabled={isSavingEdit} className="w-full bg-indigo-700 text-white font-bold py-2 rounded text-sm hover:bg-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed">{isSavingEdit ? t('tasks.saving') : t('tasks.saveChanges')}</button>
                </div>
            </Modal>

            {/* --- TIMELINE ADJUSTMENT / REVISION CONTROL PANEL MODAL --- */}
            <Modal
                isOpen={isExtensionModalOpen}
                onClose={() => { setIsExtensionModalOpen(false); setExtensionTask(null); setRevisionTarget(''); }}
                title={extensionMode === 'reject' ? t('tasks.flagRevisionRequired') : t('tasks.grantBreathingRoom')}
            >
                <div className="space-y-4 text-xs">
                    <div>
                        <label htmlFor="extension-feedback" className="block font-bold text-gray-400 uppercase tracking-wider mb-1">
                            {extensionMode === 'reject' ? t('tasks.reasonForRevisionNotes') : t('tasks.reasonForExtensionLabel')}
                        </label>
                        <textarea
                            id="extension-feedback"
                            required
                            value={extensionFeedback}
                            onChange={(e) => setExtensionFeedback(e.target.value)}
                            placeholder={extensionMode === 'reject'
                                ? t('tasks.revisionPlaceholder')
                                : t('tasks.extensionPlaceholder')}
                            className="w-full p-2.5 border rounded-xl dark:bg-gray-700 dark:border-gray-600 dark:text-white resize-none focus:outline-none"
                            rows="3"
                        />
                    </div>

                    {/* 🟩 TARGETED REVISION: only meaningful for a task with more
                        than one assignee -- picking a specific person only clears
                        and re-requests THEIR submission, leaving teammates who
                        already did their part alone instead of throwing
                        everyone's work out for one person's mistake. */}
                    {extensionMode === 'reject' && (extensionTask?.assigned_to || []).length > 1 && (
                        <div>
                            <label htmlFor="revision-target" className="block font-bold text-gray-400 uppercase tracking-wider mb-1">{t('tasks.revisionTarget')}</label>
                            <select
                                id="revision-target"
                                value={revisionTarget}
                                onChange={(e) => setRevisionTarget(e.target.value)}
                                className="w-full p-2.5 border rounded-xl dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none"
                            >
                                <option value="">{t('tasks.revisionTargetGeneral')}</option>
                                {(extensionTask?.assigned_to || []).map(uid => {
                                    const u = usersById.get(String(uid));
                                    return <option key={uid} value={uid}>{u?.name || t('tasks.unknown')}</option>;
                                })}
                            </select>
                        </div>
                    )}

                    <div>
                        <label htmlFor="extension-date" className="block font-bold text-gray-400 uppercase tracking-wider mb-1">{t('tasks.selectExtendedDueDate')}</label>
                        <input
                            id="extension-date"
                            type="date"
                            required
                            min={tomorrowStr}
                            value={extensionDate}
                            onChange={(e) => setExtensionDate(e.target.value)}
                            className="w-full p-2.5 border rounded-xl dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                    </div>

                    <div>
                        <span className="block font-bold text-gray-400 uppercase tracking-wider mb-1.5">{t('tasks.quickDatePresets')}</span>
                        <div className="flex gap-2">
                            <button type="button" onClick={() => applyPresetDays(1)} className="flex-1 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 p-2 rounded-lg font-bold text-[10px] transition-colors dark:text-white">{t('tasks.tomorrow')}</button>
                            <button type="button" onClick={() => applyPresetDays(3)} className="flex-1 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 p-2 rounded-lg font-bold text-[10px] transition-colors dark:text-white">{t('tasks.plus3Days')}</button>
                            <button type="button" onClick={() => applyPresetDays(7)} className="flex-1 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 p-2 rounded-lg font-bold text-[10px] transition-colors dark:text-white">{t('tasks.plus1Week')}</button>
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={handleSaveDeadlineExtension}
                        className={`w-full py-2.5 rounded-xl font-bold text-white shadow shadow-blue-500/10 transition-all ${
                            extensionMode === 'reject' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
                        }`}
                    >
                        {extensionMode === 'reject' ? t('tasks.confirmRejection') : t('tasks.approveExtension')}
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
                                    {columnTasks.length === 0 && <EmptyState icon={Icons.ClipboardList} title={t('tasks.noTasksActive')} className="py-6" />}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* --- VIEW COMPONENT 2: TIMELINE GRID PROFILE --- */}
            {viewMode === 'timeline' && (
                <div className="space-y-8 animate-fade-in-down">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white dark:bg-gray-800 p-3 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
                        <span className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                            {new Date(timelineDates[0]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — {new Date(timelineDates[6]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <button type="button" onClick={() => shiftTimeline(-30)} className="px-2.5 py-1.5 text-[11px] font-bold rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition">{t('tasks.monthBack')}</button>
                            <button type="button" onClick={() => shiftTimeline(-7)} className="px-2.5 py-1.5 text-[11px] font-bold rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition">{t('tasks.weekBack')}</button>
                            <button type="button" onClick={resetTimelineToToday} className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition">{t('tasks.today')}</button>
                            <button type="button" onClick={() => shiftTimeline(7)} className="px-2.5 py-1.5 text-[11px] font-bold rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition">{t('tasks.weekForward')}</button>
                            <button type="button" onClick={() => shiftTimeline(30)} className="px-2.5 py-1.5 text-[11px] font-bold rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition">{t('tasks.monthForward')}</button>
                        </div>
                    </div>
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto dark:bg-gray-800 dark:border-gray-700">
                        <div className="min-w-[800px]">
                            <div className="grid grid-cols-8 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50">
                                <div className="p-4 font-bold text-gray-500 text-xs uppercase tracking-wider">{t('tasks.employeeCol')}</div>
                                {timelineDates.map(date => {
                                    const d = parseLocalDateOnly(date);
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
                                        const dailyTasks = tasksByEmployeeAndDate.get(`${emp.id}|${date}`) || [];
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