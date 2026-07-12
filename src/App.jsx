import React, { useState, useEffect, useRef } from 'react';
import { supabase } from './supabaseClient';
import { Toaster, toast } from 'react-hot-toast';
import * as faceapi from 'face-api.js';

import Header from './components/Header';
import Sidebar from './components/Sidebar';
import ChatBot from './components/ChatBot';

import LoginPage from './views/LoginPage';
import DashboardView from './views/DashboardView';
import AttendanceView from './views/AttendanceView';
import TasksView from './views/TasksView';
import ContributionsView from './views/ContributionsView';
import LeaveView from './views/LeaveView';
import PerformanceReviewView from './views/PerformanceReviewView';
import SettingsView from './views/SettingsView';

const MainContent = ({ view, userProfile, ...props }) => {
  switch (view) {
    case 'dashboard': return <DashboardView {...props} userProfile={userProfile} />;
    case 'attendance': return <AttendanceView {...props} userProfile={userProfile} />;
    case 'tasks': return <TasksView {...props} userProfile={userProfile} createNotification={props.createNotification} />;
    case 'contributions': return <ContributionsView {...props} userProfile={userProfile} />;
    case 'leave': return <LeaveView {...props} userProfile={userProfile} createNotification={props.createNotification} fetchProfile={props.fetchProfile} />;
    case 'reviews': return <PerformanceReviewView {...props} userProfile={userProfile} createNotification={props.createNotification} />;
    case 'settings': return <SettingsView {...props} userProfile={userProfile} fetchProfile={props.fetchProfile} />;
    default: return <DashboardView {...props} userProfile={userProfile} />;
  }
};

