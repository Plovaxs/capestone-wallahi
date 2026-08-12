import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../supabaseClient';
import { showUserError } from '../utils/errorHandling';
import { useDraftAutosave, loadDraft, clearDraft } from '../hooks/useDraftAutosave';
import { sanitizeUserInput } from '../utils/sanitize';
import { checkRateLimit, formatRateLimitMessage } from '../utils/rateLimit';
import toast from 'react-hot-toast';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';

// --- PROBLEM TYPE CHECKLIST OPTIONS (stored values stay in English; display labels are translated) ---
const PROBLEM_TYPES = ['Hardware', 'Software', 'Git Control', 'Workflow', 'Additional Resource'];
const PROBLEM_TYPE_KEYS = {
    'Hardware': 'problemHardware',
    'Software': 'problemSoftware',
    'Git Control': 'problemGitControl',
    'Workflow': 'problemWorkflow',
    'Additional Resource': 'problemAdditionalResource',
};

const HelpdeskView = ({ userProfile, helpdeskTickets = [], fetchHelpdeskTickets }) => {
    const { t } = useTranslation();
    const [newTitle, setNewTitle] = useState('');
    const [newContent, setNewContent] = useState('');
    const [ticketCategory, setTicketCategory] = useState('Help Request ❓');
    const [selectedProblemTypes, setSelectedProblemTypes] = useState([]);
    const [replyInputs, setReplyInputs] = useState({});
    const [statusFilter, setStatusFilter] = useState('Open');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submittingReplyId, setSubmittingReplyId] = useState(null);
    const [changingStatusId, setChangingStatusId] = useState(null);
    // 🟩 BULK ACTIONS (supervisor only): mirrors LeaveView's bulk-approve
    // pattern -- a Set of selected ticket ids + a bulk action bar, instead
    // of clicking "mark status" one ticket at a time when clearing out a
    // backlog of e.g. 20 stale "Open" tickets.
    const [selectedTicketIds, setSelectedTicketIds] = useState(new Set());
    const [isBulkUpdating, setIsBulkUpdating] = useState(false);

    // --- DRAFT AUTOSAVE (ticket composer only — replies are short-lived and not worth persisting) ---
    const draftKey = userProfile?.id ? `draft:helpdesk-ticket:${userProfile.id}` : null;
    const hasRestoredDraft = useRef(false);
    useEffect(() => {
        if (!draftKey || hasRestoredDraft.current) return;
        hasRestoredDraft.current = true;
        const saved = loadDraft(draftKey);
        if (saved) {
            setNewTitle(saved.newTitle || '');
            setNewContent(saved.newContent || '');
            setTicketCategory(saved.ticketCategory || 'Help Request ❓');
            setSelectedProblemTypes(saved.selectedProblemTypes || []);
        }
    }, [draftKey]);
    useDraftAutosave(draftKey, { newTitle, newContent, ticketCategory, selectedProblemTypes });

    const TICKET_CATEGORIES = [
        { name: 'Help Request ❓', color: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800' },
        { name: 'Urgent Blocker 🚨', color: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800' },
    ];

    const STATUS_STYLES = {
        'Open': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
        'In Progress': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
        'Resolved': 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    };
    const STATUS_ORDER = ['Open', 'In Progress', 'Resolved'];
    const STATUS_LABEL_KEYS = { 'Open': 'statusOpen', 'In Progress': 'statusInProgress', 'Resolved': 'statusResolved' };
    const getStatusLabel = (status) => t(`helpdesk.${STATUS_LABEL_KEYS[status]}`);

    // 🟩 PERFORMANCE: unmemoized, this re-sorted/re-filtered the full
    // ticket list on every render -- including every keystroke typed into
    // the new-ticket title/content fields or any per-ticket reply box
    // (all sibling state in this same component).
    const visibleTickets = useMemo(
        () => helpdeskTickets
            .filter(t => statusFilter === 'all' || t.ticket_status === statusFilter)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
        [helpdeskTickets, statusFilter]
    );

    // Clear stale selections when the filter changes so the bulk bar never
    // silently acts on tickets that are no longer even visible.
    useEffect(() => {
        setSelectedTicketIds(new Set());
    }, [statusFilter]);

    const openCount = useMemo(
        () => helpdeskTickets.filter(t => t.ticket_status === 'Open').length,
        [helpdeskTickets]
    );

    const toggleProblemType = (type) => {
        setSelectedProblemTypes(prev =>
            prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
        );
    };

    // Handle creating a new ticket (network call to Supabase)
    const handleCreateTicket = async () => {
        if (!newTitle.trim() || !newContent.trim()) return;
        setIsSubmitting(true);
        try {
            // 🟩 SECURITY: this view's ticket/reply creation was the one
            // free-text submission path in the app with no rate limit (its
            // structural twin, ContributionsView's forum posts, already has
            // one) -- nothing stopped a scripted flood of ticket creates.
            const rateLimit = await checkRateLimit('helpdesk-ticket', { maxRequests: 5, windowSeconds: 60 });
            if (!rateLimit.allowed) {
                toast.error(formatRateLimitMessage(rateLimit.retryAfterMs));
                return;
            }
            const { error } = await supabase.from('helpdesk_tickets').insert({
                employee_id: userProfile.id,
                // 🟩 Consistency fix: every other free-text field in the app
                // (Contributions, Leave, Tasks) runs through sanitizeUserInput
                // (control-char stripping + a length clamp) before insert;
                // this was the one place still just doing a bare `.trim()`.
                title: sanitizeUserInput(newTitle, { maxLength: 150 }),
                contribution: sanitizeUserInput(newContent, { maxLength: 2000 }),
                category: ticketCategory,
                problem_types: selectedProblemTypes,
            });
            if (error) {
                showUserError('errors.fileTicket', error);
            } else {
                setNewTitle('');
                setNewContent('');
                setSelectedProblemTypes([]);
                if (draftKey) clearDraft(draftKey);
                fetchHelpdeskTickets();
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    // 🟩 A ticket's own submitter previously had no way to mark their own
    // ticket In Progress/Resolved at all -- the "mark status" buttons were
    // supervisor-only, which was confusing ("gatau cara nge determine
    // tugas nya") for someone who, say, fixed their own blocker and wanted
    // to close it out themselves. Supervisors can still manage any ticket;
    // an employee can now also manage tickets they filed.
    const canManageTicketStatus = (ticket) => userProfile.role === 'supervisor' || ticket?.employee_id === userProfile.id;

    const handleChangeStatus = async (ticket, newStatus) => {
        // 🟩 Defense-in-depth: the "mark status" buttons are only rendered
        // for authorized users in the JSX, but this handler itself had no
        // guard -- any employee could call it directly (devtools/console)
        // with an arbitrary ticketId and close/reopen anyone's ticket. Real
        // enforcement is the RLS/trigger on helpdesk_tickets server-side;
        // this is just the client-side mirror of the same rule. Also adds
        // the in-flight guard + try/finally every other mutation in this
        // file already had, so a thrown network error can't leave the
        // status button stuck disabled forever.
        if (!canManageTicketStatus(ticket) || changingStatusId === ticket.id) return;
        const ticketId = ticket.id;
        setChangingStatusId(ticketId);
        try {
            const { error } = await supabase
                .from('helpdesk_tickets')
                .update({ ticket_status: newStatus })
                .eq('id', ticketId);
            if (error) {
                showUserError('errors.updateTicketStatus', error);
            } else {
                fetchHelpdeskTickets();
            }
        } finally {
            setChangingStatusId(null);
        }
    };

    const toggleTicketSelection = (ticketId) => {
        setSelectedTicketIds(prev => {
            const next = new Set(prev);
            if (next.has(ticketId)) next.delete(ticketId);
            else next.add(ticketId);
            return next;
        });
    };

    // 🟩 Same in-a-loop-of-direct-supabase-calls shape as handleChangeStatus
    // (and LeaveView's handleBulkApproveLeave) -- no batch-update RPC exists
    // for this table, and each row is independent so a partial failure
    // (network blip mid-loop) just leaves the remaining tickets un-updated
    // rather than corrupting anything.
    const handleBulkChangeStatus = async (newStatus) => {
        if (isBulkUpdating || selectedTicketIds.size === 0) return;
        setIsBulkUpdating(true);
        let succeeded = 0;
        let failed = 0;
        try {
            for (const ticketId of selectedTicketIds) {
                const { error } = await supabase.from('helpdesk_tickets').update({ ticket_status: newStatus }).eq('id', ticketId);
                if (error) failed++; else succeeded++;
            }
            if (succeeded > 0) toast.success(t('helpdesk.bulkStatusSuccess', { count: succeeded, status: getStatusLabel(newStatus) }));
            if (failed > 0) toast.error(t('helpdesk.bulkStatusPartialFailure', { count: failed }));
            setSelectedTicketIds(new Set());
            fetchHelpdeskTickets();
        } finally {
            setIsBulkUpdating(false);
        }
    };

    const handleSendReply = async (ticketId) => {
        const message = sanitizeUserInput(replyInputs[ticketId], { maxLength: 1000 });
        if (!message) return;
        setSubmittingReplyId(ticketId);
        try {
            const rateLimit = await checkRateLimit('helpdesk-reply', { maxRequests: 10, windowSeconds: 60 });
            if (!rateLimit.allowed) {
                toast.error(formatRateLimitMessage(rateLimit.retryAfterMs));
                return;
            }
            const { error } = await supabase
                .from('helpdesk_replies')
                .insert({ ticket_id: ticketId, author_id: userProfile.id, message });
            if (error) {
                showUserError('errors.sendReply', error);
            } else {
                setReplyInputs(prev => ({ ...prev, [ticketId]: '' }));
                fetchHelpdeskTickets();
            }
        } finally {
            setSubmittingReplyId(null);
        }
    };

    return (
        <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">

            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-gray-800 dark:text-white">{t('helpdesk.title')}</h1>
                    <p className="text-xs text-gray-400 dark:text-gray-500 font-medium">
                        {userProfile?.role === 'supervisor'
                            ? t('helpdesk.supervisorSubtitle')
                            : t('helpdesk.employeeSubtitle')}
                    </p>
                </div>
                {openCount > 0 && (
                    <span className="px-3 py-1.5 rounded-full text-xs font-bold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                        {t('helpdesk.openCount', { count: openCount })}
                    </span>
                )}
            </div>

            {/* --- NEW TICKET COMPOSER --- */}
            <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700 space-y-3">

                {/* Title — separate from content */}
                <div>
                    <label htmlFor="ticket-title" className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('helpdesk.ticketTitle')}</label>
                    <input
                        id="ticket-title"
                        type="text"
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                        placeholder={t('helpdesk.titlePlaceholder')}
                        className="w-full p-2.5 border border-gray-200 rounded-xl text-sm font-bold focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 dark:bg-gray-900/40 dark:border-gray-600 dark:text-white"
                    />
                </div>

                {/* Content — the description */}
                <div>
                    <label htmlFor="ticket-details" className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('helpdesk.details')}</label>
                    <textarea
                        id="ticket-details"
                        value={newContent}
                        onChange={(e) => setNewContent(e.target.value)}
                        placeholder={t('helpdesk.detailsPlaceholder')}
                        className="w-full p-3 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 dark:bg-gray-900/40 dark:border-gray-600 dark:text-white"
                        rows="3"
                    />
                </div>

                {/* Problem type checklist */}
                <div>
                    <span className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">{t('helpdesk.typeOfProblem')}</span>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {PROBLEM_TYPES.map(type => (
                            <label key={type} className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-gray-600 dark:text-gray-300">
                                <input
                                    type="checkbox"
                                    checked={selectedProblemTypes.includes(type)}
                                    onChange={() => toggleProblemType(type)}
                                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-3.5 w-3.5"
                                />
                                {t(`helpdesk.${PROBLEM_TYPE_KEYS[type]}`)}
                            </label>
                        ))}
                    </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                    <select
                        value={ticketCategory}
                        onChange={(e) => setTicketCategory(e.target.value)}
                        className="text-xs font-bold p-2 border border-gray-200 rounded-lg dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none"
                    >
                        {TICKET_CATEGORIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                    <button
                        type="button"
                        onClick={handleCreateTicket}
                        disabled={!newTitle.trim() || !newContent.trim() || isSubmitting}
                        className="px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
                    >
                        {t('helpdesk.fileTicket')}
                    </button>
                </div>
            </div>

            {/* --- STATUS FILTER TABS --- */}
            <div className="flex gap-2">
                {['Open', 'In Progress', 'Resolved', 'all'].map(s => (
                    <button
                        key={s}
                        type="button"
                        onClick={() => setStatusFilter(s)}
                        className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
                            statusFilter === s
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-400'
                        }`}
                    >
                        {s === 'all' ? t('helpdesk.all') : getStatusLabel(s)}
                    </button>
                ))}
            </div>

            {/* --- BULK ACTION BAR (supervisor only) --- */}
            {userProfile.role === 'supervisor' && selectedTicketIds.size > 0 && (
                <div className="flex items-center justify-between gap-3 flex-wrap bg-blue-50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900/40 rounded-2xl px-4 py-3">
                    <span className="text-xs font-bold text-blue-700 dark:text-blue-300">
                        {t('helpdesk.selectedCount', { count: selectedTicketIds.size })}
                    </span>
                    <div className="flex items-center gap-2 flex-wrap">
                        {STATUS_ORDER.map(s => (
                            <button
                                key={s}
                                type="button"
                                disabled={isBulkUpdating}
                                onClick={() => handleBulkChangeStatus(s)}
                                className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-white dark:bg-gray-800 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50"
                            >
                                {t('helpdesk.markStatus', { status: getStatusLabel(s) })}
                            </button>
                        ))}
                        <button
                            type="button"
                            onClick={() => setSelectedTicketIds(new Set())}
                            disabled={isBulkUpdating}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold text-gray-500 hover:text-gray-700 dark:text-gray-400 disabled:opacity-50"
                        >
                            {t('common.cancel')}
                        </button>
                    </div>
                </div>
            )}

            {/* --- TICKET LIST --- */}
            <div className="space-y-4">
                {visibleTickets.length === 0 && (
                    <EmptyState
                        icon={Icons.LifeBuoy}
                        title={t('helpdesk.noTickets')}
                        description={statusFilter === 'Open' ? t('helpdesk.nothingUrgent') : undefined}
                    />
                )}

                {visibleTickets.map(ticket => {
                    const status = ticket.ticket_status;
                    const tagStyle = TICKET_CATEGORIES.find(c => c.name === ticket.category)?.color || '';

                    return (
                        <div key={ticket.id} className={`bg-white rounded-2xl shadow-sm border p-5 dark:bg-gray-800 ${selectedTicketIds.has(ticket.id) ? 'border-blue-300 dark:border-blue-700 ring-1 ring-blue-200 dark:ring-blue-800' : 'border-gray-100 dark:border-gray-700'}`}>

                            {/* Author + timestamp */}
                            <div className="flex items-start justify-between gap-3 mb-1">
                                <div className="flex items-center gap-2">
                                    {userProfile.role === 'supervisor' && (
                                        <input
                                            type="checkbox"
                                            checked={selectedTicketIds.has(ticket.id)}
                                            onChange={() => toggleTicketSelection(ticket.id)}
                                            aria-label={t('helpdesk.selectTicket')}
                                            className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                                        />
                                    )}
                                    <span className="text-xs font-bold text-gray-500 dark:text-gray-400">{ticket.employee_name}</span>
                                </div>
                                <span className="text-[10px] text-gray-400 whitespace-nowrap">
                                    {/* 🟩 FIX: was reading `ticket.date`, a column that's never
                                        actually set on insert (handleCreateTicket doesn't send
                                        one) -- always rendered "Invalid Date". The sort logic
                                        just above already correctly uses `created_at`; this now
                                        matches it. */}
                                    {new Date(ticket.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                </span>
                            </div>

                            {/* Title — separate from content, rendered prominently */}
                            <h3 className="text-base font-bold text-gray-800 dark:text-gray-100 mb-2">{ticket.title}</h3>

                            {/* Category, status, and problem-type tags */}
                            <div className="flex items-center gap-2 flex-wrap mb-3">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${tagStyle}`}>{ticket.category}</span>
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATUS_STYLES[status]}`}>{getStatusLabel(status)}</span>
                                {(ticket.problem_types || []).map(pt => (
                                    <span key={pt} className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-600 border border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600">
                                        {PROBLEM_TYPE_KEYS[pt] ? t(`helpdesk.${PROBLEM_TYPE_KEYS[pt]}`) : pt}
                                    </span>
                                ))}
                            </div>

                            {/* Content */}
                            <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap leading-relaxed mb-3">
                                {ticket.contribution}
                            </p>

                            {/* Status control: available to supervisors (any ticket) and to the employee who filed this specific ticket */}
                            {canManageTicketStatus(ticket) && (
                                <div className="flex gap-2 mb-3">
                                    {STATUS_ORDER.map(s => (
                                        <button
                                            key={s}
                                            type="button"
                                            disabled={status === s || changingStatusId === ticket.id}
                                            onClick={() => handleChangeStatus(ticket, s)}
                                            className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-colors disabled:opacity-40 disabled:cursor-default ${
                                                status === s
                                                    ? STATUS_STYLES[s]
                                                    : 'bg-white text-gray-400 border-gray-200 hover:bg-gray-50 dark:bg-gray-900/40 dark:border-gray-600'
                                            }`}
                                        >
                                            {t('helpdesk.markStatus', { status: getStatusLabel(s) })}
                                        </button>
                                    ))}
                                </div>
                            )}

                            {/* Replies */}
                            {(ticket.replies || []).length > 0 && (
                                <div className="space-y-2 mb-3 pl-3 border-l-2 border-gray-100 dark:border-gray-700">
                                    {(ticket.replies || []).map(r => (
                                        <div key={r.id} className="text-xs">
                                            <span className="font-bold text-gray-700 dark:text-gray-200">{r.author_name}</span>
                                            <span className="text-gray-500 dark:text-gray-400"> — {r.message}</span>
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={replyInputs[ticket.id] || ''}
                                    onChange={(e) => setReplyInputs(prev => ({ ...prev, [ticket.id]: e.target.value }))}
                                    onKeyPress={(e) => e.key === 'Enter' && handleSendReply(ticket.id)}
                                    placeholder={t('helpdesk.replyPlaceholder')}
                                    aria-label={t('helpdesk.replyPlaceholder')}
                                    className="flex-1 p-2 text-xs border border-gray-200 rounded-lg dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none"
                                />
                                <button
                                    type="button"
                                    onClick={() => handleSendReply(ticket.id)}
                                    disabled={!(replyInputs[ticket.id] || '').trim() || submittingReplyId === ticket.id}
                                    className="px-3 py-2 text-xs font-bold text-blue-600 hover:text-blue-800 disabled:opacity-40"
                                >
                                    {t('helpdesk.send')}
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default HelpdeskView;