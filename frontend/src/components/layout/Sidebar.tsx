import { NavLink } from 'react-router-dom';
import {
  UserCircle,
  LogOut,
  Briefcase,
  Settings,
} from 'lucide-react';

interface SidebarProps {
  userEmail?: string;
  userName?: string;
  onLogout: () => void;
}

const navItems = [
  { to: '/scraper', label: 'Jobs', icon: Briefcase },
  { to: '/profile', label: 'Profile', icon: UserCircle },
];

export function Sidebar({ userEmail, userName, onLogout }: SidebarProps) {
  const displayName = userName || userEmail || 'User';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <aside className="flex flex-col w-60 bg-white border-r border-slate-200 h-full">
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-slate-100">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-600 text-white font-bold text-sm">
          JS
        </div>
        <span className="font-semibold text-slate-800 text-[15px]">Job Scraper</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-slate-100 px-3 py-2">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              isActive
                ? 'bg-blue-50 text-blue-700'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`
          }
        >
          <Settings size={18} />
          Settings
        </NavLink>
      </div>

      <div className="border-t border-slate-100 px-3 py-3">
        <div className="flex items-center gap-2.5 px-2 mb-2">
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-200 text-slate-700 font-semibold text-xs">
            {initial}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800 truncate">{displayName}</p>
            {userEmail && userName && (
              <p className="text-xs text-slate-500 truncate">{userEmail}</p>
            )}
          </div>
        </div>
        <button
          onClick={onLogout}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-600 hover:bg-red-50 hover:text-red-700 rounded-lg transition-colors"
        >
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
