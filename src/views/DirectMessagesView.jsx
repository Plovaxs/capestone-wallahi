import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { directMessagesRepository } from '../data/repositories/directMessagesRepository';
import { subscribeToTable } from '../realtime/subscribeToTable';
import { showUserError } from '../utils/errorHandling';
import { checkRateLimit, formatRateLimitMessage } from '../utils/rateLimit';
import { sanitizeUserInput } from '../utils/sanitize';
import EmptyState from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { Icons } from '../components/Icons';
import ModuleTabBar from '../components/ModuleTabBar';

/**
 * VIEW: DirectMessagesView
 * PURPOSE: 1:1 private messaging between an employee and a supervisor --
 * distinct from the public Forum (contributions) and the ticket-workflow
 * Helpdesk. Contacts are: employees see every supervisor, supervisors see
 * every employee (enforced here at the UI level; the DB only requires the
 * sender to be who they claim, see migrations/20260810_add_direct_messages.sql).
 * Self-contained fetch + realtime subscription, same pattern as
 * ErrorMonitorView.jsx.
 */
const DirectMessagesView = ({ userProfile, allUsers = [] }) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState('conversations');
    const [messages, setMessages] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [activeContactId, setActiveContactId] = useState(null);
    const [draft, setDraft] = useState('');
    const [isSending, setIsSending] = useState(false);
    const threadEndRef = useRef(null);

    const contacts = useMemo(
        () => allUsers.filter((u) => u.id !== userProfile.id && u.role !== userProfile.role),
        [allUsers, userProfile]
    );

    const fetchMessages = async () => {
        try {
            const data = await directMessagesRepository.listForCurrentUser();
            setMessages(data || []);
        } catch (err) {
            showUserError('errors.loadMessages', err);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchMessages();
        const unsubscribe = subscribeToTable('direct_messages', fetchMessages);
        return unsubscribe;
    }, []);

    useEffect(() => {
        if (!activeContactId && contacts.length > 0) setActiveContactId(contacts[0].id);
    }, [contacts, activeContactId]);

    const threadMessages = useMemo(
        () => messages
            .filter((m) => (m.sender_id === userProfile.id && m.recipient_id === activeContactId)
                || (m.sender_id === activeContactId && m.recipient_id === userProfile.id))
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
        [messages, userProfile.id, activeContactId]
    );

    const unreadCountByContact = useMemo(() => {
        const map = new Map();
        messages.forEach((m) => {
            if (m.recipient_id === userProfile.id && !m.read_at) {
                map.set(m.sender_id, (map.get(m.sender_id) || 0) + 1);
            }
        });
        return map;
    }, [messages, userProfile.id]);

    const contactsById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);

    // 🟩 NEW SUBMODULE: Unread Summary -- the contact list already shows a
    // per-contact unread badge, but switching threads is the only way to
    // actually READ any of them. This surfaces every unread message
    // across every conversation in one consolidated list, reusing the
    // same already-fetched `messages` and `unreadCountByContact`.
    const unreadMessages = useMemo(
        () => messages
            .filter((m) => m.recipient_id === userProfile.id && !m.read_at)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
        [messages, userProfile.id]
    );

    // 🟩 NEW SUBMODULE: Message Stats -- per-contact sent/received counts
    // and each thread's most recent activity, reusing the same
    // already-fetched `messages` grouped the other way from the chat
    // thread view above.
    const messageStatsByContact = useMemo(() => {
        return contacts.map((c) => {
            const withContact = messages.filter((m) =>
                (m.sender_id === userProfile.id && m.recipient_id === c.id) ||
                (m.sender_id === c.id && m.recipient_id === userProfile.id)
            );
            const sent = withContact.filter((m) => m.sender_id === userProfile.id).length;
            const received = withContact.length - sent;
            const lastActivity = withContact.reduce((latest, m) => (!latest || new Date(m.created_at) > new Date(latest)) ? m.created_at : latest, null);
            return { contactId: c.id, name: c.name, sent, received, total: withContact.length, lastActivity };
        }).sort((a, b) => b.total - a.total);
    }, [contacts, messages, userProfile.id]);

    useEffect(() => {
        threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [threadMessages]);

    // 🟩 BUG FIX: was keyed on `threadMessages.length`, so a realtime update
    // that swapped which messages were unread without changing the total
    // count (e.g. one read elsewhere the same tick a new one arrived) never
    // re-ran this effect -- the new unread message just silently never got
    // marked read. Keying on the actual joined set of unread ids re-fires
    // whenever that set changes, not just when its size happens to.
    const unreadIdsInThread = useMemo(
        () => threadMessages.filter((m) => m.recipient_id === userProfile.id && !m.read_at).map((m) => m.id),
        [threadMessages, userProfile.id]
    );
    const unreadIdsKey = unreadIdsInThread.join(',');
    useEffect(() => {
        if (!activeContactId || unreadIdsInThread.length === 0) return;
        directMessagesRepository.markRead(unreadIdsInThread).catch(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeContactId, unreadIdsKey]);

    const handleSend = async () => {
        const body = draft.trim();
        if (!body || !activeContactId || isSending) return;
        setIsSending(true);
        try {
            // 🟩 SECURITY: every other free-text submission in the app
            // (contributions, forum replies, helpdesk tickets/replies, leave
            // reasons, task descriptions) is rate-limited and sanitized
            // before insert -- DMs were the one path skipping both.
            const rateLimit = await checkRateLimit('direct-message', { maxRequests: 20, windowSeconds: 60 });
            if (!rateLimit.allowed) {
                toast.error(formatRateLimitMessage(rateLimit.retryAfterMs));
                return;
            }
            await directMessagesRepository.send(userProfile.id, activeContactId, sanitizeUserInput(body, { maxLength: 2000 }));
            setDraft('');
            fetchMessages();
        } catch (err) {
            showUserError('errors.sendMessage', err);
        } finally {
            setIsSending(false);
        }
    };

    const tabs = [
        { id: 'conversations', label: t('messages.tabConversations'), icon: Icons.ChatBubble },
        { id: 'unread', label: t('messages.tabUnread'), icon: Icons.Bell },
        { id: 'stats', label: t('messages.tabStats'), icon: Icons.ScatterChart },
    ];

    return (
        <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('messages.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('messages.subtitle')}</p>
            </div>

            <ModuleTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'conversations' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden" style={{ minHeight: 480 }}>
                    {/* Contact list */}
                    <div className="sm:col-span-1 border-r border-gray-100 dark:border-gray-700/60 overflow-y-auto">
                        {contacts.length === 0 ? (
                            <EmptyState icon={Icons.ChatBubble} title={t('messages.noContacts')} />
                        ) : contacts.map((c) => (
                            <button
                                key={c.id}
                                type="button"
                                onClick={() => setActiveContactId(c.id)}
                                className={`w-full text-left px-4 py-3 flex items-center justify-between gap-2 border-b border-gray-50 dark:border-gray-700/40 ${activeContactId === c.id ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-gray-50 dark:hover:bg-gray-900/30'}`}
                            >
                                <span className="text-xs font-bold text-gray-800 dark:text-gray-100 truncate">{c.name}</span>
                                {!!unreadCountByContact.get(c.id) && (
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 shrink-0">
                                        {unreadCountByContact.get(c.id)}
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>

                    {/* Thread */}
                    <div className="sm:col-span-2 flex flex-col">
                        <div className="flex-1 overflow-y-auto p-4 space-y-2">
                            {isLoading ? (
                                <SkeletonList count={4} />
                            ) : !activeContactId ? (
                                <EmptyState icon={Icons.ChatBubble} title={t('messages.noContacts')} />
                            ) : threadMessages.length === 0 ? (
                                <EmptyState icon={Icons.ChatBubble} title={t('messages.noMessagesYet')} />
                            ) : threadMessages.map((m) => {
                                const isMine = m.sender_id === userProfile.id;
                                return (
                                    <div key={m.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                                        <div className={`max-w-[75%] px-3 py-2 rounded-2xl text-xs ${isMine ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-900/40 text-gray-800 dark:text-gray-100'}`}>
                                            <p className="whitespace-pre-wrap break-words">{m.body}</p>
                                            <p className={`text-[9px] mt-1 ${isMine ? 'text-blue-100' : 'text-gray-400'}`}>
                                                {new Date(m.created_at).toLocaleString()}
                                            </p>
                                        </div>
                                    </div>
                                );
                            })}
                            <div ref={threadEndRef} />
                        </div>
                        <div className="p-3 border-t border-gray-100 dark:border-gray-700/60 flex gap-2">
                            <input
                                type="text"
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
                                disabled={!activeContactId}
                                placeholder={t('messages.placeholder')}
                                className="flex-1 p-2.5 text-xs border border-gray-200 rounded-xl dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none"
                            />
                            <button
                                type="button"
                                onClick={handleSend}
                                disabled={!draft.trim() || !activeContactId || isSending}
                                className="px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl disabled:opacity-40"
                            >
                                {t('messages.send')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'unread' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                    <div className="p-5 pb-3">
                        <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('messages.unreadTitle')}</h2>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{t('messages.unreadDescription')}</p>
                    </div>
                    {unreadMessages.length === 0 ? (
                        <EmptyState icon={Icons.CheckCircle} title={t('messages.noUnread')} />
                    ) : (
                        <div className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {unreadMessages.map((m) => (
                                <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => { setActiveContactId(m.sender_id); setActiveTab('conversations'); }}
                                    className="w-full text-left p-4 hover:bg-gray-50/60 dark:hover:bg-gray-900/20"
                                >
                                    <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{contactsById.get(m.sender_id)?.name || t('messages.unknownSender')}</p>
                                    <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 truncate">{m.body}</p>
                                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{new Date(m.created_at).toLocaleString()}</p>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'stats' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6 overflow-x-auto">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('messages.statsTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('messages.statsDescription')}</p>
                    {messageStatsByContact.length === 0 ? (
                        <EmptyState icon={Icons.ScatterChart} title={t('messages.noContacts')} />
                    ) : (
                        <table className="min-w-full text-xs">
                            <thead>
                                <tr className="text-left text-gray-400 dark:text-gray-500">
                                    <th className="pb-2 pr-4 font-bold">{t('messages.colContact')}</th>
                                    <th className="pb-2 pr-4 font-bold">{t('messages.colSent')}</th>
                                    <th className="pb-2 pr-4 font-bold">{t('messages.colReceived')}</th>
                                    <th className="pb-2 font-bold">{t('messages.colLastActivity')}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/40">
                                {messageStatsByContact.map((row) => (
                                    <tr key={row.contactId}>
                                        <td className="py-2 pr-4 font-bold text-gray-700 dark:text-gray-200">{row.name}</td>
                                        <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{row.sent}</td>
                                        <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{row.received}</td>
                                        <td className="py-2 text-gray-500 dark:text-gray-400">{row.lastActivity ? new Date(row.lastActivity).toLocaleString() : '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
};

export default DirectMessagesView;
