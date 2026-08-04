import React, { useState, useEffect, useRef, useReducer } from 'react';
import { appDataReducer, initialAppDataState } from './state/appDataReducer';
import { useTranslation } from 'react-i18next';
import { supabase } from './supabaseClient';
import { Toaster } from 'react-hot-toast';
import toast from 'react-hot-toast';
import { idbSet, idbGet } from './offline/indexedDbCache';
import { offlineMutationQueue } from './offline/OfflineMutationQueue';
import { profilesRepository } from './data/repositories/profilesRepository';
import { tasksRepository } from './data/repositories/tasksRepository';
import { attendanceRepository } from './data/repositories/attendanceRepository';
import { leaveRepository } from './data/repositories/leaveRepository';
import { contributionsRepository } from './data/repositories/contributionsRepository';
import { helpdeskRepository } from './data/repositories/helpdeskRepository';
import { reviewsRepository } from './data/repositories/reviewsRepository';
import { notificationsRepository } from './data/repositories/notificationsRepository';
import { notificationDispatcher } from './patterns/notificationChannels/NotificationDispatcher';
import { subscribeToTable } from './realtime/subscribeToTable';
import { usePresence } from './realtime/usePresence';

import Header from './components/Header';
import Sidebar from './components/Sidebar';
import ChatBot from './components/ChatBot';
import OnboardingTour from './components/OnboardingTour';
import ConfirmDialogHost from './components/ConfirmDialogHost';
import CommandPalette from './components/CommandPalette';
import PageSkeleton from './components/PageSkeleton';
import FeatureFlagPanel from './components/FeatureFlagPanel';

// 🟩 CODE-SPLITTING: each view (and its dependencies — AttendanceView alone
// pulls in face-api.js + @huggingface/transformers, multiple MB) is its own
// chunk, fetched only when that view is actually navigated to instead of
// bloating the initial bundle everyone downloads just to see the login page.
const LoginPage = React.lazy(() => import('./views/LoginPage'));
const DashboardView = React.lazy(() => import('./views/DashboardView'));
const AttendanceView = React.lazy(() => import('./views/AttendanceView'));
const TasksView = React.lazy(() => import('./views/TasksView'));
const ContributionsView = React.lazy(() => import('./views/ContributionsView'));
const LeaveView = React.lazy(() => import('./views/LeaveView'));
const PerformanceReviewView = React.lazy(() => import('./views/PerformanceReviewView'));
const SettingsView = React.lazy(() => import('./views/SettingsView'));
const HelpdeskView = React.lazy(() => import('./views/HelpdeskView'));

const MainContent = ({ view, userProfile, ...props }) => {
  switch (view) {
    case 'dashboard': return <DashboardView {...props} userProfile={userProfile} />;
    case 'attendance': return <AttendanceView {...props} userProfile={userProfile} />;
    case 'tasks': return <TasksView {...props} userProfile={userProfile} />;
    case 'contributions': return <ContributionsView {...props} userProfile={userProfile} />;
    case 'helpdesk': return <HelpdeskView {...props} userProfile={userProfile} />;
    case 'leave': return <LeaveView {...props} userProfile={userProfile} fetchProfile={props.fetchProfile} />;
    case 'reviews': return <PerformanceReviewView {...props} userProfile={userProfile} />;
    case 'settings': return <SettingsView {...props} userProfile={userProfile} fetchProfile={props.fetchProfile} />;
    default: return <DashboardView {...props} userProfile={userProfile} />;
  }
};

