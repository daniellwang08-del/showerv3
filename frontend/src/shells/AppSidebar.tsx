import { NavLink, useNavigate } from 'react-router-dom';
import { PanelLeft, Search, Sparkles } from 'lucide-react';
import { NaoWordmark } from '@/components/brand/NaoLogo';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useShellStore } from '@/stores/shellStore';
import { useAgentStore } from '@/stores/agentStore';
import type { NavSection } from './nav';
import { UserMenu, type ShellUser } from './UserMenu';
import { useOpenJob } from '@/features/jobs/useOpenJob';

type AppSidebarProps = {
  nav: NavSection[];
  variant: 'applicant' | 'admin';
  user: ShellUser;
  onLogout: () => void;
  collapsed?: boolean;
  onNavigate?: () => void;
};

function RailTooltip({ label, collapsed, children }: { label: string; collapsed: boolean; children: React.ReactElement }) {
  if (!collapsed) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

const rowClass =
  'flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&_svg]:size-[18px] [&_svg]:shrink-0';

export function AppSidebar({ nav, variant, user, onLogout, collapsed = false, onNavigate }: AppSidebarProps) {
  const navigate = useNavigate();
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);
  const setPaletteOpen = useShellStore((s) => s.setPaletteOpen);
  const toggleAssistant = useShellStore((s) => s.toggleAssistant);
  const assistantDocked = useShellStore((s) => s.assistantDocked);
  const setAssistantDocked = useShellStore((s) => s.setAssistantDocked);
  const recentJobs = useShellStore((s) => s.recentJobs);
  const timeline = useAgentStore((s) => s.timeline);
  const openJob = useOpenJob();
  const isApplicant = variant === 'applicant';

  const recentPrompts = isApplicant
    ? timeline
        .filter((i): i is Extract<typeof i, { kind: 'user' }> => i.kind === 'user')
        .slice(-4)
        .reverse()
    : [];

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className={cn('flex h-12 shrink-0 items-center gap-2 px-3', collapsed && 'justify-center px-0')}>
        {!collapsed ? (
          <button
            type="button"
            onClick={() => {
              navigate(isApplicant ? '/app' : '/admin');
              onNavigate?.();
            }}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 hover:bg-sidebar-accent"
          >
            <NaoWordmark className="h-[18px] text-foreground" />
            {variant === 'admin' ? (
              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-brand uppercase">
                Admin
              </span>
            ) : null}
          </button>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleSidebar}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                className="hidden text-muted-foreground md:inline-flex"
              />
            }
          >
            <PanelLeft />
          </TooltipTrigger>
          <TooltipContent side="right">
            {collapsed ? 'Expand' : 'Collapse'} sidebar <Kbd>⌘B</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className={cn('space-y-0.5 px-2 pb-2', collapsed && 'px-2.5')}>
        <RailTooltip label="Search ⌘K" collapsed={collapsed}>
          <button
            type="button"
            className={cn(rowClass, collapsed && 'justify-center px-0')}
            onClick={() => setPaletteOpen(true)}
          >
            <Search />
            {!collapsed && (
              <>
                <span className="flex-1 text-left">Search</span>
                <Kbd>⌘K</Kbd>
              </>
            )}
          </button>
        </RailTooltip>
      </div>

      <nav className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Main">
        {nav.map((section, idx) => (
          <div key={section.label ?? idx} className={cn(idx > 0 && 'mt-4')}>
            {section.label && !collapsed ? (
              <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">{section.label}</p>
            ) : null}
            {section.label && collapsed ? <div className="mx-3 mb-2 border-t" /> : null}
            <div className="space-y-0.5">
              {section.items.map(({ to, label, icon: Icon, end }) => (
                <RailTooltip key={to} label={label} collapsed={collapsed}>
                  <NavLink
                    to={to}
                    end={end}
                    onClick={() => onNavigate?.()}
                    className={({ isActive }) =>
                      cn(
                        rowClass,
                        collapsed && 'justify-center px-0',
                        isActive && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                      )
                    }
                  >
                    <Icon />
                    {!collapsed && <span className="truncate">{label}</span>}
                  </NavLink>
                </RailTooltip>
              ))}
            </div>
          </div>
        ))}

        {!collapsed && isApplicant && recentJobs.length > 0 ? (
          <div className="mt-5">
            <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">Recent jobs</p>
            {recentJobs.slice(0, 5).map((job) => (
              <button
                key={job.id}
                type="button"
                onClick={() => {
                  openJob(job);
                  onNavigate?.();
                }}
                className="flex h-8 w-full items-center rounded-lg px-2.5 text-left text-sm text-sidebar-foreground/90 hover:bg-sidebar-accent"
                title={`${job.title} · ${job.company}`}
              >
                <span className="truncate">{job.title || job.company}</span>
              </button>
            ))}
          </div>
        ) : null}

        {!collapsed && recentPrompts.length > 0 ? (
          <div className="mt-5">
            <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">Recent questions</p>
            {recentPrompts.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setAssistantDocked(true);
                  onNavigate?.();
                }}
                className="flex h-8 w-full items-center rounded-lg px-2.5 text-left text-sm text-sidebar-foreground/90 hover:bg-sidebar-accent"
                title={p.text}
              >
                <span className="truncate">{p.text}</span>
              </button>
            ))}
          </div>
        ) : null}
      </nav>

      <div className={cn('shrink-0 space-y-1 border-t p-2', collapsed && 'px-2.5')}>
        {isApplicant ? (
          <RailTooltip label="Assistant ⌘J" collapsed={collapsed}>
            <button
              type="button"
              onClick={() => {
                toggleAssistant();
                onNavigate?.();
              }}
              aria-pressed={assistantDocked}
              className={cn(
                rowClass,
                collapsed && 'justify-center px-0',
                assistantDocked && 'bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand',
              )}
            >
              <Sparkles className="text-brand" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">Ask assistant</span>
                  <Kbd>⌘J</Kbd>
                </>
              )}
            </button>
          </RailTooltip>
        ) : null}
        <UserMenu user={user} onLogout={onLogout} collapsed={collapsed} variant={variant} />
      </div>
    </div>
  );
}
