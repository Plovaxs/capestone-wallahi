import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { supabase } from '../supabaseClient';
import { checkRateLimit, formatRateLimitMessage } from '../utils/rateLimit';
import { showUserError } from '../utils/errorHandling';
import { sanitizeUserInput } from '../utils/sanitize';
import { confirmDialog } from '../utils/confirm';
import { useDraftAutosave, loadDraft, clearDraft } from '../hooks/useDraftAutosave';
import { firstError } from '../validation/schemaRegistry';
import { useTypingIndicator } from '../realtime/useTypingIndicator';
import { getLocalDateString } from '../utils/dateOnly';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';

/**
 * COMPONENT: ContributionsView
 * PURPOSE: Interactive Intern Discussion Forum and shared Help Desk platform.
 * DESIGN PATTERN: Flattened thread timeline mapping nested comment nodes via a single JSONB array column.
 * SECURITY: Enforces item-level role tracking so employees can only eliminate rows they personally created.
 */
const ContributionsView = ({ userProfile, contributions = [], allUsers = [], fetchContributions }) => {
    const { t } = useTranslation();
    // --- POST COMPOSER FORUM STATES ---
    const [newPost, setNewPost] = useState('');
    const [newTitle, setNewTitle] = useState('');
    const [category, setCategory] = useState('General Discussion');
    const [isSubmitting, setIsSubmitting] = useState(false);

    // --- DRAFT AUTOSAVE (new thread composer only — replies are short-lived and not worth persisting) ---
    const draftKey = userProfile?.id ? `draft:forum-thread:${userProfile.id}` : null;
    const hasRestoredDraft = useRef(false);
    useEffect(() => {
        if (!draftKey || hasRestoredDraft.current) return;
        hasRestoredDraft.current = true;
        const saved = loadDraft(draftKey);
        if (saved) {
            setNewPost(saved.newPost || '');
            setNewTitle(saved.newTitle || '');
            setCategory(saved.category || 'General Discussion');
        }
    }, [draftKey]);
    useDraftAutosave(draftKey, { newPost, newTitle, category });

    // --- LIVE TYPING INDICATOR (new thread composer, shared room) ---
    const { typingNames, broadcastTyping } = useTypingIndicator('forum-composer', userProfile);

    // --- NESTED COMMENT TRACKING ENGINE BUFFERS ---
    const [replyInputs, setReplyInputs] = useState({}); // Stores key-value tracking texts per card ID
    const [submittingReplyId, setSubmittingReplyId] = useState(null); // Local loading state for reply dispatches

    // --- INLINE POST EDIT TRACKING (typo/fix support for the original author) ---
    const [editingPostId, setEditingPostId] = useState(null);
    const [editPostText, setEditPostText] = useState('');

    // --- TIMELINE FILTER SELECTION CONTROLS ---
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedCategory, setSelectedCategory] = useState('all');

    // Sanitized forum tags mapping consistent aesthetic border configurations
    const FORUM_CATEGORIES = [
        { name: 'General Discussion', color: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600', active: 'bg-blue-600 text-white border-blue-600' },
        { name: 'Project Milestone 🎉', color: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-300 dark:border-purple-800', active: 'bg-purple-600 text-white border-purple-600' },
    ];

    // --- UTILITY USER DICTIONARY MATCHERS ---
    // 🟩 PERFORMANCE: was an O(n) allUsers.find() per post/reply per render;
    // a Map built once per allUsers change turns every lookup into O(1).
    const usersById = useMemo(() => {
        const map = new Map();
        for (const u of allUsers) map.set(String(u.id), u);
        return map;
    }, [allUsers]);
    // 🟩 useCallback so filteredThreads's own memoization below (which
    // depends on this function) doesn't recompute every render just
    // because a plain function literal gets a new identity each time.
    const getUserName = useCallback((id) => usersById.get(String(id))?.name || t('contributions.unknownUser'), [usersById, t]);
    const getUserRole = (id) => usersById.get(String(id))?.role || 'employee';

    // =========================================================================
    // ⚙️ BACKEND MUTATION PIPELINES (SUPABASE TRANSACTION CONTROLLERS)
    // =========================================================================

    /**
     * TRANSACTION: handleCreateTask (Thread Composer Pipeline)
     * PURPOSE: Inserts a brand new global discussion topic row onto the board.
     * SCHEMA METRICS: Instantiates an empty `replies: []` array field block natively on row creation.
     */
const handleCreateThread = async () => {
        // Zod (schemaRegistry.forumPost) is the real validation engine; the
        // toast still shows the app's translated message, not a raw English one.
        if (firstError('forumPost', { title: newTitle, contribution: newPost, category })) {
            toast.error(t('contributions.emptyPostError'));
            return;
        }
        setIsSubmitting(true);
        try {
            const rateLimit = await checkRateLimit('forum-post', { maxRequests: 5, windowSeconds: 60 });
           if (!rateLimit.allowed) {
               toast.error(formatRateLimitMessage(rateLimit.retryAfterMs));
               return;
           }

            const { error } = await supabase.from('contributions').insert({
                employee_id: userProfile.id,
                date: getLocalDateString(),
                title: newTitle.trim() ? sanitizeUserInput(newTitle, { maxLength: 150 }) : null,
                contribution: sanitizeUserInput(newPost, { maxLength: 2000 }),
                category: category
            });

            if (error) {
                showUserError('errors.createPost', error);
                return;
            }

            setNewPost('');
            setNewTitle('');
            if (draftKey) clearDraft(draftKey);
            fetchContributions();
        } catch (error) {
            showUserError('errors.createPost', error);
        } finally {
            setIsSubmitting(false);
        }
    };

    /**
     * TRANSACTION: handleDeleteThread
     * PURPOSE: Performs target parameter match removals on public.contributions.
     * SECURITY: Database will drop instructions if Row-Level Security checks validate unauthorized parameters.
     */
    const handleDeleteThread = async (postId) => {
        if (!(await confirmDialog(t('contributions.confirmDelete'), { variant: 'danger' }))) return;
        
        const { error } = await supabase
            .from('contributions')
            .delete()
            .eq('id', postId);

        if (error) {
            showUserError('errors.deleteThread', error);
        } else {
            fetchContributions(); // Refresh live view feeds state cache
        }
    };

    /**
     * TRANSACTION: handleEditThread
     * PURPOSE: Lets the original author fix typos in their own thread's opening message.
     */
    const handleEditThread = async (postId) => {
        if (!editPostText.trim()) return;

        const { error } = await supabase
            .from('contributions')
            .update({ contribution: sanitizeUserInput(editPostText, { maxLength: 2000 }) })
            .eq('id', postId);

        if (error) {
            showUserError('errors.updatePost', error);
        } else {
            setEditingPostId(null);
            setEditPostText('');
            fetchContributions();
        }
    };

    /**
     * TRANSACTION: handleSendReply
     * PURPOSE: Appends a newly compiled nested object matrix into the matching row array.
     * CRITICAL LOGIC: Pulls current cached comment references, expands the dataset with a distinct 
     * randomized reply node key pointer, and performs an absolute row update mutation payload.
     */
    const handleSendReply = async (postId) => {
        const text = replyInputs[postId];
        if (!text || !text.trim()) return;

        setSubmittingReplyId(postId);

        const rateLimit = await checkRateLimit('forum-reply', { maxRequests: 10, windowSeconds: 60 });
       if (!rateLimit.allowed) {
           toast.error(formatRateLimitMessage(rateLimit.retryAfterMs));
           setSubmittingReplyId(null);
           return;
       }
        
        const { error } = await supabase
         .from('contribution_replies')
         .insert({ post_id: postId, author_id: userProfile.id, message: sanitizeUserInput(text, { maxLength: 1000 }) });

        if (error) {
            showUserError('errors.submitReply', error);
        } else {
            // Flushes the specific input buffer target field trace cleanly upon success
            setReplyInputs(prev => ({ ...prev, [postId]: '' })); 
            fetchContributions();
        }
        setSubmittingReplyId(null);
    };

    // =========================================================================
    // 🔍 REAL-TIME SEARCH INDEX FILTER PIPELINES
    // =========================================================================
    // Help Request / Urgent Blocker now live exclusively in the Helpdesk
    // menu — excluded here so the general forum stays general-discussion-only.
    // 🟩 PERFORMANCE: unmemoized, these re-filtered the full contributions
    // array on every render -- typing in the new-thread composer, typing in
    // any post's reply box, toggling edit mode, or the shared typing-
    // indicator broadcast, not just when searchTerm/selectedCategory
    // actually change.
    const generalThreads = useMemo(
        () => contributions.filter(post =>
            !(post.category || '').includes('Help') && !(post.category || '').includes('Blocker')
        ),
        [contributions]
    );

    const filteredThreads = useMemo(
        () => generalThreads.filter(post => {
            const matchesSearch = post.contribution.toLowerCase().includes(searchTerm.toLowerCase()) ||
                                 (post.title || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                                 getUserName(post.employee_id).toLowerCase().includes(searchTerm.toLowerCase());
            const matchesCategory = selectedCategory === 'all' || post.category === selectedCategory;
            return matchesSearch && matchesCategory;
        }),
        [generalThreads, searchTerm, selectedCategory, getUserName]
    );

    return (
        <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
            
            {/* --- LAYOUT HEADER CONTROLS --- */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-200 dark:border-gray-700 pb-4">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
                        {t('contributions.title')}
                    </h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                        {t('contributions.subtitle')}
                    </p>
                </div>

                {/* TIMELINE FILTERS CONTAINER WRAPPERS */}
                <div className="flex gap-2 w-full md:w-auto">
                    <input
                        type="text"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder={t('contributions.searchPlaceholder')}
                        className="p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-white dark:bg-gray-800 dark:text-white w-full md:w-56 shadow-sm"
                    />
                    <select
                        value={selectedCategory}
                        onChange={(e) => setSelectedCategory(e.target.value)}
                        className="p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-white dark:bg-gray-800 dark:text-white shadow-sm"
                    >
                        <option value="all">{t('contributions.allChannels')}</option>
                        {FORUM_CATEGORIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                </div>
            </div>

            {/* --- COMPOSER TOP INPUT SHEET PANEL WIDGET --- */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
                <div className="p-5">
                    <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                        <span className="w-1 h-3.5 bg-blue-500 rounded-full"></span>
                        {t('contributions.startNewThread')}
                    </h3>

                    <div className="flex flex-col gap-3">
                        <input
                            type="text"
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                            className="w-full p-3 border border-gray-100 rounded-xl text-sm font-bold bg-gray-50/50 focus:bg-white focus:ring-4 focus:ring-blue-500/5 focus:border-blue-500 transition-all dark:bg-gray-900/40 dark:border-gray-600 dark:text-white dark:focus:bg-gray-900"
                            placeholder={t('contributions.titlePlaceholder')}
                            aria-label={t('contributions.titlePlaceholder')}
                        />
                        <textarea
                            value={newPost}
                            onChange={(e) => { setNewPost(e.target.value); broadcastTyping(); }}
                            className="w-full p-4 border border-gray-100 rounded-xl text-xs bg-gray-50/50 focus:bg-white focus:ring-4 focus:ring-blue-500/5 focus:border-blue-500 transition-all resize-none dark:bg-gray-900/40 dark:border-gray-600 dark:text-white dark:focus:bg-gray-900"
                            placeholder={t('contributions.postPlaceholder')}
                            aria-label={t('contributions.postPlaceholder')}
                            rows="3"
                        ></textarea>
                        {typingNames.length > 0 && (
                            <p className="text-[11px] italic text-blue-500 dark:text-blue-400 -mt-2">
                                {t('contributions.someoneIsTyping', { names: typingNames.join(', ') })}
                            </p>
                        )}

                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                            <div className="flex flex-wrap gap-1.5">
                                {FORUM_CATEGORIES.map(cat => {
                                    const isSelected = category === cat.name;
                                    return (
                                        <button 
                                            key={cat.name} 
                                            type="button"
                                            onClick={() => setCategory(cat.name)}
                                            className={`px-3 py-1.5 rounded-xl text-[11px] font-bold border transition-all duration-150 ${
                                                isSelected ? cat.active + ' shadow-sm' : cat.color + ' hover:opacity-80'
                                            }`}
                                        >
                                            {cat.name}
                                        </button>
                                    );
                                })}
                            </div>

                            <button 
                                onClick={handleCreateThread} 
                                disabled={!newPost.trim() || isSubmitting}
                                className={`w-full sm:w-auto px-5 py-2 rounded-xl text-xs font-bold text-white transition-all shadow ${
                                    !newPost.trim() ? 'bg-gray-300 cursor-not-allowed dark:bg-gray-700' : 'bg-blue-600 hover:bg-blue-700 active:scale-95'
                                }`}
                            >
                                {isSubmitting ? t('contributions.posting') : t('contributions.publishThread')}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* --- MASTER FORUM TIMELINE FEEDS RENDER LOOP --- */}
            <div className="space-y-4">
                {filteredThreads.map(post => {
                    const postReplies = post.replies || [];
                    const isHelpRequest = post.category.includes('Help') || post.category.includes('Blocker');
                    
                    // SECURITY VERIFICATION LOGIC: Grants removal credentials if administrative role parameters 
                    // evaluate to 'supervisor', or if the current token session user matches the initial thread creator index
                    const canDelete = userProfile.role === 'supervisor' || String(post.employee_id) === String(userProfile.id);
                    const canEdit = String(post.employee_id) === String(userProfile.id);

                    return (
                        <div key={post.id} className={`bg-white dark:bg-gray-800 rounded-2xl border shadow-sm p-5 space-y-4 dark:border-gray-700/60 ${
                            isHelpRequest ? 'border-l-4 border-l-amber-500 dark:border-l-amber-500' : 'border-gray-100'
                        }`}>
                            {/* Card Parent Header Context Blocks */}
                            <div className="flex justify-between items-start gap-4">
                                <div className="flex items-center gap-3">
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                                        getUserRole(post.employee_id) === 'supervisor' ? 'bg-gradient-to-tr from-yellow-500 to-amber-600 text-slate-900' : 'bg-blue-100 text-blue-600 dark:bg-slate-700 dark:text-blue-400'
                                    }`}>
                                        {getUserName(post.employee_id).charAt(0)}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h4 className="font-bold text-gray-800 text-sm dark:text-gray-100">{getUserName(post.employee_id)}</h4>
                                            {getUserRole(post.employee_id) === 'supervisor' && (
                                                <span className="text-[9px] font-extrabold tracking-wider uppercase bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 px-1.5 py-0.5 rounded border border-amber-200">{t('contributions.supervisor')}</span>
                                            )}
                                        </div>
                                        <p className="text-[10px] font-bold text-gray-400 font-mono uppercase">{t('contributions.threadStarted', { date: post.date })}</p>
                                    </div>
                                </div>
                                
                                {/* INTERACTION ACTION CONTROLS LAYOUT */}
                                <div className="flex items-center gap-2">
                                    <span className={`inline-block px-2.5 py-1 rounded-xl text-[10px] font-extrabold uppercase tracking-wide border ${
                                        FORUM_CATEGORIES.find(c => c.name === post.category)?.color || 'bg-gray-100 text-gray-600'
                                    }`}>
                                        {post.category}
                                    </span>

                                    {/* RENDERS INLINE EDIT TOGGLE ONLY FOR THE ORIGINAL AUTHOR */}
                                    {canEdit && (
                                        <button
                                            type="button"
                                            onClick={() => { setEditingPostId(post.id); setEditPostText(post.contribution); }}
                                            className="p-1.5 text-gray-400 hover:text-blue-500 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                                            title={t('contributions.editPost')}
                                            aria-label={t('contributions.editPost')}
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                            </svg>
                                        </button>
                                    )}

                                    {/* RENDERS INTERACTION TRASH CONTROLS ONLY IF AUTHORIZATION CHECKS PASS */}
                                    {canDelete && (
                                        <button
                                            type="button"
                                            onClick={() => handleDeleteThread(post.id)}
                                            className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                                            title={t('contributions.deleteThread')}
                                            aria-label={t('contributions.deleteThread')}
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                            </svg>
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Thread Title (optional — older posts and quick posts may not have one) */}
                            {post.title && (
                                <h3 className="font-bold text-gray-800 dark:text-gray-100 text-sm pl-1">{post.title}</h3>
                            )}

                            {/* Core Initial Message Thread Box */}
                            {editingPostId === post.id ? (
                                <div className="space-y-2 pl-1">
                                    <textarea
                                        value={editPostText}
                                        onChange={(e) => setEditPostText(e.target.value)}
                                        className="w-full p-3 border border-blue-200 rounded-xl text-xs md:text-sm bg-blue-50/30 focus:bg-white focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 transition-all resize-none dark:bg-gray-900/40 dark:border-blue-700 dark:text-white"
                                        rows="3"
                                    />
                                    <div className="flex gap-2 justify-end">
                                        <button
                                            type="button"
                                            onClick={() => { setEditingPostId(null); setEditPostText(''); }}
                                            className="px-3 py-1.5 text-[11px] font-bold text-gray-500 hover:text-gray-700 dark:text-gray-400 rounded-lg"
                                        >
                                            {t('contributions.cancel')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleEditThread(post.id)}
                                            disabled={!editPostText.trim()}
                                            className="px-3 py-1.5 text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
                                        >
                                            {t('contributions.saveChanges')}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <p className="text-gray-700 dark:text-gray-200 text-xs md:text-sm whitespace-pre-wrap pl-1 leading-relaxed">
                                    {post.contribution}
                                </p>
                            )}

                            {/* --- NESTED SUB-COMMENT REPLIES ACCORDION FEED --- */}
                            {postReplies.length > 0 && (
                                <div className="bg-gray-50/50 dark:bg-gray-900/30 rounded-xl p-4 border dark:border-gray-700/60 divide-y divide-gray-100 dark:divide-gray-700 space-y-3">
                                    {postReplies.map((reply) => (
                                        <div key={reply.id} className="pt-3 first:pt-0 flex gap-3 items-start">
                                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                                                getUserRole(reply.author_id) === 'supervisor' ? 'bg-amber-500 text-slate-900' : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                                            }`}>
                                                {getUserName(reply.author_id).charAt(0)}
                                            </div>
                                            <div className="space-y-0.5 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-bold text-gray-800 dark:text-gray-200">{getUserName(reply.author_id)}</span>
                                                    {getUserRole(reply.author_id) === 'supervisor' && (
                                                        <span className="text-[8px] font-bold bg-amber-500/20 text-amber-700 px-1 rounded">{t('contributions.staff')}</span>
                                                    )}
                                                    <span className="text-[9px] text-gray-400 font-medium ml-auto font-mono">{reply.timestamp}</span>
                                                </div>
                                                <p className="text-gray-600 dark:text-gray-300 text-xs leading-relaxed">{reply.message}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* --- INLINE TRANSACTIONAL COMMENT FOOTER INPUT --- */}
                            <div className="pt-3 border-t border-gray-50 dark:border-gray-700 flex gap-2">
                                <input 
                                    type="text"
                                    value={replyInputs[post.id] || ''}
                                    onChange={(e) => setReplyInputs(prev => ({ ...prev, [post.id]: e.target.value }))}
                                    onKeyPress={(e) => e.key === 'Enter' && handleSendReply(post.id)}
                                    placeholder={userProfile.role === 'supervisor' ? t('contributions.guidancePlaceholder') : t('contributions.commentPlaceholder')}
                                    aria-label={userProfile.role === 'supervisor' ? t('contributions.guidancePlaceholder') : t('contributions.commentPlaceholder')}
                                    className="flex-1 p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50/50 dark:bg-gray-900/40 dark:text-white"
                                />
                                <button
                                    type="button"
                                    onClick={() => handleSendReply(post.id)}
                                    disabled={submittingReplyId === post.id || !(replyInputs[post.id] || '').trim()}
                                    className="bg-gray-800 text-white hover:bg-gray-900 text-xs font-bold px-4 py-2 rounded-xl shadow-sm transition disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-700"
                                >
                                    {submittingReplyId === post.id ? '...' : t('contributions.reply')}
                                </button>
                            </div>
                        </div>
                    );
                })}

                {/* Empty State Result Block Sheet */}
                {filteredThreads.length === 0 && (
                    <EmptyState icon={Icons.Trophy} title={t('contributions.noThreadsMatch')} />
                )}
            </div>
        </div>
    );
};

export default ContributionsView;