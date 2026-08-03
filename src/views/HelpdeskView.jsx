import React, { useState } from 'react';

/**
 * COMPONENT: HelpdeskView (MOCK / PREVIEW MODE)
 * PURPOSE: A fully working, click-through mock of the Helpdesk feature —
 * no Supabase reads or writes happen here. Everything lives in local React
 * state, seeded with sample tickets, so this is 100% safe to demo or drop
 * into the app before the backend (ticket_status column + RLS policy split)
 * exists.
 *
 * WHEN THE BACKEND IS READY: swap the three handlers below
 * (handleCreateTicket, handleChangeStatus, handleSendReply) for real
 * supabase calls, and replace `mockTickets` state with the real
 * `contributions` prop. The JSX/UI below doesn't need to change at all.
 *
 * SCHEMA NOTE for whoever does the SQL side: a ticket now needs a `title`
 * column (separate from the existing `contribution` content column) and a
 * `problem_types` column — a text array, e.g. {"Hardware","Workflow"} —
 * since a ticket can be tagged with more than one problem type.
 */

// --- PROBLEM TYPE CHECKLIST OPTIONS ---
const PROBLEM_TYPES = ['Hardware', 'Software', 'Git Control', 'Workflow', 'Additional Resource'];

// --- SAMPLE DATA (mock only — replace with real `contributions` prop later) ---
const SAMPLE_TICKETS = [
    {
        id: 'mock-1',
        employee_id: 'mock-emp-1',
        employee_name: 'Jonathan Ezra',
        category: 'Urgent Blocker 🚨',
        title: "Can't push to final-form branch",
        contribution: "Getting a permissions error on GitHub whenever I try to push. Worked fine yesterday.",
        problem_types: ['Git Control'],
        ticket_status: 'Open',
        date: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
        replies: [],
    },
    {
        id: 'mock-2',
        employee_id: 'mock-emp-2',
        employee_name: 'Sheva Saurina',
        category: 'Help Request ❓',
        title: 'Which storage bucket for avatars?',
        contribution: 'Not sure which Supabase bucket the avatar uploads should go to — avatars or profile-pics?',
        problem_types: ['Software', 'Workflow'],
        ticket_status: 'In Progress',
        date: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
        replies: [
            { id: 'r1', author_id: 'mock-sup-1', author_name: 'Josh', message: 'Use the avatars bucket, I just checked.' },
        ],
    },
    {
        id: 'mock-3',
        employee_id: 'mock-emp-1',
        employee_name: 'Jonathan Ezra',
        category: 'Help Request ❓',
        title: 'Face enrollment failing on laptop camera',
        contribution: 'Keeps failing to detect my face during enrollment, might be low light?',
        problem_types: ['Hardware'],
        ticket_status: 'Resolved',
        date: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
        replies: [
            { id: 'r2', author_id: 'mock-sup-1', author_name: 'Josh', message: 'Try enrolling near a window, should fix the detection confidence.' },
        ],
    },
];

