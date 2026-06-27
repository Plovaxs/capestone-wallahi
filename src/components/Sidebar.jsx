import React from 'react';
import { Icons } from './Icons';

const Sidebar = ({ userProfile, activeView, setActiveView, isMobileOpen, setIsMobileOpen }) => {
  
  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: Icons.LayoutDashboard },
    { id: 'tasks', label: 'My Tasks', icon: Icons.ClipboardList },
    { id: 'attendance', label: 'Attendance', icon: Icons.CalendarDays },
    { id: 'leave', label: 'Leave Requests', icon: Icons.CalendarDays },
    { id: 'contributions', label: 'Contributions', icon: Icons.Trophy },
    { id: 'reviews', label: 'Performance', icon: Icons.UserCircle, supervisorOnly: true },
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
            <span className="font-bold text-gray-800 dark:text-white">Menu</span>
        </div>

        {/* Navigation Links */}
        <nav className="flex-grow p-4 space-y-2 overflow-y-auto">
          <div className="text-xs font-bold text-gray-400 uppercase mb-2 px-3 tracking-wider">Apps</div>
          
          {menuItems.map(item => {
            if (item.supervisorOnly && userProfile?.role !== 'supervisor') return null;
            
            const isActive = activeView === item.id;
            
            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
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
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Settings Link */}
        <div className="p-4 border-t border-gray-100 dark:border-gray-700">
            <button 
                onClick={() => handleNavClick('settings')} 
                className={`
                    w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium transition-all duration-200 group
                    ${activeView === 'settings' 
                        ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white font-bold' 
                        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }
                `}
            >
                <span className="text-xl">⚙️</span> 
                <span>Settings</span>
            </button>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;