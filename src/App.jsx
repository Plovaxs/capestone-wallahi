import React, { useState, useEffect, useRef, useReducer } from 'react';
import { appDataReducer, initialAppDataState } from './state/appDataReducer';
import { useTranslation } from 'react-i18next';
import { supabase } from './supabaseClient';
import toast from 'react-hot-toast';
import AppToaster from './components/AppToaster';
import { idbSet, idbGet } from './offline/indexedDbCache';
import { offlineMutationQueue } from './offline/OfflineMutationQueue';
import { profilesRepository } from './data/repositories/profilesRepository';
import { tasksRepository } from './data/repositories/tasksRepository';
import { taskSubmissionsRepository } from './data/repositories/taskSubmissionsRepository';
import { attendanceRepository } from './data/repositories/attendanceRepository';
import { leaveRepository } from './data/repositories/leaveRepository';
import { contributionsRepository } from './data/repositories/contributionsRepository';
import { helpdeskRepository } from './data/repositories/helpdeskRepository';
import { reviewsRepository } from './data/repositories/reviewsRepository';
import { notificationsRepository } from './data/repositories/notificationsRepository';
import { showUserError } from './utils/errorHandling';
import { performClockIn } from './domain/attendanceClockIn';
import { consumeFaceVerifiedLoginFlag } from './domain/faceLoginClockInFlag';
import { calculateDistanceMeters, OFFICE_LOCATION, ALLOWED_RADIUS_METERS } from './geo/officeGeofence';
import { notificationDispatcher } from './patterns/notificationChannels/NotificationDispatcher';
import { subscribeToTable } from './realtime/subscribeToTable';
import { usePresence } from './realtime/usePresence';
import { usePageVisibility } from './hooks/usePageVisibility';

