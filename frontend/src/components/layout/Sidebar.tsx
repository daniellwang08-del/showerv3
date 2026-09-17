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
  ScrollText,
  BarChart3,
  CreditCard,
} from 'lucide-react';
import { useThemeStore } from '../../stores/themeStore';
import { useAgentStore } from '../../stores/agentStore';
import { BrandMark } from '../shared/BrandMark';
import { brandGradient, borderSubtle, mutedText } from '../../ui/tokens';

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
      className={`group flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors hover:bg-sky-50 hover:text-sky-900 dark:hover:bg-sky-500/10 dark:hover:text-sky-200 ${mutedText}`}
    >
      <span className="flex items-center gap-3">
        {isDark ? (
          <Moon size={18} className="text-sky-400" />
        ) : (
          <Sun size={18} className="text-amber-500" />
        )}
        {isDark ? 'Dark mode' : 'Light mode'}
      </span>
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-300 ${
          isDark ? 'bg-sky-500' : 'bg-slate-300'
        }`}
      >
        <span
          className={`inline-flex h-4 w-4 transform items-center justify-center rounded-full bg-white shadow-sm transition-transform duration-300 ${
            isDark ? 'translate-x-[18px]' : 'translate-x-[2px]'
          }`}
        >
          {isDark ? (
            <Moon size={10} className="text-sky-600" />
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
  { to: '/job-analysis', label: 'Job Analysis', icon: BarChart3 },
  { to: '/profile', label: 'Profile', icon: UserCircle },
  { to: '/preferences', label: 'My Preferences', icon: UserCog },
  { to: '/resume-builder', label: 'Resume Builder', icon: LayoutTemplate },
  { to: '/integrations', label: 'Integrations', icon: Puzzle },
  { to: '/billing', label: 'Subscription', icon: CreditCard },
];

/** Platform ops only — Integrations and AI Assistant are applicant tools. */
const adminNavItems = [
  { to: '/scraper', label: 'Jobs', icon: Briefcase },
  { to: '/data-analysis', label: 'Data Analysis', icon: Database },
  { to: '/user-management', label: 'User Management', icon: Users },
  { to: '/system-settings', label: 'System Settings', icon: Cpu },
  { to: '/system-logs', label: 'System Logs', icon: ScrollText },
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
      className={`flex h-full w-60 max-w-full flex-col border-r bg-white dark:bg-[var(--app-card)] ${borderSubtle} ${className}`.trim()}
    >
      <div className={`flex items-center gap-2.5 border-b px-5 py-4 ${borderSubtle}`}>
        <img src="/atomspace-logo.png" alt="Atomspace" className="h-8 w-auto object-contain" />
        <span className="text-[15px] font-bold tracking-tight text-slate-900 dark:text-white">
          Atomspace
        </span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={() => onNavigate?.()}
            title={label}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-[var(--app-muted)] dark:hover:bg-white/5 dark:hover:text-white'
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
              'group flex w-full items-center gap-3 overflow-hidden rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-all',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
              agentOpen
                ? `border-sky-400 bg-gradient-to-r ${brandGradient} text-white shadow-md shadow-sky-500/25`
                : 'border-sky-200 bg-gradient-to-r from-sky-50 via-blue-50 to-indigo-50 text-sky-900 shadow-sm hover:border-sky-300 hover:shadow-md dark:border-sky-400/30 dark:from-sky-500/10 dark:via-blue-500/10 dark:to-indigo-500/10 dark:text-sky-100',
            ].join(' ')}
          >
            {agentOpen ? (
              <BrandMark mood="idle" size="sm" />
            ) : (
              <span
                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${brandGradient} text-white shadow-sm`}
              >
                <Sparkles size={15} strokeWidth={2.4} />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate leading-none">AI Assistant</span>
              <span
                className={`mt-1 block truncate text-[11px] font-medium leading-none ${
                  agentOpen ? 'text-white/85' : 'text-sky-700/80 dark:text-sky-300/80'
                }`}
              >
                Ask about your jobs
              </span>
            </span>
          </button>
        </div>
      ) : null}

      <div className={`border-t px-3 py-2 ${borderSubtle}`}>
        <ThemeToggle />
      </div>

      <div className={`border-t px-3 py-3 ${borderSubtle}`}>
        <div className="mb-2 flex items-center gap-2.5 px-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-600 text-xs font-semibold text-white">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-800 dark:text-white">
              {displayName}
            </p>
            {userEmail && userEmail !== displayName && (
              <p className={`truncate text-xs ${mutedText}`}>{userEmail}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-500/10 dark:hover:text-rose-300 ${mutedText}`}
        >
          <LogOut size={16} className="shrink-0" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
