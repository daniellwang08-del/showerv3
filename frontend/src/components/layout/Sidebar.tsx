import { NavLink } from 'react-router-dom';
import {
  UserCircle,
  LogOut,
  Briefcase,
  LayoutTemplate,
  Database,
  Users,
  Cpu,
  Moon,
  Sun,
  Puzzle,
  UserCog,
  Sparkles,
} from 'lucide-react';
import { useThemeStore } from '../../stores/themeStore';
import { useAgentStore } from '../../stores/agentStore';
import { BrandMark } from '../shared/BrandMark';

interface SidebarProps {
  userEmail?: string;
  userName?: string;
  isAdmin?: boolean;
  onLogout: () => void;
  /** Called when a nav link is activated (e.g. close mobile drawer). */
  onNavigate?: () => void;
  className?: string;
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

const applicantNavItems = [
  { to: '/scraper', label: 'Jobs', icon: Briefcase },
  { to: '/profile', label: 'Profile', icon: UserCircle },
  { to: '/preferences', label: 'My Preferences', icon: UserCog },
  { to: '/resume-builder', label: 'Resume Builder', icon: LayoutTemplate },
  { to: '/integrations', label: 'Integrations', icon: Puzzle },
];

/** Platform ops only — Integrations and AI Assistant are applicant tools. */
const adminNavItems = [
  { to: '/scraper', label: 'Jobs', icon: Briefcase },
  { to: '/data-analysis', label: 'Data Analysis', icon: Database },
  { to: '/user-management', label: 'User Management', icon: Users },
  { to: '/system-settings', label: 'System Settings', icon: Cpu },
];

export function Sidebar({
  userEmail,
  userName,
  isAdmin,
  onLogout,
  onNavigate,
  className = '',
}: SidebarProps) {
  const displayName = userName || userEmail || 'User';
  const initial = displayName.charAt(0).toUpperCase();
  const navItems = isAdmin ? adminNavItems : applicantNavItems;
  const agentOpen = useAgentStore((s) => s.open);
  const toggleChat = useAgentStore((s) => s.toggleChat);
  const showAssistant = !isAdmin;

  return (
    <aside
      className={`flex h-full w-60 max-w-full flex-col border-r border-slate-200 bg-white ${className}`.trim()}
    >
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
        <img src="/atomspace-logo.png" alt="Atomspace" className="h-8 w-auto object-contain" />
        <span className="text-[15px] font-semibold text-slate-800">Atomspace</span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={() => onNavigate?.()}
            title={label}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`
            }
          >
            <Icon size={18} className="shrink-0" />
            <span className="min-w-0 truncate">{label}</span>
          </NavLink>
        ))}
      </nav>

      {showAssistant ? (
        <div className="px-3 pb-2 pt-1">
          <button
            type="button"
            onClick={() => {
              onNavigate?.();
              toggleChat();
            }}
            aria-label={agentOpen ? 'Close AI assistant' : 'Open AI assistant'}
            aria-pressed={agentOpen}
            title="AI Assistant"
            className={[
              'oneclick-launcher-glow group flex w-full items-center gap-3 overflow-hidden rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-all',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300',
              agentOpen
                ? 'border-violet-400 bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-500 text-white shadow-md shadow-violet-500/30'
                : 'border-violet-200 bg-gradient-to-r from-indigo-50 via-violet-50 to-fuchsia-50 text-violet-800 shadow-sm hover:border-violet-300 hover:shadow-md',
            ].join(' ')}
          >
            {agentOpen ? (
              <BrandMark mood="idle" size="sm" />
            ) : (
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-500 text-white shadow-sm">
                <Sparkles size={15} strokeWidth={2.4} />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate leading-none">AI Assistant</span>
              <span className={`mt-1 block truncate text-[11px] font-medium leading-none ${agentOpen ? 'text-white/85' : 'text-violet-600/80'}`}>
                Ask about your jobs
              </span>
            </span>
          </button>
        </div>
      ) : null}

      <div className="border-t border-slate-100 px-3 py-2">
        <ThemeToggle />
      </div>

      <div className="border-t border-slate-100 px-3 py-3">
        <div className="mb-2 flex items-center gap-2.5 px-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-800">{displayName}</p>
            {userEmail && userEmail !== displayName && (
              <p className="truncate text-xs text-slate-500">{userEmail}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-red-50 hover:text-red-700"
        >
          <LogOut size={16} className="shrink-0" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
