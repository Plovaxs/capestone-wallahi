import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../supabaseClient';
import { showUserError } from '../utils/errorHandling';
import { useDraftAutosave, loadDraft, clearDraft } from '../hooks/useDraftAutosave';

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

    const visibleTickets = helpdeskTickets
        .filter(t => statusFilter === 'all' || t.ticket_status === statusFilter)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const openCount = helpdeskTickets.filter(t => t.ticket_status === 'Open').length;

    const toggleProblemType = (type) => {
        setSelectedProblemTypes(prev =>
            prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
        );
    };

    // Handle creating a new ticket (network call to Supabase)
    const handleCreateTicket = async () => {
        if (!newTitle.trim() || !newContent.trim()) return;
        setIsSubmitting(true);
        const { error } = await supabase.from('helpdesk_tickets').insert({
            employee_id: userProfile.id,
            title: newTitle.trim(),
            contribution: newContent.trim(),
            category: ticketCategory,
            problem_types: selectedProblemTypes,
        });
        if (error) {
            showUserError('Failed to file ticket', error);
        } else {
            setNewTitle('');
            setNewContent('');
            setSelectedProblemTypes([]);
            if (draftKey) clearDraft(draftKey);
            fetchHelpdeskTickets();
        }
        setIsSubmitting(false);
    };

    const handleChangeStatus = async (ticketId, newStatus) => {
        const { error } = await supabase
            .from('helpdesk_tickets')
            .update({ ticket_status: newStatus })
            .eq('id', ticketId);
        if (error) {
            showUserError('Failed to update ticket status', error);
        } else {
            fetchHelpdeskTickets();
        }
    };

    const handleSendReply = async (ticketId) => {
        const message = (replyInputs[ticketId] || '').trim();
        if (!message) return;
        setSubmittingReplyId(ticketId);
        const { error } = await supabase
            .from('helpdesk_replies')
            .insert({ ticket_id: ticketId, author_id: userProfile.id, message });
        if (error) {
            showUserError('Failed to send reply', error);
        } else {
            setReplyInputs(prev => ({ ...prev, [ticketId]: '' }));
            fetchHelpdeskTickets();
        }
        setSubmittingReplyId(null);
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

            {/* --- TICKET LIST --- */}
            <div className="space-y-4">
                {visibleTickets.length === 0 && (
                    <div className="text-center py-12 text-gray-400 text-sm italic">
                        {t('helpdesk.noTickets')} {statusFilter === 'Open' && t('helpdesk.nothingUrgent')}
                    </div>
                )}

                {visibleTickets.map(ticket => {
                    const status = ticket.ticket_status;
                    const tagStyle = TICKET_CATEGORIES.find(c => c.name === ticket.category)?.color || '';

                    return (
                        <div key={ticket.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700 p-5">

                            {/* Author + timestamp */}
                            <div className="flex items-start justify-between gap-3 mb-1">
                                <span className="text-xs font-bold text-gray-500 dark:text-gray-400">{ticket.employee_name}</span>
                                <span className="text-[10px] text-gray-400 whitespace-nowrap">
                                    {new Date(ticket.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
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

                            {/* Supervisor-only status control */}
                            {userProfile?.role === 'supervisor' && (
                                <div className="flex gap-2 mb-3">
                                    {STATUS_ORDER.map(s => (
                                        <button
                                            key={s}
                                            type="button"
                                            disabled={status === s}
                                            onClick={() => handleChangeStatus(ticket.id, s)}
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
                            {ticket.replies.length > 0 && (
                                <div className="space-y-2 mb-3 pl-3 border-l-2 border-gray-100 dark:border-gray-700">
                                    {ticket.replies.map(r => (
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