import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, LogOut, MessageSquare, Moon, Sparkles, SquarePen, Sun } from 'lucide-react';
import {
  CommandDialog,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { useShellStore } from '@/stores/shellStore';
import { useThemeStore } from '@/stores/themeStore';
import { useAgentStore } from '@/stores/agentStore';
import { useScraperStore } from '@/stores/scraperStore';
import { useOpenJob } from '@/features/jobs/useOpenJob';
import type { NavSection } from './nav';

export function CommandPalette({
  nav,
  variant,
  onLogout,
}: {
  nav: NavSection[];
  variant: 'applicant' | 'admin';
  onLogout: () => void;
}) {
  const open = useShellStore((s) => s.paletteOpen);
  const setOpen = useShellStore((s) => s.setPaletteOpen);
  const setDocked = useShellStore((s) => s.setAssistantDocked);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const send = useAgentStore((s) => s.send);
  const clearChat = useAgentStore((s) => s.clear);
  const jobs = useScraperStore((s) => s.jobs);
  const navigate = useNavigate();
  const openJob = useOpenJob();
  const [query, setQuery] = useState('');
  const isApplicant = variant === 'applicant';

  const run = (fn: () => void) => {
    setOpen(false);
    setQuery('');
    fn();
  };

  const jobItems = useMemo(() => jobs.slice(0, 200), [jobs]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen} className="sm:max-w-xl">
      <Command loop>
        <CommandInput
          placeholder={isApplicant ? 'Search pages, jobs, or ask the assistant…' : 'Search pages and actions…'}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-[min(60vh,440px)]">
          <CommandEmpty>No results.</CommandEmpty>


          {nav.map((section, i) => (
            <CommandGroup key={section.label ?? i} heading={i === 0 ? 'Go to' : section.label}>
              {section.items.map((item) => (
                <CommandItem
                  key={item.to}
                  value={`${item.label} ${item.keywords?.join(' ') ?? ''}`}
                  onSelect={() => run(() => navigate(item.to))}
                >
                  <item.icon />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}

          <CommandSeparator />
          <CommandGroup heading="Actions">
            {isApplicant ? (
              <>
                <CommandItem
                  value="new chat"
                  onSelect={() =>
                    run(() => {
                      clearChat();
                      navigate('/app');
                    })
                  }
                >
                  <SquarePen />
                  New chat
                </CommandItem>
                <CommandItem value="toggle assistant panel" onSelect={() => run(() => setDocked(true))}>
                  <MessageSquare />
                  Open assistant panel
                  <CommandShortcut>⌘J</CommandShortcut>
                </CommandItem>
              </>
            ) : null}
            <CommandItem value="toggle theme dark light mode" onSelect={() => run(toggleTheme)}>
              {theme === 'dark' ? <Sun /> : <Moon />}
              {theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            </CommandItem>
            <CommandItem value="sign out logout" onSelect={() => run(onLogout)}>
              <LogOut />
              Sign out
            </CommandItem>
          </CommandGroup>

          {jobItems.length > 0 && query.trim().length > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Jobs on this page">
                {jobItems.map((job) => (
                  <CommandItem
                    key={job.id}
                    value={`job ${job.title ?? ''} ${job.company} ${job.location ?? ''} ${job.id}`}
                    onSelect={() => run(() => openJob(job))}
                  >
                    <Briefcase />
                    <span className="min-w-0 flex-1 truncate">
                      {job.title || 'Untitled role'}
                      <span className="text-muted-foreground"> · {job.company}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : null}
          {isApplicant && query.trim().length > 2 ? (
            <CommandGroup heading="Ask the assistant">
              <CommandItem
                value={`ask ${query}`}
                onSelect={() =>
                  run(() => {
                    setDocked(true);
                    void send(query.trim());
                  })
                }
              >
                <Sparkles className="text-brand" />
                <span className="truncate">Ask “{query.trim()}”</span>
                <CommandShortcut>↵</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