export default function App() {
  const { t } = useTranslation();
  const [session, setSession] = useState(null);
  const [userProfile, setUserProfile] = useState(null);

  // 🟩 REDUCER: the 8 "fetched from Supabase" entities used to be 8
  // independent useState/setter pairs; consolidated into one reducer since
  // they're always fetched/reasoned about together (see loadAllAppData).
  // Destructured back to the same names below so every prop passed further
  // down the tree (MainContent, views) is completely unchanged.
  const [appData, dispatchAppData] = useReducer(appDataReducer, initialAppDataState);
  const { allUsers, tasks, attendance, leaveRequests, contributions, helpdeskTickets, reviews, notifications } = appData;

  const [activeView, setActiveView] = useState('dashboard');
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');

  // --- ACCESSIBILITY PREFERENCES ---
  const [colorblindMode, setColorblindMode] = useState(() => localStorage.getItem('colorblindMode') || 'none');
  const [fontSize, setFontSize] = useState(() => localStorage.getItem('fontSize') || 'normal');
  const [highContrast, setHighContrast] = useState(() => localStorage.getItem('highContrast') === 'true');
  const [reduceMotion, setReduceMotion] = useState(() => localStorage.getItem('reduceMotion') === 'true');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('colorblind-protanopia', 'colorblind-deuteranopia', 'colorblind-tritanopia');
    if (colorblindMode !== 'none') root.classList.add(`colorblind-${colorblindMode}`);
    localStorage.setItem('colorblindMode', colorblindMode);
  }, [colorblindMode]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('font-large', 'font-xl');
    if (fontSize === 'large') root.classList.add('font-large');
    if (fontSize === 'xl') root.classList.add('font-xl');
    localStorage.setItem('fontSize', fontSize);
  }, [fontSize]);

  useEffect(() => {
    document.documentElement.classList.toggle('high-contrast', highContrast);
    localStorage.setItem('highContrast', highContrast);
  }, [highContrast]);

  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', reduceMotion);
    localStorage.setItem('reduceMotion', reduceMotion);
  }, [reduceMotion]);

  const toggleDarkMode = () => setIsDarkMode(!isDarkMode);
  const onlineUserIds = usePresence(userProfile);

  const fetchProfile = async (userId) => {
    if (!userId) return;
    try {
      const data = await profilesRepository.getById(userId);
      if (data) {
        setUserProfile(data);
      } else {
        console.warn('Profile row missing or cleared from schema database.');
        handleLogout();
      }
    } catch (err) {
      console.error('fetchProfile failed:', err.message);
    }
  };

  const fetchAllUsers = async () => {
    try {
      dispatchAppData({ type: 'SET_ALL_USERS', payload: await profilesRepository.listAll() });
    } catch (err) {
      console.error('fetchAllUsers failed:', err.message);
    }
  };

  // 🟩 OFFLINE-FIRST: on fetch failure, fall back to the last successfully
  // fetched snapshot in IndexedDB instead of leaving the view empty. Every
  // successful fetch below re-snapshots its result for next time.
  const showOfflineCacheNotice = () => toast(t('offline.showingCachedData'), { icon: '📴', id: 'offline-cache-notice' });

  // 🟩 ROBUST FIX: Fetches all data first, then filters via JS to prevent Postgres column-type crashes
  const fetchTasks = async (profile) => {
    if (!profile) return;
    try {
      const data = await tasksRepository.listAll();
      let filteredTasks = data || [];
      if (profile.role !== 'supervisor') {
        filteredTasks = filteredTasks.filter(t => (t.assigned_to || []).includes(profile.id));
      }
      dispatchAppData({ type: 'SET_TASKS', payload: filteredTasks });
      idbSet('tasks', filteredTasks);
    } catch (err) {
      console.error('fetchTasks failed:', err.message);
      const cached = await idbGet('tasks');
      if (cached) { dispatchAppData({ type: 'SET_TASKS', payload: cached }); showOfflineCacheNotice(); }
    }
  };

  const fetchAttendance = async () => {
    try {
      const data = await attendanceRepository.listAll();
      dispatchAppData({ type: 'SET_ATTENDANCE', payload: data });
      idbSet('attendance', data);
    } catch (err) {
      console.error('fetchAttendance failed:', err.message);
      const cached = await idbGet('attendance');
      if (cached) { dispatchAppData({ type: 'SET_ATTENDANCE', payload: cached }); showOfflineCacheNotice(); }
    }
  };

  const fetchLeaveRequests = async (profile) => {
    if (!profile) return;
    try {
      const data = await leaveRepository.listAll();
      let filteredLeave = data || [];
      if (profile.role !== 'supervisor') {
        filteredLeave = filteredLeave.filter(r => r.employee_id === profile.id);
      }
      dispatchAppData({ type: 'SET_LEAVE_REQUESTS', payload: filteredLeave });
      idbSet('leaveRequests', filteredLeave);
    } catch (err) {
      console.error('fetchLeaveRequests failed:', err.message);
      const cached = await idbGet('leaveRequests');
      if (cached) { dispatchAppData({ type: 'SET_LEAVE_REQUESTS', payload: cached }); showOfflineCacheNotice(); }
    }
  };

  const fetchContributions = async () => {
    try {
      const [data, replies] = await Promise.all([
        contributionsRepository.listPosts(),
        contributionsRepository.listReplies(),
      ]);
      const merged = (data || []).map(post => ({
        ...post,
        replies: (replies || []).filter(r => r.post_id === post.id),
      }));
      dispatchAppData({ type: 'SET_CONTRIBUTIONS', payload: merged });
      idbSet('contributions', merged);
    } catch (err) {
      console.error('fetchContributions failed:', err.message);
      const cached = await idbGet('contributions');
      if (cached) { dispatchAppData({ type: 'SET_CONTRIBUTIONS', payload: cached }); showOfflineCacheNotice(); }
    }
  };

  //Added fetchHelpdeskTickets function to fetch tickets and their replies
  const fetchHelpdeskTickets = async (profile) => {
    if (!profile) return;
    try {
      const [data, replies] = await Promise.all([
        helpdeskRepository.listTickets(),
        helpdeskRepository.listReplies(),
      ]);
      const merged = (data || []).map(ticket => ({
        ...ticket,
        replies: (replies || []).filter(r => r.ticket_id === ticket.id),
      }));
      dispatchAppData({ type: 'SET_HELPDESK_TICKETS', payload: merged });
      idbSet('helpdeskTickets', merged);
    } catch (err) {
      console.error('fetchHelpdeskTickets failed:', err.message);
      const cached = await idbGet('helpdeskTickets');
      if (cached) { dispatchAppData({ type: 'SET_HELPDESK_TICKETS', payload: cached }); showOfflineCacheNotice(); }
    }
  };

  // 🟩 ROBUST FIX: Corrected table name to 'performance_evaluations'
  const fetchReviews = async (profile) => {
    if (!profile) return;
    try {
      const data = await reviewsRepository.listAll();
      let filteredReviews = data || [];
      if (profile.role !== 'supervisor') {
        filteredReviews = filteredReviews.filter(r => r.employee_id === profile.id);
      }
      dispatchAppData({ type: 'SET_REVIEWS', payload: filteredReviews });
      idbSet('reviews', filteredReviews);
    } catch (err) {
      console.error('fetchReviews failed:', err.message);
      const cached = await idbGet('reviews');
      if (cached) { dispatchAppData({ type: 'SET_REVIEWS', payload: cached }); showOfflineCacheNotice(); }
    }
  };

  // 🟩 FIXED NOTIFICATIONS: Matches 'user_id' exactly as written in Supabase
  const notifiedIdsRef = useRef(new Set());
  const fetchNotifications = async (profile) => {
    if (!profile) return;
    try {
      const data = await notificationsRepository.listForUser(profile.id);
      // First load just seeds what's already been seen — only notifications
      // discovered on later polls (i.e. genuinely new) get dispatched to
      // channels like the browser-push strategy, so opening the app doesn't
      // fire a desktop popup for the user's entire notification history.
      const isFirstLoad = notifiedIdsRef.current.size === 0;
      data.forEach((n) => {
        if (!notifiedIdsRef.current.has(n.id)) {
          notifiedIdsRef.current.add(n.id);
          if (!isFirstLoad && !n.read) notificationDispatcher.dispatch(n);
        }
      });
      dispatchAppData({ type: 'SET_NOTIFICATIONS', payload: data });
    } catch (err) {
      console.error('fetchNotifications failed:', err.message);
    }
  };

  const handleNotificationsRead = async () => {
    if (!userProfile) return;
    try {
      await notificationsRepository.markAllRead(userProfile.id);
    } catch (err) {
      console.error('handleNotificationsRead failed:', err.message);
    }
    fetchNotifications(userProfile);
  };

  const loadAllAppData = async (profile) => {
    await Promise.all([
      fetchAllUsers(),
      fetchTasks(profile),
      fetchAttendance(),
      fetchLeaveRequests(profile),
      fetchContributions(),
      fetchHelpdeskTickets(profile),
      fetchReviews(profile),
      fetchNotifications(profile)
    ]);
    setInitialDataLoaded(true);
  };

  // 🟩 OFFLINE QUEUE: registers how a queued "submitLeaveRequest" mutation
  // gets replayed once connectivity returns (see OfflineMutationQueue).
  useEffect(() => {
    offlineMutationQueue.registerHandler('submitLeaveRequest', async (payload) => {
      await leaveRepository.insert(payload);
      if (userProfile) fetchLeaveRequests(userProfile);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile?.id]);

   useEffect(() => {
   supabase.auth.getSession().then(({ data: { session } }) => {
     setSession(session);
     if (session?.user) fetchProfile(session.user.id);
   });

   const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
     setSession(session);
     if (session?.user) fetchProfile(session.user.id);
     else setUserProfile(null);
   });

   return () => subscription.unsubscribe();
   // Intentional run-once mount effect; fetchProfile isn't memoized, so listing
   // it here would re-subscribe the auth listener every render.
   // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

  useEffect(() => {
    if (userProfile) loadAllAppData(userProfile);
    // Intentional: only re-run when userProfile changes. loadAllAppData isn't
    // memoized, so including it would refetch everything on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile]);

  // 🟩 LIVE DATA: Supabase Realtime subscriptions layered on top of the
  // existing fetches so tasks/attendance/leave/etc. update near-instantly
  // when anyone changes them, instead of waiting for the next manual
  // refetch. Purely additive — if realtime replication isn't enabled for
  // a table in the Supabase project settings, its subscription just never
  // fires and the app behaves exactly as before.
  useEffect(() => {
    if (!userProfile) return;
    const unsubscribers = [
      subscribeToTable('tasks', () => fetchTasks(userProfile)),
      subscribeToTable('attendance', () => fetchAttendance()),
      subscribeToTable('leave_requests', () => fetchLeaveRequests(userProfile)),
      subscribeToTable('contributions', () => fetchContributions()),
      subscribeToTable('contribution_replies', () => fetchContributions()),
      subscribeToTable('helpdesk_tickets', () => fetchHelpdeskTickets(userProfile)),
      subscribeToTable('helpdesk_replies', () => fetchHelpdeskTickets(userProfile)),
      subscribeToTable('performance_evaluations', () => fetchReviews(userProfile)),
      subscribeToTable('notifications', () => fetchNotifications(userProfile)),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile?.id]);

  // 🟩 NEW: Notifications only ever loaded once (on login/mount). If someone
  // else's action (e.g. a leave request or approval) creates a notification
  // for this user while their tab is already open, they'd never see it
  // without reloading the page. Poll periodically instead. Deliberately
  // scoped to userProfile?.id (a stable primitive), not the whole userProfile
  // object, so this doesn't restart every time the profile object reference
  // changes from an unrelated fetch.
  useEffect(() => {
    if (!userProfile?.id) return;
    const intervalId = setInterval(() => {
      fetchNotifications(userProfile);
    }, 20000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile?.id]);

  // Scrolls the content pane back to the top on every view switch — without
  // this, navigating away from a page scrolled halfway down (e.g. the task
  // board) left the next view already scrolled, cutting off its header.
  useEffect(() => {
    document.getElementById('main-content')?.scrollTo({ top: 0 });
  }, [activeView]);

  // Shows the onboarding tour once per role (supervisor vs employee see
  // different steps), the first time that role logs in on this browser.
  useEffect(() => {
    if (!userProfile?.role) return;
    const seen = localStorage.getItem(`onboarding_seen_${userProfile.role}`);
    if (!seen) setShowOnboarding(true);
  }, [userProfile?.role]);

  const dismissOnboarding = () => {
    if (userProfile?.role) localStorage.setItem(`onboarding_seen_${userProfile.role}`, 'true');
    setShowOnboarding(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUserProfile(null);
    setSession(null);
    setInitialDataLoaded(false);
  };

  if (!session) {
    return (
      <>
        <Toaster position="top-right" />
        <React.Suspense fallback={<PageSkeleton />}>
          <LoginPage />
        </React.Suspense>
      </>
    );
  }

  if (!userProfile) {
    return (
      <div className="flex justify-center items-center h-screen bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <div className="h-12 w-12 bg-blue-600 rounded-full"></div>
          <div className="text-sm font-bold tracking-wider">Synchronizing Portal Instance...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen font-sans bg-gray-50 dark:bg-slate-900 transition-colors duration-200">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:bg-blue-600 focus:text-white focus:px-4 focus:py-2 focus:rounded-lg focus:font-bold focus:text-sm"
      >
        {t('common.skipToContent')}
      </a>
      <div className="no-print">
        <Toaster position="top-right" toastOptions={{ className: 'dark:bg-gray-700 dark:text-white' }} />
        <ConfirmDialogHost />
        <FeatureFlagPanel />
        <CommandPalette
          setActiveView={setActiveView}
          userProfile={userProfile}
          isDarkMode={isDarkMode}
          toggleDarkMode={toggleDarkMode}
          tasks={tasks}
          contributions={contributions}
          leaveRequests={leaveRequests}
          allUsers={allUsers}
        />
      </div>

      <div className="no-print">
        <Sidebar userProfile={userProfile} activeView={activeView} setActiveView={setActiveView} isMobileOpen={isMobileOpen} setIsMobileOpen={setIsMobileOpen} openTicketCount={helpdeskTickets.filter(ticket => ticket.ticket_status === 'Open').length} />
      </div>

      <div className="app-content-shell flex-1 flex flex-col md:ml-64 transition-all duration-300 relative w-full">
        <div className="no-print">
          <Header
            userProfile={userProfile}
            onLogout={handleLogout}
            notifications={notifications}
            onNotificationsRead={handleNotificationsRead}
            isDarkMode={isDarkMode}
            toggleDarkMode={toggleDarkMode}
            toggleMobileSidebar={() => setIsMobileOpen(!isMobileOpen)}
            tasks={tasks}
            contributions={contributions}
            leaveRequests={leaveRequests}
            allUsers={allUsers}
            setActiveView={setActiveView}
          />
        </div>

        <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto p-0 relative">
          {!initialDataLoaded ? <PageSkeleton /> : <React.Suspense fallback={<PageSkeleton />}><MainContent
            view={activeView}
            setActiveView={setActiveView}
            userProfile={userProfile}
            allUsers={allUsers}
            fetchAllUsers={fetchAllUsers}
            tasks={tasks}
            fetchTasks={() => fetchTasks(userProfile)}
            attendance={attendance}
            fetchAttendance={() => fetchAttendance()}
            leaveRequests={leaveRequests}
            fetchLeaveRequests={() => fetchLeaveRequests(userProfile)}
            contributions={contributions}
            fetchContributions={() => fetchContributions()}
            helpdeskTickets={helpdeskTickets}
            fetchHelpdeskTickets={() => fetchHelpdeskTickets(userProfile)}
            fetchProfile={() => fetchProfile(userProfile.id)}
            reviews={reviews}
            colorblindMode={colorblindMode}
            setColorblindMode={setColorblindMode}
            fontSize={fontSize}
            setFontSize={setFontSize}
            highContrast={highContrast}
            setHighContrast={setHighContrast}
            reduceMotion={reduceMotion}
            setReduceMotion={setReduceMotion}
            isDarkMode={isDarkMode}
            toggleDarkMode={toggleDarkMode}
            onReplayOnboarding={() => setShowOnboarding(true)}
            onlineUserIds={onlineUserIds}
          /></React.Suspense>}
        </main>
      </div>

      {/* Rendered as a sibling of .app-content-shell, not inside it — ChatBot
          is position:fixed, and a `filter` on an ancestor (high-contrast /
          colorblind mode) becomes that ancestor's fixed-position containing
          block, which would detach the chat bubble from the viewport. */}
      <div className="no-print">
        <ChatBot userProfile={userProfile} tasks={tasks} />
      </div>

      {showOnboarding && (
        <div className="no-print">
          <OnboardingTour userProfile={userProfile} onClose={dismissOnboarding} />
        </div>
      )}
    </div>
  );
}