import Header from './components/Header';
import Sidebar from './components/Sidebar';
import OnboardingTour from './components/OnboardingTour';
import ConfirmDialogHost from './components/ConfirmDialogHost';
import CommandPalette from './components/CommandPalette';
import PageSkeleton from './components/PageSkeleton';
import FeatureFlagPanel from './components/FeatureFlagPanel';
import NetworkStatusBanner from './components/NetworkStatusBanner';

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
const ErrorMonitorView = React.lazy(() => import('./views/ErrorMonitorView'));
const AuditLogView = React.lazy(() => import('./views/AuditLogView'));
const ContractExpiryView = React.lazy(() => import('./views/ContractExpiryView'));
const FleetHealthView = React.lazy(() => import('./views/FleetHealthView'));

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
    case 'errorMonitor': return <ErrorMonitorView userProfile={userProfile} />;
    case 'auditLog': return <AuditLogView userProfile={userProfile} allUsers={props.allUsers} />;
    case 'contractExpiry': return <ContractExpiryView userProfile={userProfile} allUsers={props.allUsers} />;
    case 'fleetHealth': return <FleetHealthView userProfile={userProfile} allUsers={props.allUsers} />;
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
  const { allUsers, tasks, taskSubmissions, attendance, leaveRequests, contributions, helpdeskTickets, reviews, notifications } = appData;

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
  const isTabVisible = usePageVisibility();
  const hasHandledInitialVisibilityRef = useRef(false);

  // 🟩 SILENT-FAILURE FIX: every fetch below used to catch its own error
  // with nothing but a console.error -- no toast, nothing reported to the
  // Error Monitor. A genuinely broken fetch (a schema mismatch from a
  // pending migration, an RLS misconfiguration, whatever) left its section
  // of the app quietly empty forever with zero on-screen indication
  // anything was wrong. This still falls back to the last cached
  // IndexedDB snapshot first (the normal, benign offline case -- shown via
  // the existing quiet "showing cached data" notice, unchanged), but now
  // surfaces a real, visible error when there's truly nothing to fall
  // back to, so a genuine bug can't hide behind silence again.
  const recoverFromFetchFailure = async (contextKey, err, cacheKey, onCacheHit) => {
    console.error(contextKey, err.message);
    const cached = cacheKey ? await idbGet(cacheKey) : null;
    if (cached) {
      onCacheHit(cached);
      showOfflineCacheNotice();
    } else {
      showUserError(contextKey, err);
    }
  };

  const fetchProfile = async (userId) => {
    if (!userId) return;
    try {
      const data = await profilesRepository.getById(userId);
      if (data) {
        // 🟩 API WASTE FIX: Supabase silently re-fires the auth listener on
        // TOKEN_REFRESHED (roughly hourly) and on tab refocus in some
        // setups — each one called fetchProfile and handed React a brand
        // new object even when nothing about the profile had actually
        // changed. Every effect keyed on `userProfile` throughout the app
        // (data reloads, the webcam, geolocation, model loading...) then
        // saw that as a "change" and re-ran. Comparing against the current
        // value first means a no-op refresh doesn't cascade into a wave of
        // unnecessary refetches and restarts.
        setUserProfile((prev) => (prev && JSON.stringify(prev) === JSON.stringify(data) ? prev : data));
      } else {
        console.warn('Profile row missing or cleared from schema database.');
        handleLogout();
      }
    } catch (err) {
      console.error('fetchProfile failed:', err.message);
      showUserError('errors.fetchProfile', err);
    }
  };

  const fetchAllUsers = async () => {
    try {
      dispatchAppData({ type: 'SET_ALL_USERS', payload: await profilesRepository.listAll() });
    } catch (err) {
      showUserError('errors.fetchAllUsers', err);
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
      await recoverFromFetchFailure('errors.fetchTasks', err, 'tasks', (cached) => dispatchAppData({ type: 'SET_TASKS', payload: cached }));
    }
  };

  // 🟩 Per-assignee task submissions -- RLS already scopes this to what the
  // caller is actually allowed to see (supervisor: all; employee: their
  // own + any task they're assigned to), so no client-side filtering needed.
  const fetchTaskSubmissions = async () => {
    try {
      const data = await taskSubmissionsRepository.listAll();
      dispatchAppData({ type: 'SET_TASK_SUBMISSIONS', payload: data || [] });
      idbSet('taskSubmissions', data || []);
    } catch (err) {
      await recoverFromFetchFailure('errors.fetchTaskSubmissions', err, 'taskSubmissions', (cached) => dispatchAppData({ type: 'SET_TASK_SUBMISSIONS', payload: cached }));
    }
  };

  const fetchAttendance = async () => {
    try {
      const data = await attendanceRepository.listAll();
      dispatchAppData({ type: 'SET_ATTENDANCE', payload: data });
      idbSet('attendance', data);
    } catch (err) {
      await recoverFromFetchFailure('errors.fetchAttendance', err, 'attendance', (cached) => dispatchAppData({ type: 'SET_ATTENDANCE', payload: cached }));
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
      await recoverFromFetchFailure('errors.fetchLeaveRequests', err, 'leaveRequests', (cached) => dispatchAppData({ type: 'SET_LEAVE_REQUESTS', payload: cached }));
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
      await recoverFromFetchFailure('errors.fetchContributions', err, 'contributions', (cached) => dispatchAppData({ type: 'SET_CONTRIBUTIONS', payload: cached }));
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
      await recoverFromFetchFailure('errors.fetchHelpdeskTickets', err, 'helpdeskTickets', (cached) => dispatchAppData({ type: 'SET_HELPDESK_TICKETS', payload: cached }));
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
      await recoverFromFetchFailure('errors.fetchReviews', err, 'reviews', (cached) => dispatchAppData({ type: 'SET_REVIEWS', payload: cached }));
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
      showUserError('errors.fetchNotifications', err);
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
      fetchTaskSubmissions(),
      fetchAttendance(),
      fetchLeaveRequests(profile),
      fetchContributions(),
      fetchHelpdeskTickets(profile),
      fetchReviews(profile),
      fetchNotifications(profile)
    ]);
    setInitialDataLoaded(true);
  };

  /**
   * TRANSACTION: attemptAutoClockInAfterLogin
   * PURPOSE: if this session was just established via a live, just-verified
   * face scan (markFaceVerifiedLogin/consumeFaceVerifiedLoginFlag -- see
   * domain/faceLoginClockInFlag.js) and the employee hasn't clocked in yet
   * today, clock them in immediately instead of making them visit
   * Attendance separately just to press essentially the same "verify my
   * face" button again. Deliberately silent on every failure path
   * (already clocked in, out of range, no GPS permission, db error) --
   * this is a convenience shortcut layered on top of the real flow, not a
   * replacement for it. Attendance's manual "Clock In Shift" button is
   * kept exactly as-is for anyone who logs in with a password, whose
   * auto clock-in didn't fire for some reason, or who just prefers it.
   */
  const attemptAutoClockInAfterLogin = async (profile) => {
    if (!profile || profile.role !== 'employee') return;
    if (!consumeFaceVerifiedLoginFlag()) return;

    const today = new Date().toISOString().split('T')[0];

    try {
      // Cheap pre-check before touching geolocation at all -- avoids an
      // unnecessary GPS permission prompt on a login where the employee
      // already clocked in earlier today through some other route.
      // performClockIn below still re-checks this itself right before its
      // own insert (the actual race-safe guard); this is purely a
      // fast-exit to skip the location step, not a correctness dependency.
      const { data: existing } = await supabase
        .from('attendance')
        .select('id')
        .eq('employee_id', profile.id)
        .eq('date', today)
        .maybeSingle();
      if (existing) return;
    } catch {
      return;
    }

    const workMode = profile.work_mode || 'WFO';
    let coords = null;
    let isInRange = true;

    if (workMode !== 'WFH') {
      if (!navigator.geolocation) return;
      try {
        const position = await new Promise((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8000 })
        );
        coords = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        const distance = calculateDistanceMeters(coords.latitude, coords.longitude, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
        isInRange = distance <= ALLOWED_RADIUS_METERS;
      } catch {
        // No location fix/permission -- silently skip. The employee can
        // still clock in manually from Attendance, which will surface the
        // same GPS/geofence states clearly if that's what's blocking them.
        return;
      }
    }

    const result = await performClockIn({ userProfile: profile, coords, isInRange, today, source: 'face-login' });
    if (result.success) {
      toast.success(t('attendance.autoClockInSuccess'));
      fetchAttendance();
    }
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

  // 🟩 API WASTE FIX: this previously depended on the whole `userProfile`
  // object, not its id — but `fetchProfile` sets a brand-new object on
  // *every* auth event, including the silent TOKEN_REFRESHED Supabase
  // fires roughly once an hour to keep the session alive (and on tab
  // refocus in some setups). That was re-running this 8-call bulk load
  // (tasks/attendance/leave/contributions/helpdesk/reviews/notifications/
  // allUsers) every time, for every open tab, even though nothing about
  // the logged-in user had actually changed. Depending on the id (a
  // stable primitive) instead means it only fires on an actual login or
  // user switch.
  useEffect(() => {
    if (userProfile) {
      loadAllAppData(userProfile).then(() => attemptAutoClockInAfterLogin(userProfile));
    }
    // Intentional: only re-run when the logged-in user actually changes.
    // loadAllAppData/attemptAutoClockInAfterLogin aren't memoized, so
    // listing them would refetch everything on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile?.id]);

  // 🟩 LIVE DATA: Supabase Realtime subscriptions layered on top of the
  // existing fetches so tasks/attendance/leave/etc. update near-instantly
  // when anyone changes them, instead of waiting for the next manual
  // refetch. Purely additive — if realtime replication isn't enabled for
  // a table in the Supabase project settings, its subscription just never
  // fires and the app behaves exactly as before.
  useEffect(() => {
    if (!userProfile) return;

    // 🟩 CONNECTION HEALTH: 9 independent channels each report their own
    // status — without coalescing, a single network blip would fire up to
    // 9 separate "reconnecting" toasts at once. Track how many are
    // currently degraded and only show one toast for the whole group,
    // dismissing it once every channel is healthy again.
    const degradedChannels = new Set();
    const handleHealthChange = (channelLabel) => (status) => {
      if (status === 'SUBSCRIBED') {
        degradedChannels.delete(channelLabel);
        if (degradedChannels.size === 0) toast.dismiss('realtime-reconnecting');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        degradedChannels.add(channelLabel);
        toast(t('offline.reconnectingLiveUpdates'), { id: 'realtime-reconnecting', icon: '🔄', duration: Infinity });
      }
    };

    const unsubscribers = [
      subscribeToTable('tasks', () => fetchTasks(userProfile), { onHealthChange: handleHealthChange('tasks') }),
      subscribeToTable('task_submissions', () => fetchTaskSubmissions(), { onHealthChange: handleHealthChange('task_submissions') }),
      subscribeToTable('attendance', () => fetchAttendance(), { onHealthChange: handleHealthChange('attendance') }),
      subscribeToTable('leave_requests', () => fetchLeaveRequests(userProfile), { onHealthChange: handleHealthChange('leave_requests') }),
      subscribeToTable('contributions', () => fetchContributions(), { onHealthChange: handleHealthChange('contributions') }),
      subscribeToTable('contribution_replies', () => fetchContributions(), { onHealthChange: handleHealthChange('contribution_replies') }),
      subscribeToTable('helpdesk_tickets', () => fetchHelpdeskTickets(userProfile), { onHealthChange: handleHealthChange('helpdesk_tickets') }),
      subscribeToTable('helpdesk_replies', () => fetchHelpdeskTickets(userProfile), { onHealthChange: handleHealthChange('helpdesk_replies') }),
      subscribeToTable('performance_evaluations', () => fetchReviews(userProfile), { onHealthChange: handleHealthChange('performance_evaluations') }),
      subscribeToTable('notifications', () => fetchNotifications(userProfile), { onHealthChange: handleHealthChange('notifications') }),
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      toast.dismiss('realtime-reconnecting');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile?.id]);

  // 🟩 NEW: Notifications only ever loaded once (on login/mount). If someone
  // else's action (e.g. a leave request or approval) creates a notification
  // for this user while their tab is already open, they'd never see it
  // without reloading the page. The realtime subscription on 'notifications'
  // above already covers this instantly — this interval is now just a rare
  // fallback for the case that channel silently misses an event, so it runs
  // every few minutes instead of every 20s (which was ~180 extra REST calls
  // per hour, per open tab, for something realtime already handles).
  // Deliberately scoped to userProfile?.id (a stable primitive), not the
  // whole userProfile object, so this doesn't restart on unrelated fetches.
  // 🟩 PAGE VISIBILITY: no reason to keep polling every few minutes while
  // the tab is backgrounded/minimized and nobody's looking at it — that's
  // pure waste. Pauses the interval entirely while hidden, and does one
  // immediate refresh (not just resuming the timer) the moment the tab
  // *returns* to visible, so coming back to the tab shows current data
  // right away instead of waiting up to 3 more minutes. Skips that extra
  // fetch on the very first mount — loadAllAppData already covers the
  // initial load.
  useEffect(() => {
    if (!userProfile?.id || !isTabVisible) return;
    if (hasHandledInitialVisibilityRef.current) fetchNotifications(userProfile);
    hasHandledInitialVisibilityRef.current = true;
    const intervalId = setInterval(() => {
      fetchNotifications(userProfile);
    }, 180000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile?.id, isTabVisible]);

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
        <AppToaster />
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
        <AppToaster toastOptions={{ className: 'dark:bg-gray-700 dark:text-white' }} />
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

        <NetworkStatusBanner />

        <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto p-0 relative">
          {!initialDataLoaded ? <PageSkeleton /> : <React.Suspense fallback={<PageSkeleton />}><MainContent
            view={activeView}
            setActiveView={setActiveView}
            userProfile={userProfile}
            allUsers={allUsers}
            fetchAllUsers={fetchAllUsers}
            tasks={tasks}
            fetchTasks={() => fetchTasks(userProfile)}
            taskSubmissions={taskSubmissions}
            fetchTaskSubmissions={fetchTaskSubmissions}
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

      {showOnboarding && (
        <div className="no-print">
          <OnboardingTour userProfile={userProfile} onClose={dismissOnboarding} />
        </div>
      )}
    </div>
  );
}