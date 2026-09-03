import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { AgentChat } from '../agent/AgentChat';
import { setAgentNavigator } from '../../lib/agentNavigation';
import { useAgentStore } from '../../stores/agentStore';

export type AppShellOutletContext = {
  isAdmin: boolean;
};

interface AppShellProps {
  userEmail?: string;
  userName?: string;
  isAdmin?: boolean;
  onLogout: () => void;
}

export function AppShell({ userEmail, userName, isAdmin, onLogout }: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const admin = !!isAdmin;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeChat = useAgentStore((s) => s.closeChat);

  useEffect(() => {
    setAgentNavigator((path) => navigate(path));
    return () => setAgentNavigator(null);
  }, [navigate]);

  // AI Assistant is applicant-only — never leave it open for admins.
  useEffect(() => {
    if (admin) closeChat();
  }, [admin, closeChat]);

  // Close drawer on route change (mobile nav link taps).
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileNavOpen]);

  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  return (
    <div className="flex h-dvh max-h-dvh min-w-[1400px] overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden h-full shrink-0 md:flex">
        <Sidebar
          userEmail={userEmail}
          userName={userName}
          isAdmin={admin}
          onLogout={onLogout}
        />
      </div>

      {/* Mobile drawer */}
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-[80] md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]"
            aria-label="Close navigation"
            onClick={closeMobileNav}
          />
          <div className="absolute inset-y-0 left-0 flex w-[min(16.5rem,88vw)] max-w-full animate-[slideInLeft_0.2s_ease-out] shadow-2xl">
            <Sidebar
              userEmail={userEmail}
              userName={userName}
              isAdmin={admin}
              onLogout={onLogout}
              onNavigate={closeMobileNav}
              className="w-full"
            />
            <button
              type="button"
              onClick={closeMobileNav}
              aria-label="Close navigation"
              className="absolute right-2 top-3 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/90 text-slate-600 shadow-sm ring-1 ring-slate-200"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      ) : null}

      {/* min-w keeps the jobs platform usable when the viewport narrows (extension
          side panel drag). Sibling panels must not crush this below the floor. */}
      <main className="app-bg flex min-h-0 min-w-[1100px] flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3 py-2.5 dark:border-white/10 dark:bg-[var(--app-card)] md:hidden">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm dark:border-white/15 dark:bg-[var(--app-input)] dark:text-[var(--app-fg)]"
          >
            <Menu size={20} />
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <img src="/atomspace-logo.png" alt="" className="h-7 w-auto object-contain" />
            <span className="truncate text-sm font-bold tracking-tight text-slate-900 dark:text-white">
              Atomspace
            </span>
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Outlet context={{ isAdmin: admin } satisfies AppShellOutletContext} />
        </div>
      </main>
      {!admin ? <AgentChat /> : null}
    </div>
  );
}