export default function App() {
  const [session, setSession] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [contributions, setContributions] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [activeView, setActiveView] = useState('dashboard');
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  const toggleDarkMode = () => setIsDarkMode(!isDarkMode);

  const fetchProfile = async (userId) => {
    if (!userId) return;
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (!error && data) {
      setUserProfile(data);
    } else {
      console.warn('Profile row missing or cleared from schema database.');
      if (!data) handleLogout(); 
    }
  };

  const fetchAllUsers = async () => {
    const { data, error } = await supabase.from('profiles').select('*');
    if (!error && data) setAllUsers(data);
  };

  // 🟩 ROBUST FIX: Fetches all data first, then filters via JS to prevent Postgres column-type crashes
  const fetchTasks = async (profile) => {
    if (!profile) return;
    const { data, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (error) console.error("fetchTasks DB Error:", error.message);
    
    let filteredTasks = data || [];
    if (profile.role !== 'supervisor') {
      filteredTasks = filteredTasks.filter(t => (t.assigned_to || []).includes(profile.id));
    }
    setTasks(filteredTasks);
  };

  const fetchAttendance = async () => {
    const { data, error } = await supabase.from('attendance').select('*').order('date', { ascending: false });
    if (error) console.error("fetchAttendance DB Error:", error.message);
    setAttendance(data || []);
  };

  const fetchLeaveRequests = async (profile) => {
    if (!profile) return;
    const { data, error } = await supabase.from('leave_requests').select('*').order('start_date', { ascending: false });
    if (error) console.error("fetchLeaveRequests DB Error:", error.message);
    
    let filteredLeave = data || [];
    if (profile.role !== 'supervisor') {
      filteredLeave = filteredLeave.filter(r => r.employee_id === profile.id);
    }
    setLeaveRequests(filteredLeave);
  };

  const fetchContributions = async () => {
    const { data, error } = await supabase.from('contributions').select('*').order('date', { ascending: false });
    if (error) console.error("fetchContributions DB Error:", error.message);
    setContributions(data || []);
  };

  // 🟩 ROBUST FIX: Corrected table name to 'performance_evaluations'
  const fetchReviews = async (profile) => {
    if (!profile) return;
    const { data, error } = await supabase.from('performance_evaluations').select('*').order('created_at', { ascending: false });
    if (error) console.error("fetchReviews DB Error:", error.message);
    
    let filteredReviews = data || [];
    if (profile.role !== 'supervisor') {
      filteredReviews = filteredReviews.filter(r => r.employee_id === profile.id);
    }
    setReviews(filteredReviews);
  };

  // 🟩 FIXED NOTIFICATIONS: Matches 'user_id' exactly as written in Supabase
  const fetchNotifications = async (profile) => {
    if (!profile) return;
    const { data, error } = await supabase.from('notifications').select('*').eq('user_id', profile.id).order('created_at', { ascending: false });
    if (error) console.error("fetchNotifications DB Error:", error.message);
    setNotifications(data || []);
  };

 const createNotification = async (profileId, message) => {
    try {
      const { data: existing } = await supabase
        .from('notifications')
        .select('id')
        .eq('user_id', profileId)
        .eq('message', message)
        .maybeSingle();

      if (existing) return;

      const { error } = await supabase.from('notifications').insert([{ user_id: profileId, message, read: false }]);
      
      if (error) {
        console.error("createNotification DB Error:", error.message);
        alert("⚠️ Notification Blocked! " + error.message + " (Turn off RLS on the notifications table in Supabase)");
      } else {
        // 🟩 FIX: If you sent the notification to yourself, refresh the bell icon instantly!
        if (userProfile && profileId === userProfile.id) {
          fetchNotifications(userProfile);
        }
      }
    } catch (err) {
      console.error('Unexpected tracking alert pipeline break:', err);
    }
  };

  const handleNotificationsRead = async () => {
    if (!userProfile) return;
    await supabase.from('notifications').update({ read: true }).eq('user_id', userProfile.id);
    fetchNotifications(userProfile);
  };

  const loadAllAppData = async (profile) => {
    await Promise.all([
      fetchAllUsers(),
      fetchTasks(profile),
      fetchAttendance(),
      fetchLeaveRequests(profile),
      fetchContributions(),
      fetchReviews(profile),
      fetchNotifications(profile)
    ]);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user) fetchProfile(session.user.id);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      
      if (event === 'SIGNED_OUT') {
        setUserProfile(null);
        return;
      }

      if (session?.user) {
        fetchProfile(session.user.id);
      } else {
        setUserProfile(null);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (userProfile) loadAllAppData(userProfile);
  }, [userProfile]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUserProfile(null);
    setSession(null);
  };

  if (!session) {
    return (
      <>
        <Toaster position="top-right" />
        <LoginPage />
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
      <Toaster position="top-right" toastOptions={{ className: 'dark:bg-gray-700 dark:text-white' }} />

      <Sidebar userProfile={userProfile} activeView={activeView} setActiveView={setActiveView} isMobileOpen={isMobileOpen} setIsMobileOpen={setIsMobileOpen} />

      <div className="flex-1 flex flex-col md:ml-64 transition-all duration-300 relative w-full">
        <Header userProfile={userProfile} onLogout={handleLogout} notifications={notifications} onNotificationsRead={handleNotificationsRead} isDarkMode={isDarkMode} toggleDarkMode={toggleDarkMode} toggleMobileSidebar={() => setIsMobileOpen(!isMobileOpen)} />

        <main className="flex-1 overflow-y-auto p-0 relative">
          <MainContent
            view={activeView}
            userProfile={userProfile}
            allUsers={allUsers}
            tasks={tasks}
            fetchTasks={() => fetchTasks(userProfile)}
            attendance={attendance}
            fetchAttendance={() => fetchAttendance()}
            leaveRequests={leaveRequests}
            fetchLeaveRequests={() => fetchLeaveRequests(userProfile)}
            contributions={contributions}
            fetchContributions={() => fetchContributions()}
            fetchProfile={() => fetchProfile(userProfile.id)}
            createNotification={createNotification}
            reviews={reviews}
          />
          <ChatBot userProfile={userProfile} tasks={tasks} />
        </main>
      </div>
    </div>
  );
}