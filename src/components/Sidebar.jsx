import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Icons } from './Icons';

const Sidebar = ({ userProfile, activeView, setActiveView, isMobileOpen, setIsMobileOpen, openTicketCount = 0 }) => {
  const { t } = useTranslation();

  // 🟩 ACCESSIBILITY: the mobile backdrop was a bare div with only an
  // onClick — unreachable and undismissable via keyboard. Escape matches
  // how every other overlay in this app (Modal, CommandPalette, etc.)
  // closes, without making the backdrop itself an unusual tab stop.
  useEffect(() => {
    if (!isMobileOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setIsMobileOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isMobileOpen, setIsMobileOpen]);

  const menuItems = [
    { id: 'dashboard', label: t('nav.dashboard'), icon: Icons.LayoutDashboard },
    { id: 'tasks', label: t('nav.myTasks'), icon: Icons.ClipboardList },
    { id: 'attendance', label: t('nav.attendance'), icon: Icons.CalendarDays },
    { id: 'leave', label: t('nav.leaveRequests'), icon: Icons.CalendarDays },
    { id: 'contributions', label: t('nav.contributions'), icon: Icons.Trophy },
    { id: 'helpdesk', label: t('nav.helpdesk'), icon: Icons.LifeBuoy, badge: openTicketCount },
    { id: 'reviews', label: t('nav.performance'), icon: Icons.UserCircle, supervisorOnly: true },
    { id: 'auditLog', label: t('nav.auditLog'), icon: Icons.ClipboardCheck, supervisorOnly: true },
    { id: 'fleetHealth', label: t('nav.fleetHealth'), icon: Icons.CpuChip, supervisorOnly: true },
    { id: 'errorMonitor', label: t('nav.errorMonitor'), icon: Icons.AlertTriangle, supervisorOnly: true },
  ];

  const handleNavClick = (id) => {
    setActiveView(id);
    setIsMobileOpen(false); 
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {isMobileOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 md:hidden backdrop-blur-sm transition-opacity"
          onClick={() => setIsMobileOpen(false)}
        />
      )}

      {/* SIDEBAR - Fixed Position Fix */}
      <aside 
        className={`
          fixed inset-y-0 left-0 z-50
          w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700
          transform transition-transform duration-300 ease-in-out
          ${isMobileOpen ? 'translate-x-0' : '-translate-x-full'} 
          md:translate-x-0 
          flex flex-col shadow-2xl md:shadow-none
        `}
      >
        {/* Mobile Header (Optional) */}
        <div className="h-16 flex items-center justify-center border-b border-gray-100 dark:border-gray-700 md:hidden">
            <span className="font-bold text-gray-800 dark:text-white">{t('nav.menu')}</span>
        </div>

        {/* Navigation Links */}
        <nav className="flex-grow p-4 space-y-2 overflow-y-auto">
          <div className="text-xs font-bold text-gray-400 uppercase mb-2 px-3 tracking-wider">{t('nav.apps')}</div>
          
          {menuItems.map(item => {
            if (item.supervisorOnly && userProfile?.role !== 'supervisor') return null;
            
            const isActive = activeView === item.id;
            
            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`
                  w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium transition-all duration-200 group
                  ${isActive
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30' 
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-white'
                  }
                `}
              >
                <span className={isActive ? 'text-white' : 'text-gray-400 group-hover:text-blue-600 dark:text-gray-500 dark:group-hover:text-white'}>
                   {item.icon}
                </span>
                <span className="flex-1 text-left">{item.label}</span>
                {!!item.badge && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${isActive ? 'bg-white/25 text-white' : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'}`}>
                        {item.badge}
                    </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Settings Link */}
        <div className="p-4 border-t border-gray-100 dark:border-gray-700">
            <button
                onClick={() => handleNavClick('settings')}
                aria-current={activeView === 'settings' ? 'page' : undefined}
                className={`
                    w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium transition-all duration-200 group
                    ${activeView === 'settings' 
                        ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white font-bold' 
                        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }
                `}
            >
                <span className="text-xl">⚙️</span>
                <span>{t('nav.settings')}</span>
            </button>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;