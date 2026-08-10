import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { directMessagesRepository } from '../data/repositories/directMessagesRepository';
import { subscribeToTable } from '../realtime/subscribeToTable';
import { showUserError } from '../utils/errorHandling';

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

    useEffect(() => {
        threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [threadMessages]);

    useEffect(() => {
        if (!activeContactId) return;
        const unreadIds = threadMessages
            .filter((m) => m.recipient_id === userProfile.id && !m.read_at)
            .map((m) => m.id);
        if (unreadIds.length > 0) {
            directMessagesRepository.markRead(unreadIds).catch(() => {});
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeContactId, threadMessages.length]);

    const handleSend = async () => {
        const body = draft.trim();
        if (!body || !activeContactId || isSending) return;
        setIsSending(true);
        try {
            await directMessagesRepository.send(userProfile.id, activeContactId, body);
            setDraft('');
            fetchMessages();
        } catch (err) {
            showUserError('errors.sendMessage', err);
        } finally {
            setIsSending(false);
        }
    };

    return (
        <div className="p-4 md:p-8 max-w-4xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('messages.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('messages.subtitle')}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden" style={{ minHeight: 480 }}>
                {/* Contact list */}
                <div className="sm:col-span-1 border-r border-gray-100 dark:border-gray-700/60 overflow-y-auto">
                    {contacts.length === 0 ? (
                        <p className="text-center text-xs text-gray-400 py-10 dark:text-gray-500 italic px-4">{t('messages.noContacts')}</p>
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
                            <p className="text-center text-xs text-gray-400 py-10">{t('messages.loading')}</p>
                        ) : !activeContactId ? (
                            <p className="text-center text-xs text-gray-400 py-10 italic">{t('messages.noContacts')}</p>
                        ) : threadMessages.length === 0 ? (
                            <p className="text-center text-xs text-gray-400 py-10 italic">{t('messages.noMessagesYet')}</p>
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
        </div>
    );
};

export default DirectMessagesView;
