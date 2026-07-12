import React, { useState } from 'react';
import { supabase } from '../supabaseClient';

/**
 * COMPONENT: ContributionsView
 * PURPOSE: Interactive Intern Discussion Forum and shared Help Desk platform.
 * DESIGN PATTERN: Flattened thread timeline mapping nested comment nodes via a single JSONB array column.
 * SECURITY: Enforces item-level role tracking so employees can only eliminate rows they personally created.
 */
const ContributionsView = ({ userProfile, contributions = [], allUsers = [], fetchContributions }) => {
    // --- POST COMPOSER FORUM STATES ---
    const [newPost, setNewPost] = useState('');
    const [category, setCategory] = useState('General Discussion');
    const [isSubmitting, setIsSubmitting] = useState(false);
    
    // --- NESTED COMMENT TRACKING ENGINE BUFFERS ---
    const [replyInputs, setReplyInputs] = useState({}); // Stores key-value tracking texts per card ID
    const [submittingReplyId, setSubmittingReplyId] = useState(null); // Local loading state for reply dispatches

    // --- TIMELINE FILTER SELECTION CONTROLS ---
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedCategory, setSelectedCategory] = useState('all');

    // Sanitized forum tags mapping consistent aesthetic border configurations
    const FORUM_CATEGORIES = [
        { name: 'General Discussion', color: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600', active: 'bg-blue-600 text-white border-blue-600' },
        { name: 'Help Request ❓', color: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800', active: 'bg-amber-500 text-white border-amber-500' },
        { name: 'Urgent Blocker 🚨', color: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800', active: 'bg-red-600 text-white border-red-600' },
        { name: 'Project Milestone 🎉', color: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-300 dark:border-purple-800', active: 'bg-purple-600 text-white border-purple-600' },
    ];

    // --- UTILITY USER DICTIONARY MATCHERS ---
    const getUserName = (id) => allUsers.find(u => String(u.id) === String(id))?.name || 'Unknown User';
    const getUserRole = (id) => allUsers.find(u => String(u.id) === String(id))?.role || 'employee';

    // =========================================================================
    // ⚙️ BACKEND MUTATION PIPELINES (SUPABASE TRANSACTION CONTROLLERS)
    // =========================================================================

    /**
     * TRANSACTION: handleCreateTask (Thread Composer Pipeline)
     * PURPOSE: Inserts a brand new global discussion topic row onto the board.
     * SCHEMA METRICS: Instantiates an empty `replies: []` array field block natively on row creation.
     */
const handleCreateThread = async () => {
        if (!newPost.trim()) return;
        setIsSubmitting(true);
        try {
            await supabase.from('contributions').insert({
                employee_id: userProfile.id,
                date: new Date().toISOString().split('T')[0],
                contribution: newPost.trim(),
                category: category,
                replies: [] 
            });

            // 🟩 NEW: If they select Help or Blocker, ping the supervisors!
            if (category.includes('Help') || category.includes('Blocker')) {
                const supervisors = allUsers.filter(u => u.role === 'supervisor');
                supervisors.forEach(async (sup) => {
                    // The smart parser will catch the "action required" keyword and turn it red/alert mode!
                    await createNotification(sup.id, `🚨 Action Required: ${userProfile.name} posted an urgent ${category} in the forum.`);
                });
            }

            setNewPost('');
            fetchContributions(); 
        } catch (error) {
            console.error("Error creating post:", error);
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
        if (!confirm("Are you sure you want to permanently delete this discussion thread?")) return;
        
        const { error } = await supabase
            .from('contributions')
            .delete()
            .eq('id', postId);

        if (error) {
            alert("Failed to delete thread: " + error.message);
        } else {
            fetchContributions(); // Refresh live view feeds state cache
        }
    };

    /**
     * TRANSACTION: handleSendReply
     * PURPOSE: Appends a newly compiled nested object matrix into the matching row array.
     * CRITICAL LOGIC: Pulls current cached comment references, expands the dataset with a distinct 
     * randomized reply node key pointer, and performs an absolute row update mutation payload.
     */
    const handleSendReply = async (postId, currentReplies = []) => {
        const text = replyInputs[postId];
        if (!text || !text.trim()) return;

        setSubmittingReplyId(postId);
        
        // Combines existing historical loops alongside your new comment element trace
        const updatedRepliesArray = [...currentReplies, nextReplyObject];

        const { error } = await supabase
         .from('contribution_replies')
         .insert({ post_id: postId, author_id: userProfile.id, message: text.trim() });

        if (error) {
            alert("Failed to submit reply: " + error.message);
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
    const filteredThreads = contributions.filter(post => {
        const matchesSearch = post.contribution.toLowerCase().includes(searchTerm.toLowerCase()) || 
                             getUserName(post.employee_id).toLowerCase().includes(searchTerm.toLowerCase());
        const matchesCategory = selectedCategory === 'all' || post.category === selectedCategory;
        return matchesSearch && matchesCategory;
    });

    return (
        <div className="p-8 max-w-5xl mx-auto space-y-6">
            
            {/* --- LAYOUT HEADER CONTROLS --- */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-200 dark:border-gray-700 pb-4">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
                        💬 Intern Discussion Forum & Help Desk
                    </h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                        Ask questions, declare blockers, and collaborate with team members and supervisors.
                    </p>
                </div>

                {/* TIMELINE FILTERS CONTAINER WRAPPERS */}
                <div className="flex gap-2 w-full md:w-auto">
                    <input 
                        type="text"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder="Search threads or names..."
                        className="p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-white dark:bg-gray-800 dark:text-white w-full md:w-56 shadow-sm"
                    />
                    <select
                        value={selectedCategory}
                        onChange={(e) => setSelectedCategory(e.target.value)}
                        className="p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-white dark:bg-gray-800 dark:text-white shadow-sm"
                    >
                        <option value="all">All Channels</option>
                        {FORUM_CATEGORIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                </div>
            </div>

            {/* --- COMPOSER TOP INPUT SHEET PANEL WIDGET --- */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
                <div className="p-5">
                    <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                        <span className="w-1 h-3.5 bg-blue-500 rounded-full"></span>
                        Start a New Discussion Thread
                    </h3>
                    
                    <div className="flex flex-col gap-3">
                        <textarea 
                            value={newPost} 
                            onChange={(e) => setNewPost(e.target.value)}
                            className="w-full p-4 border border-gray-100 rounded-xl text-xs bg-gray-50/50 focus:bg-white focus:ring-4 focus:ring-blue-500/5 focus:border-blue-500 transition-all resize-none dark:bg-gray-900/40 dark:border-gray-600 dark:text-white dark:focus:bg-gray-900"
                            placeholder="What do you want to ask or share with the portal board?"
                            rows="3"
                        ></textarea>
                        
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
                                {isSubmitting ? 'Posting...' : 'Publish Thread'}
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
                                                <span className="text-[9px] font-extrabold tracking-wider uppercase bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 px-1.5 py-0.5 rounded border border-amber-200">Supervisor</span>
                                            )}
                                        </div>
                                        <p className="text-[10px] font-bold text-gray-400 font-mono uppercase">📅 Thread started: {post.date}</p>
                                    </div>
                                </div>
                                
                                {/* INTERACTION ACTION CONTROLS LAYOUT */}
                                <div className="flex items-center gap-2">
                                    <span className={`inline-block px-2.5 py-1 rounded-xl text-[10px] font-extrabold uppercase tracking-wide border ${
                                        FORUM_CATEGORIES.find(c => c.name === post.category)?.color || 'bg-gray-100 text-gray-600'
                                    }`}>
                                        {post.category}
                                    </span>

                                    {/* RENDERS INTERACTION TRASH CONTROLS ONLY IF AUTHORIZATION CHECKS PASS */}
                                    {canDelete && (
                                        <button
                                            type="button"
                                            onClick={() => handleDeleteThread(post.id)}
                                            className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                                            title="Delete Thread"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                            </svg>
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Core Initial Message Thread Box */}
                            <p className="text-gray-700 dark:text-gray-200 text-xs md:text-sm whitespace-pre-wrap pl-1 leading-relaxed">
                                {post.contribution}
                            </p>

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
                                                        <span className="text-[8px] font-bold bg-amber-500/20 text-amber-700 px-1 rounded">Staff</span>
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
                                    onKeyPress={(e) => e.key === 'Enter' && handleSendReply(post.id, postReplies)}
                                    placeholder={userProfile.role === 'supervisor' ? "Provide guidance or feedback..." : "Write a comment or answer..."}
                                    className="flex-1 p-2 text-xs border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-blue-500 bg-gray-50/50 dark:bg-gray-900/40 dark:text-white"
                                />
                                <button
                                    type="button"
                                    onClick={() => handleSendReply(post.id, postReplies)}
                                    disabled={submittingReplyId === post.id || !(replyInputs[post.id] || '').trim()}
                                    className="bg-gray-800 text-white hover:bg-gray-900 text-xs font-bold px-4 py-2 rounded-xl shadow-sm transition disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-700"
                                >
                                    {submittingReplyId === post.id ? '...' : 'Reply'}
                                </button>
                            </div>
                        </div>
                    );
                })}

                {/* Empty State Result Block Sheet */}
                {filteredThreads.length === 0 && (
                    <div className="text-center p-12 text-gray-400 dark:text-gray-500 text-xs italic">
                        No discussion threads match your filter layout criteria.
                    </div>
                )}
            </div>
        </div>
    );
};

export default ContributionsView;