import { NavLink } from 'react-router-dom';
import {
  UserCircle,
  LogOut,
  Briefcase,
  Settings,
  LayoutTemplate,
  Moon,
  Sun,
} from 'lucide-react';
import { useThemeStore } from '../../stores/themeStore';

interface SidebarProps {
  userEmail?: string;
  userName?: string;
  onLogout: () => void;
}

function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="group flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
    >
      <span className="flex items-center gap-3">
        {isDark ? (
          <Moon size={18} className="text-indigo-400" />
        ) : (
          <Sun size={18} className="text-amber-500" />
        )}
        {isDark ? 'Dark mode' : 'Light mode'}
      </span>
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-300 ${
          isDark ? 'bg-indigo-500' : 'bg-slate-300'
        }`}
      >
        <span
          className={`inline-flex h-4 w-4 transform items-center justify-center rounded-full bg-white shadow-sm transition-transform duration-300 ${
            isDark ? 'translate-x-[18px]' : 'translate-x-[2px]'
          }`}
        >
          {isDark ? (
            <Moon size={10} className="text-indigo-500" />
          ) : (
            <Sun size={10} className="text-amber-500" />
          )}
        </span>
      </span>
    </button>
  );
}

const navItems = [
  { to: '/scraper', label: 'Jobs', icon: Briefcase },
  { to: '/profile', label: 'Profile', icon: UserCircle },
  { to: '/resume-builder', label: 'Resume Builder', icon: LayoutTemplate },
];

export function Sidebar({ userEmail, userName, onLogout }: SidebarProps) {
  const displayName = userName || userEmail || 'User';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <aside className="flex flex-col w-60 bg-white border-r border-slate-200 h-full">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-100">
        <img src="/atomspace-logo.png" alt="Atomspace" className="h-8 w-auto object-contain" />
        <span className="font-semibold text-slate-800 text-[15px]">Atomspace</span>
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
        <ThemeToggle />
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
