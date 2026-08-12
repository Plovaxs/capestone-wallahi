import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../supabaseClient';
import { Icons } from './Icons';
import GlobalSearch from './GlobalSearch';
import EmptyState from './EmptyState';
import CesdLogo from '../assets/LOGO ahh.png';

const Header = ({
    userProfile,
    notifications,
    onNotificationsRead,
    isDarkMode,
    toggleDarkMode,
    toggleMobileSidebar,
    tasks,
    contributions,
    leaveRequests,
    allUsers,
    setActiveView
}) => {
    const { t } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const notificationRef = useRef(null);
    const unreadCount = notifications.filter(n => !n.read).length;

    const handleToggle = () => {
        setIsOpen(!isOpen);
        if(!isOpen && unreadCount > 0) {
            onNotificationsRead();
        }
    }

    // Esc AND click-outside both close the notification dropdown, matching
    // the same pattern GlobalSearch already uses — this previously only had
    // Esc, so clicking anywhere else on the page left it open, blocking
    // whatever was underneath.
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') setIsOpen(false);
        };
        const handleClickOutside = (e) => {
            if (notificationRef.current && !notificationRef.current.contains(e.target)) setIsOpen(false);
        };
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const handleLogout = async () => {
        try {
            const { error } = await supabase.auth.signOut();
            if (error) throw error;
            window.location.reload();
        } catch (error) {
            console.error("Error logging out:", error.message);
            window.location.reload();
        }
    };

    // ==========================================
    // 🎨 SMART NOTIFICATION STYLER ENGINE
    // ==========================================
    const getNotificationStyle = (message) => {
        const msg = message.toLowerCase();
        
        // 🔴 High Alert / Revisions / Denials
        if (msg.includes('revision') || msg.includes('denied') || msg.includes('overdue')) {
            return {
                icon: '🚨',
                bgClass: 'bg-red-50 dark:bg-red-950/20 border-red-100 dark:border-red-900/50',
                textClass: 'text-red-800 dark:text-red-200',
                badgeText: t('header.badgeActionRequired'),
                badgeStyle: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 border-red-200 dark:border-red-800'
            };
        }
        // 🟢 Approvals / Success / Extensions
        if (msg.includes('approved') || msg.includes('breathing room') || msg.includes('successfully')) {
            return {
                icon: '✅',
                bgClass: 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-100 dark:border-emerald-900/50',
                textClass: 'text-emerald-800 dark:text-emerald-200',
                badgeText: t('header.badgeSystemClearance'),
                badgeStyle: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
            };
        }
        // 🔵 New Task / Assignment Pinned
        if (msg.includes('task') || msg.includes('assigned')) {
            return {
                icon: '📌',
                bgClass: 'bg-blue-50 dark:bg-blue-950/20 border-blue-100 dark:border-blue-900/50',
                textClass: 'text-blue-800 dark:text-blue-200',
                badgeText: t('header.badgeNewAssignment'),
                badgeStyle: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 border-blue-200 dark:border-blue-800'
            };
        }
        // 🟣 Performance / Appraisals
        if (msg.includes('review') || msg.includes('appraisal') || msg.includes('📊')) {
            return {
                icon: '📊',
                bgClass: 'bg-purple-50 dark:bg-purple-950/20 border-purple-100 dark:border-purple-900/50',
                textClass: 'text-purple-800 dark:text-purple-200',
                badgeText: t('header.badgePerformance'),
                badgeStyle: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 border-purple-200 dark:border-purple-800'
            };
        }
        // 🟡 Leave Requests / Scheduling
        if (msg.includes('leave') || msg.includes('holiday')) {
            return {
                icon: '📅',
                bgClass: 'bg-amber-50 dark:bg-amber-950/20 border-amber-100 dark:border-amber-900/50',
                textClass: 'text-amber-800 dark:text-amber-200',
                badgeText: t('header.badgeScheduling'),
                badgeStyle: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 border-amber-200 dark:border-amber-800'
            };
        }
        // ⚪ Default / General Info
        return {
            icon: '🔔',
            bgClass: 'bg-gray-50 dark:bg-gray-800 border-gray-100 dark:border-gray-700',
            textClass: 'text-gray-800 dark:text-gray-200',
            badgeText: t('header.badgeSystemUpdate'),
            badgeStyle: 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600'
        };
    };

    return (
        <header className="bg-white shadow-sm border-b border-gray-200 p-4 flex justify-between items-center z-40 relative dark:bg-gray-800 dark:border-gray-700 h-16">
            
            <div className="flex items-center gap-3">
                <button
                    onClick={toggleMobileSidebar}
                    aria-label={t('header.openMenu')}
                    className="md:hidden p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-lg dark:text-gray-300 dark:hover:bg-gray-700"
                >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
                </button>

                <img src={CesdLogo} alt="CESD Logo" className="h-8 sm:h-10 w-auto" />
                <span className="hidden sm:block ml-2 text-lg font-bold text-gray-800 dark:text-gray-100 tracking-tight">
                    {t('header.appTitle')}
                </span>
            </div>

            <GlobalSearch
                tasks={tasks}
                contributions={contributions}
                leaveRequests={leaveRequests}
                allUsers={allUsers}
                setActiveView={setActiveView}
            />

            <div className="flex items-center space-x-2 sm:space-x-4">
                <button
                    onClick={toggleDarkMode}
                    aria-label={t('header.toggleDarkMode')}
                    className="p-2 text-gray-500 hover:bg-gray-100 rounded-full dark:text-gray-400 dark:hover:bg-gray-700 transition-colors"
                >
                    {isDarkMode ? Icons.Sun : Icons.Moon}
                </button>

                {/* ========================================== */}
                {/* 🔔 UPGRADED NOTIFICATION BELL TRAY       */}
                {/* ========================================== */}
                <div className="relative" ref={notificationRef}>
                    <button
                        onClick={handleToggle}
                        aria-label={t('header.notifications')}
                        aria-expanded={isOpen}
                        className="p-2 text-gray-500 hover:bg-gray-100 rounded-full dark:text-gray-400 dark:hover:bg-gray-700 transition-colors relative"
                    >
                        {Icons.Bell}
                        {unreadCount > 0 && (
                            <span className="absolute top-1 right-1 flex h-3 w-3">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-3 w-3 border-2 border-white dark:border-gray-800 bg-red-500"></span>
                            </span>
                        )}
                    </button>
                    
                    {isOpen && (
                        <div className="absolute right-0 mt-2 w-96 bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden z-50 dark:bg-gray-800 dark:border-gray-700 animate-fade-in-down">
                           <div className="py-2 flex flex-col">
                             
                             <div className="flex justify-between items-center px-4 py-3 border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30">
                                 <div className="font-extrabold text-sm dark:text-white uppercase tracking-wider text-gray-700">{t('header.inboxAlerts')}</div>
                                 <span className="text-[10px] font-bold bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full dark:bg-blue-900/40 dark:text-blue-400">{notifications.length} {t('header.total')}</span>
                             </div>
                             
                             <div className="max-h-[400px] overflow-y-auto bg-gray-50/20 dark:bg-gray-900/10">
                                {notifications.length > 0 ? notifications.map(n => {
                                    const style = getNotificationStyle(n.message);
                                    
                                    return (
                                        <div key={n.id} className={`p-4 border-b last:border-b-0 border-gray-100 transition-all cursor-default dark:border-gray-700/50 ${style.bgClass} ${!n.read ? 'opacity-100 border-l-4 border-l-blue-500' : 'opacity-70 grayscale-[20%]'}`}>
                                            <div className="flex gap-3 items-start">
                                                <div className="text-xl mt-0.5 drop-shadow-sm">{style.icon}</div>
                                                <div className="flex-1 space-y-1">
                                                    <div className="flex justify-between items-start mb-1">
                                                        <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md border ${style.badgeStyle}`}>
                                                            {style.badgeText}
                                                        </span>
                                                        {!n.read && <span className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)] animate-pulse"></span>}
                                                    </div>
                                                    <p className={`text-[11px] font-bold leading-relaxed ${style.textClass}`}>
                                                        {n.message.replace('📊', '').replace('🎉', '').trim()}
                                                    </p>
                                                    <p className="text-[10px] text-gray-400 font-mono uppercase mt-1">
                                                        {new Date(n.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                }) : (
                                    <EmptyState icon={Icons.Inbox} title={t('header.noAlerts')} />
                                )}
                             </div>
                           </div>
                        </div>
                    )}
                </div>

                {/* Avatar Profile Box */}
                <div className="hidden sm:flex items-center gap-3 pl-2 border-l border-gray-200 dark:border-gray-700">
                    <div className="text-right hidden md:block">
                        <p className="text-sm font-bold text-gray-800 dark:text-white leading-none">{userProfile.name}</p>
                        <p className="text-[10px] font-bold text-gray-400 dark:text-gray-500 tracking-wider uppercase mt-1">{userProfile.role}</p>
                    </div>
                    <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-500 p-0.5 shadow-md">
                        <div className="w-full h-full rounded-full bg-white dark:bg-gray-800 flex items-center justify-center overflow-hidden">
                            {userProfile.avatar_url ? (
                                <img src={userProfile.avatar_url} alt="Profile" className="w-full h-full object-cover" />
                            ) : (
                                <span className="text-blue-600 font-black text-xs">{userProfile.initials}</span>
                            )}
                        </div>
                    </div>
                </div>

                <button
                    onClick={handleLogout}
                    title={t('header.logout')}
                    aria-label={t('header.logout')}
                    className="ml-2 p-2.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all dark:hover:bg-red-950/40 cursor-pointer z-50 border border-transparent hover:border-red-100 dark:hover:border-red-900/50"
                >
                    {Icons.LogOut}
                </button>
            </div>
        </header>
    );
};

export default Header;