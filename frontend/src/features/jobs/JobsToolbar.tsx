import { useEffect, useState } from 'react';
import { ChevronDown, Globe, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import type { DashboardView } from '@/api/scraperApi';
import { AUTO_POST_WORK_MODE_OPTIONS, type AutoPostWorkMode } from '@/types/autoPostFilters';
import { MatchScoreFilter } from './MatchScoreFilter';
import { viewTone } from './viewTone';

export interface JobsViewTab {
  id: DashboardView;
  label: string;
  count?: number;
}

export { MATCH_FILTERS } from './matchFilters';

interface Props {
  tabs: JobsViewTab[];
  view: DashboardView;
  onView: (view: DashboardView) => void;
  search: string;
  onSearch: (q: string) => void;
  workModes: AutoPostWorkMode[];
  onWorkModes: (modes: AutoPostWorkMode[]) => void;
  minScore: number;
  onMinScore: (v: number) => void;
  /** Agent-applied title/company filters, shown as removable chips. */
  chips: Array<{ key: string; label: string; onClear: () => void }>;
}

export function JobsToolbar(props: Props) {
  const [query, setQuery] = useState(props.search);

  useEffect(() => setQuery(props.search), [props.search]);

  useEffect(() => {
    if (query === props.search) return;
    const t = setTimeout(() => props.onSearch(query.trim()), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const workModeActive = props.workModes.length > 0;
  const workModeLabel = (() => {
    if (props.workModes.length === 0) return 'Work mode';
    if (props.workModes.length === 1) {
      return AUTO_POST_WORK_MODE_OPTIONS.find((o) => o.value === props.workModes[0])?.label ?? 'Work mode';
    }
    return `${props.workModes.length} modes`;
  })();

  const toggleWorkMode = (mode: AutoPostWorkMode, checked: boolean) => {
    const next = new Set(props.workModes);
    if (checked) next.add(mode);
    else next.delete(mode);
    props.onWorkModes(AUTO_POST_WORK_MODE_OPTIONS.map((o) => o.value).filter((m) => next.has(m)));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="scrollbar-thin -mx-1 min-w-0 max-w-full overflow-x-auto px-1 py-0.5">
          <div
            role="tablist"
            aria-label="Job views"
            className="inline-flex min-w-max gap-1 rounded-xl border bg-muted/60 p-1"
          >
            {props.tabs.map((tab) => {
              const active = tab.id === props.view;
              const tone = viewTone(tab.id);
              return (
                <button
                  key={tab.id}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={() => props.onView(tab.id)}
                  className={cn(
                    'inline-flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-sm outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring/50',
                    active
                      ? cn('bg-card font-semibold text-foreground shadow-sm ring-1', tone.ring)
                      : 'font-medium text-muted-foreground hover:bg-background/70 hover:text-foreground',
                  )}
                >
                  <span aria-hidden className={cn('size-2 rounded-full', tone.dot, !active && 'opacity-70')} />
                  {tab.label}
                  {tab.count != null && (
                    <span
                      className={cn(
                        'min-w-6 rounded-md px-1.5 py-px text-center text-xs font-semibold tabular-nums',
                        active || tab.count > 0 ? tone.soft : 'bg-background/70 text-muted-foreground',
                      )}
                    >
                      {tab.count.toLocaleString()}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <InputGroup className="w-full sm:w-56 2xl:w-72">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="Search jobs"
              placeholder="Search roles, companies, links…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') props.onSearch(query.trim());
                if (e.key === 'Escape' && query) {
                  e.stopPropagation();
                  setQuery('');
                  props.onSearch('');
                }
              }}
            />
          </InputGroup>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant={workModeActive ? 'secondary' : 'outline'}
                  size="sm"
                  aria-label="Filter by work mode"
                  aria-haspopup="menu"
                  className={cn('shrink-0', workModeActive && 'border-brand/40 bg-brand-soft text-brand')}
                />
              }
            >
              <Globe />
              {workModeLabel}
              <ChevronDown className="opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {AUTO_POST_WORK_MODE_OPTIONS.map(({ value: mode, label }) => (
                <DropdownMenuCheckboxItem
                  key={mode}
                  checked={props.workModes.includes(mode)}
                  onCheckedChange={(checked) => toggleWorkMode(mode, checked === true)}
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!workModeActive} onClick={() => props.onWorkModes([])}>
                Any work mode
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <MatchScoreFilter minScore={props.minScore} onMinScore={props.onMinScore} />
        </div>
      </div>

      {props.chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {props.chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex h-7 items-center gap-1 rounded-full border bg-muted/50 pl-2.5 pr-1 text-xs"
            >
              {chip.label}
              <button
                type="button"
                aria-label={`Clear ${chip.label}`}
                onClick={chip.onClear}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