const HelpdeskView = ({ userProfile }) => {
    const [mockTickets, setMockTickets] = useState(SAMPLE_TICKETS);
    const [newTitle, setNewTitle] = useState('');
    const [newContent, setNewContent] = useState('');
    const [ticketCategory, setTicketCategory] = useState('Help Request ❓');
    const [selectedProblemTypes, setSelectedProblemTypes] = useState([]);
    const [replyInputs, setReplyInputs] = useState({});
    const [statusFilter, setStatusFilter] = useState('Open');

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

    const visibleTickets = mockTickets
        .filter(t => statusFilter === 'all' || t.ticket_status === statusFilter)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    const openCount = mockTickets.filter(t => t.ticket_status === 'Open').length;

    const toggleProblemType = (type) => {
        setSelectedProblemTypes(prev =>
            prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
        );
    };

    // --- MOCK HANDLER: local state only, no network call ---
    const handleCreateTicket = () => {
        if (!newTitle.trim() || !newContent.trim()) return;
        const ticket = {
            id: `mock-${Date.now()}`,
            employee_id: userProfile?.id || 'you',
            employee_name: userProfile?.name || 'You',
            category: ticketCategory,
            title: newTitle.trim(),
            contribution: newContent.trim(),
            problem_types: selectedProblemTypes,
            ticket_status: 'Open',
            date: new Date().toISOString(),
            replies: [],
        };
        setMockTickets(prev => [ticket, ...prev]);
        setNewTitle('');
        setNewContent('');
        setSelectedProblemTypes([]);
    };

    // --- MOCK HANDLER: local state only, no network call ---
    const handleChangeStatus = (ticketId, newStatus) => {
        setMockTickets(prev => prev.map(t => t.id === ticketId ? { ...t, ticket_status: newStatus } : t));
    };

    // --- MOCK HANDLER: local state only, no network call ---
    const handleSendReply = (ticketId) => {
        const message = (replyInputs[ticketId] || '').trim();
        if (!message) return;
        setMockTickets(prev => prev.map(t =>
            t.id === ticketId
                ? { ...t, replies: [...t.replies, { id: `mock-r-${Date.now()}`, author_id: userProfile?.id || 'you', author_name: userProfile?.name || 'You', message }] }
                : t
        ));
        setReplyInputs(prev => ({ ...prev, [ticketId]: '' }));
    };

    return (
        <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">

            {/* --- MOCK MODE BANNER --- */}
            <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs font-bold px-4 py-2.5 rounded-xl dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-300">
                🧪 Preview Mode — sample data only, nothing here is saved to the database yet.
            </div>

            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-gray-800 dark:text-white">Helpdesk</h1>
                    <p className="text-xs text-gray-400 dark:text-gray-500 font-medium">
                        {userProfile?.role === 'supervisor'
                            ? 'Urgent requests and blockers from your team.'
                            : 'Your urgent requests and blockers.'}
                    </p>
                </div>
                {openCount > 0 && (
                    <span className="px-3 py-1.5 rounded-full text-xs font-bold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                        {openCount} Open
                    </span>
                )}
            </div>

            {/* --- NEW TICKET COMPOSER --- */}
            <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700 space-y-3">

                {/* Title — separate from content */}
                <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Title</label>
                    <input
                        type="text"
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                        placeholder={`Short summary, e.g. "Can't push to final-form branch"`}
                        className="w-full p-2.5 border border-gray-200 rounded-xl text-sm font-bold focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 dark:bg-gray-900/40 dark:border-gray-600 dark:text-white"
                    />
                </div>

                {/* Content — the description */}
                <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Details</label>
                    <textarea
                        value={newContent}
                        onChange={(e) => setNewContent(e.target.value)}
                        placeholder="Describe what you're blocked on or need help with..."
                        className="w-full p-3 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 dark:bg-gray-900/40 dark:border-gray-600 dark:text-white"
                        rows="3"
                    />
                </div>

                {/* Problem type checklist */}
                <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Type of Problem</label>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {PROBLEM_TYPES.map(type => (
                            <label key={type} className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-gray-600 dark:text-gray-300">
                                <input
                                    type="checkbox"
                                    checked={selectedProblemTypes.includes(type)}
                                    onChange={() => toggleProblemType(type)}
                                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-3.5 w-3.5"
                                />
                                {type}
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
                        disabled={!newTitle.trim() || !newContent.trim()}
                        className="px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
                    >
                        File Ticket
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
                        {s === 'all' ? 'All' : s}
                    </button>
                ))}
            </div>

            {/* --- TICKET LIST --- */}
            <div className="space-y-4">
                {visibleTickets.length === 0 && (
                    <div className="text-center py-12 text-gray-400 text-sm italic">
                        No tickets here. {statusFilter === 'Open' && 'Nothing urgent right now.'}
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
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATUS_STYLES[status]}`}>{status}</span>
                                {(ticket.problem_types || []).map(pt => (
                                    <span key={pt} className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-600 border border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600">
                                        {pt}
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
                                            Mark {s}
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
                                    placeholder="Reply..."
                                    className="flex-1 p-2 text-xs border border-gray-200 rounded-lg dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none"
                                />
                                <button
                                    type="button"
                                    onClick={() => handleSendReply(ticket.id)}
                                    disabled={!(replyInputs[ticket.id] || '').trim()}
                                    className="px-3 py-2 text-xs font-bold text-blue-600 hover:text-blue-800 disabled:opacity-40"
                                >
                                    Send
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