import { lazy, Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu, Search, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useShellStore } from '@/stores/shellStore';
import { useAgentStore } from '@/stores/agentStore';
import { setAgentNavigator } from '@/lib/agentNavigation';
import type { AppShellOutletContext } from '@/components/layout/AppShell';
import { JobDetailSheet } from '@/features/jobs/JobDetailSheet';
import { AppSidebar } from './AppSidebar';
import type { NavSection } from './nav';
import type { ShellUser } from './UserMenu';
import { useMediaQuery } from '@/hooks/useMediaQuery';

const AssistantPanel = lazy(() =>
  import('@/features/assistant/AssistantPanel').then((m) => ({ default: m.AssistantPanel })),
);
const CommandPalette = lazy(() => import('./CommandPalette').then((m) => ({ default: m.CommandPalette })));

type WorkspaceShellProps = {
  variant: 'applicant' | 'admin';
  nav: NavSection[];
  user: ShellUser;
  onLogout: () => void;
};

function isTypingTarget(el: EventTarget | null) {
  const node = el as HTMLElement | null;
  return !!node && (node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName));
}

export function WorkspaceShell({ variant, nav, user, onLogout }: WorkspaceShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const collapsed = useShellStore((s) => s.sidebarCollapsed);
  const mobileNavOpen = useShellStore((s) => s.mobileNavOpen);
  const setMobileNavOpen = useShellStore((s) => s.setMobileNavOpen);
  const assistantDocked = useShellStore((s) => s.assistantDocked);
  const setAssistantDocked = useShellStore((s) => s.setAssistantDocked);
  const isApplicant = variant === 'applicant';
  const isAssistantPage = location.pathname.startsWith('/app/assistant');
  const showAssistant = isApplicant && assistantDocked && !isAssistantPage;
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const paletteOpen = useShellStore((s) => s.paletteOpen);
  const [paletteLoaded, setPaletteLoaded] = useState(false);
  if (paletteOpen && !paletteLoaded) setPaletteLoaded(true);

  useEffect(() => {
    setAgentNavigator((path) => navigate(path));
    return () => setAgentNavigator(null);
  }, [navigate]);

  // The legacy floating chat is replaced by the docked panel.
  useEffect(() => {
    useAgentStore.getState().closeChat();
  }, []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname, setMobileNavOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        const s = useShellStore.getState();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (key === 'j' && isApplicant) {
        e.preventDefault();
        useShellStore.getState().toggleAssistant();
      } else if (key === 'b' && !isTypingTarget(e.target)) {
        e.preventDefault();
        useShellStore.getState().toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isApplicant]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <aside
        className={cn(
          'hidden shrink-0 border-r border-sidebar-border transition-[width] duration-200 ease-out md:block',
          collapsed ? 'w-[60px]' : 'w-64',
        )}
      >
        <AppSidebar nav={nav} variant={variant} user={user} onLogout={onLogout} collapsed={collapsed} />
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" showCloseButton={false} className="gap-0 p-0 data-[side=left]:w-72 data-[side=left]:sm:max-w-72">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <AppSidebar
            nav={nav}
            variant={variant}
            user={user}
            onLogout={onLogout}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2 md:hidden">
          <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}>
            <Menu />
          </Button>
          <img src="/nao-logo.png" alt="" className="h-6 w-auto" />
          <span className="flex-1 text-sm font-semibold">NAO</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search"
            onClick={() => useShellStore.getState().setPaletteOpen(true)}
          >
            <Search />
          </Button>
          {isApplicant ? (
            <Button variant="ghost" size="icon" aria-label="Assistant" onClick={() => setAssistantDocked(true)}>
              <Sparkles />
            </Button>
          ) : null}
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet context={{ isAdmin: !isApplicant } satisfies AppShellOutletContext} />
        </main>
      </div>

      {showAssistant && isDesktop ? (
        <div className="hidden shrink-0 lg:block">
          <Suspense fallback={<div className="h-full w-[400px] border-l xl:w-[440px]" />}>
            <AssistantPanel />
          </Suspense>
        </div>
      ) : null}
      {isApplicant && !isAssistantPage && !isDesktop ? (
        <Sheet open={assistantDocked} onOpenChange={setAssistantDocked}>
          <SheetContent side="right" showCloseButton={false} className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
            <SheetTitle className="sr-only">Assistant</SheetTitle>
            <Suspense fallback={null}>
              <AssistantPanel />
            </Suspense>
          </SheetContent>
        </Sheet>
      ) : null}

      {paletteLoaded ? (
        <Suspense fallback={null}>
          <CommandPalette nav={nav} variant={variant} onLogout={onLogout} />
        </Suspense>
      ) : null}
      <JobDetailSheet isAdmin={!isApplicant} />
    </div>
  );
}
