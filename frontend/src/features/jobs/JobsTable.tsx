import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, FileText, Loader2, Mail, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { MatchScore } from '@/components/app/MatchScore';
import { JobLocationLabel } from '@/components/app/JobLocationLabel';
import type { DashboardJob } from '@/types/scraper';
import {
  buildJobMenu,
  inlineActionsWidth,
  inlineJobActions,
  type JobActionId,
  type JobMenuContext,
} from './jobMenu';
import { JobMenuItems } from './JobMenu';
import {
  isApplied,
  isDocsBuilding,
  jobStage,
  relativeTime,
  sourceLabel,
  STAGE_META,
  workMode,
} from './jobStatus';

export type JobsTableTier = 'compact' | 'medium' | 'full';

export interface SortState {
  field: string;
  order: 'asc' | 'desc';
}

interface Column {
  id: string;
  header: string;
  width: string;
  sortField?: string;
  tiers: JobsTableTier[];
  align?: 'end' | 'center';
  /** Narrow containers (phones, docked assistant) can't afford the desktop minimums. */
  compactWidth?: string;
}

const ALL: JobsTableTier[] = ['compact', 'medium', 'full'];
const WIDE: JobsTableTier[] = ['medium', 'full'];
const FULL: JobsTableTier[] = ['full'];

// Role and Location share leftover width with Source and Status (1.4:1.3:1:1).
// Role used to be 3fr and swallowed the table; other columns stay the same.
export const JOB_COLUMNS: Column[] = [
  { id: 'select', header: '', width: '2.5rem', tiers: ALL },
  { id: 'title', header: 'Role', width: 'minmax(12rem, 1.4fr)', compactWidth: 'minmax(0, 1fr)', sortField: 'title', tiers: ALL },
  { id: 'location', header: 'Location', width: 'minmax(10rem, 1.3fr)', compactWidth: 'minmax(5rem, 1fr)', sortField: 'location', tiers: ALL },
  { id: 'mode', header: 'Mode', width: '5.5rem', tiers: FULL },
  { id: 'source', header: 'Source', width: 'minmax(7.5rem, 1fr)', tiers: FULL },
  { id: 'posted', header: 'Posted', width: '4.5rem', sortField: 'posted_date', tiers: FULL, align: 'end' },
  { id: 'added', header: 'Added', width: '4.5rem', sortField: 'created_at', tiers: WIDE, align: 'end' },
  { id: 'match', header: 'Match', width: '7.5rem', compactWidth: '4.75rem', sortField: 'match_score', tiers: ALL },
  { id: 'docs', header: 'Docs', width: '5rem', tiers: WIDE },
  { id: 'status', header: 'Status', width: 'minmax(9.5rem, 1fr)', tiers: WIDE },
  { id: 'track', header: 'Actions', width: '8rem', compactWidth: '4rem', tiers: ALL, align: 'end' },
];

/** Number of inline action buttons on a row at this tier, including the "…" menu when shown. */
export function actionButtonCount(tier: JobsTableTier, ctx: JobMenuContext): number {
  if (tier === 'full') return 6 + (ctx.sheetsConfigured ? 1 : 0) + (ctx.pumbleConfigured ? 1 : 0);
  return tier === 'medium' ? 3 : 2;
}

export function columnsFor(tier: JobsTableTier, ctx?: JobMenuContext): Column[] {
  return JOB_COLUMNS.filter((c) => c.tiers.includes(tier)).map((c) => {
    if (tier === 'compact' && c.compactWidth) return { ...c, width: c.compactWidth, header: c.id === 'track' ? '' : c.header };
    if (c.id === 'track' && ctx) return { ...c, width: inlineActionsWidth(actionButtonCount(tier, ctx)) };
    return c;
  });
}

interface JobsTableProps {
  jobs: DashboardJob[];
  loading: boolean;
  tier: JobsTableTier;
  sort: SortState;
  onSort: (field: string) => void;
  selected: ReadonlySet<string>;
  onToggleSelect: (job: DashboardJob, opts: { range: boolean }) => void;
  onToggleAll: () => void;
  activeJobId: string | null;
  onOpen: (job: DashboardJob) => void;
  onAction: (id: JobActionId, targets: DashboardJob[]) => void;
  onPreviewDoc: (job: DashboardJob, type: 'resume_pdf' | 'cover_letter_pdf') => void;
  menuContext: JobMenuContext;
  rerunning: ReadonlySet<string>;
  /** Targets for a menu opened on `job`: the whole selection when the row is part of it. */
  targetsFor: (job: DashboardJob) => DashboardJob[];
  empty?: React.ReactNode;
}

const ROW_HEIGHT = 56;

export function JobsTable(props: JobsTableProps) {
  const { jobs, loading, tier, sort, onSort, selected, onToggleAll, empty } = props;
  const columns = columnsFor(tier, props.menuContext);
  const template = columns.map((c) => c.width).join(' ');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [menuJob, setMenuJob] = useState<DashboardJob | null>(null);

  const virtualizer = useVirtualizer({
    count: jobs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  useEffect(() => {
    if (focusIndex >= jobs.length) setFocusIndex(Math.max(0, jobs.length - 1));
  }, [jobs.length, focusIndex]);

  const focusRow = useCallback(
    (index: number) => {
      const next = Math.min(Math.max(index, 0), jobs.length - 1);
      setFocusIndex(next);
      virtualizer.scrollToIndex(next, { align: 'auto' });
      requestAnimationFrame(() => {
        scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${next}"]`)?.focus();
      });
    },
    [jobs.length, virtualizer],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.target as Node)) return;
    const target = e.target as HTMLElement;
    const rowIndex = target.dataset.rowIndex;
    if (rowIndex == null) return;
    const index = Number(rowIndex);
    const job = jobs[index];
    if (!job) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        focusRow(index + 1);
        break;
      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        focusRow(index - 1);
        break;
      case 'Enter':
        e.preventDefault();
        props.onOpen(job);
        break;
      case ' ':
      case 'x':
        e.preventDefault();
        props.onToggleSelect(job, { range: e.shiftKey });
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        props.onAction('delete', props.targetsFor(job));
        break;
    }
  };

  const allSelected = jobs.length > 0 && jobs.every((j) => selected.has(j.id));
  const someSelected = !allSelected && jobs.some((j) => selected.has(j.id));
  const menuTargets = menuJob ? props.targetsFor(menuJob) : [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      <div
        role="row"
        className="grid shrink-0 items-center border-b bg-muted/40 text-xs font-medium text-muted-foreground"
        style={{ gridTemplateColumns: template }}
      >
        {columns.map((col) =>
          col.id === 'select' ? (
            <div key={col.id} role="columnheader" className="flex justify-center">
              <Checkbox
                aria-label="Select all jobs on this page"
                checked={allSelected}
                indeterminate={someSelected}
                onCheckedChange={onToggleAll}
                disabled={jobs.length === 0}
              />
            </div>
          ) : (
            <div
              key={col.id}
              role="columnheader"
              aria-sort={
                col.sortField && sort.field === col.sortField
                  ? sort.order === 'asc' ? 'ascending' : 'descending'
                  : undefined
              }
              className={cn('flex h-9 items-center px-[var(--cell-px)]', col.align === 'end' && 'justify-end')}
            >
              {col.sortField ? (
                <button
                  type="button"
                  onClick={() => onSort(col.sortField!)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                    sort.field === col.sortField && 'text-foreground',
                  )}
                >
                  {col.header}
                  {sort.field === col.sortField &&
                    (sort.order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                </button>
              ) : (
                col.header
              )}
            </div>
          ),
        )}
      </div>

      <div className="relative min-h-0 min-w-0 flex-1">
      <ContextMenu onOpenChange={(open) => !open && setMenuJob(null)}>
        <ContextMenuTrigger
          render={
            <div
              ref={scrollRef}
              role="rowgroup"
              aria-label="Jobs"
              className="scrollbar-thin absolute inset-0 overflow-auto overscroll-contain"
              onKeyDown={onKeyDown}
              onContextMenu={(e: MouseEvent<HTMLDivElement>) => {
                const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row-index]');
                const job = row ? jobs[Number(row.dataset.rowIndex)] : undefined;
                if (!job) {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                setMenuJob(job);
              }}
            />
          }
        >
          {loading && jobs.length === 0 ? (
            <LoadingRows template={template} count={10} columns={columns.length} />
          ) : jobs.length === 0 ? (
            empty
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const job = jobs[item.index];
                return (
                  <JobRow
                    key={job.id}
                    job={job}
                    index={item.index}
                    top={item.start}
                    columns={columns}
                    template={template}
                    tier={tier}
                    selected={selected.has(job.id)}
                    active={props.activeJobId === job.id}
                    focusable={item.index === focusIndex}
                    rerunning={props.rerunning.has(job.id)}
                    menuContext={props.menuContext}
                    targetsFor={props.targetsFor}
                    onOpen={props.onOpen}
                    onToggleSelect={props.onToggleSelect}
                    onAction={props.onAction}
                    onPreviewDoc={props.onPreviewDoc}
                    onFocusRow={setFocusIndex}
                  />
                );
              })}
            </div>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-56">
          {menuJob && (
            <JobMenuItems
              kind="context"
              title={menuTargets.length > 1 ? `${menuTargets.length} selected jobs` : menuJob.title || 'Untitled role'}
              entries={buildJobMenu(menuTargets, props.menuContext)}
              onAction={props.onAction}
            />
          )}
        </ContextMenuContent>
      </ContextMenu>
      </div>
    </div>
  );
}

function LoadingRows({ template, count, columns }: { template: string; count: number; columns: number }) {
  return (
    <div aria-busy="true" aria-label="Loading jobs">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="grid items-center border-b border-border/60"
          style={{ gridTemplateColumns: template, height: ROW_HEIGHT }}
        >
          {Array.from({ length: columns }, (_, c) => (
            <div key={c} className="px-[var(--cell-px)]">
              {c === 1 ? (
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-3/5" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              ) : c > 0 ? (
                <Skeleton className="h-3.5 w-full max-w-16" />
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface JobRowProps {
  job: DashboardJob;
  index: number;
  top: number;
  columns: Column[];
  template: string;
  tier: JobsTableTier;
  selected: boolean;
  active: boolean;
  focusable: boolean;
  rerunning: boolean;
  menuContext: JobMenuContext;
  targetsFor: (job: DashboardJob) => DashboardJob[];
  onOpen: (job: DashboardJob) => void;
  onToggleSelect: (job: DashboardJob, opts: { range: boolean }) => void;
  onAction: (id: JobActionId, targets: DashboardJob[]) => void;
  onPreviewDoc: (job: DashboardJob, type: 'resume_pdf' | 'cover_letter_pdf') => void;
  onFocusRow: (index: number) => void;
}

const JobRow = memo(function JobRow(props: JobRowProps) {
  const { job, index, top, columns, template, selected, active, focusable } = props;
  const applied = isApplied(job);

  const onRowClick = (e: MouseEvent<HTMLDivElement>) => {
    // React bubbles events out of portals (row menus, tooltips) into the row.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if ((e.target as HTMLElement).closest('button, a, [role="checkbox"], [data-no-row-click]')) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      props.onToggleSelect(job, { range: e.shiftKey });
      return;
    }
    props.onOpen(job);
  };

  return (
    <div
      role="row"
      tabIndex={focusable ? 0 : -1}
      data-row-index={index}
      data-job-id={job.id}
      aria-selected={selected}
      onClick={onRowClick}
      onFocus={() => props.onFocusRow(index)}
      className={cn(
        'group absolute inset-x-0 grid cursor-default items-center border-b border-border/60 text-sm outline-none transition-colors',
        'hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:shadow-[inset_2px_0_0_var(--brand)]',
        selected && 'bg-brand-soft/60 hover:bg-brand-soft',
        active && 'bg-muted shadow-[inset_2px_0_0_var(--brand)]',
        applied && !selected && !active && 'text-muted-foreground',
      )}
      style={{ gridTemplateColumns: template, height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
    >
      {columns.map((col) => (
        <div
          key={col.id}
          role="cell"
          className={cn(
            'flex min-w-0 items-center px-[var(--cell-px)]',
            col.align === 'end' && 'justify-end',
            col.id === 'select' && 'justify-center px-0',
          )}
        >
          <Cell column={col.id} {...props} applied={applied} />
        </div>
      ))}
    </div>
  );
});

function Cell({
  column,
  job,
  selected,
  applied,
  rerunning,
  tier,
  menuContext,
  targetsFor,
  onToggleSelect,
  onAction,
  onPreviewDoc,
}: JobRowProps & { column: string; applied: boolean }) {
  switch (column) {
    case 'select':
      return (
        <Checkbox
          aria-label={`Select ${job.title || 'job'}`}
          checked={selected}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(job, { range: e.shiftKey });
          }}
        />
      );
    case 'title': {
      const sub = job.company || job.domain;
      return (
        <div className="min-w-0">
          <div className={cn('truncate font-medium', applied ? 'text-muted-foreground' : 'text-foreground')}>
            {job.title || 'Untitled role'}
          </div>
          <div className="truncate text-xs text-muted-foreground">{sub || '-'}</div>
        </div>
      );
    }
    case 'location':
      return (
        <JobLocationLabel
          location={job.location}
          countries={job.location_countries}
          className="w-full text-xs text-muted-foreground"
        />
      );
    case 'mode': {
      const mode = workMode(job);
      if (!mode) return <span className="text-muted-foreground">-</span>;
      return (
        <span
          className={cn(
            'rounded-md px-1.5 py-0.5 text-xs font-medium capitalize',
            mode === 'remote' && 'bg-match-strong/12 text-match-strong',
            mode === 'hybrid' && 'bg-match-fair/15 text-match-fair',
            mode === 'onsite' && 'bg-muted text-muted-foreground',
          )}
        >
          {mode === 'onsite' ? 'On-site' : mode}
        </span>
      );
    }
    case 'source':
      return <span className="truncate text-xs text-muted-foreground">{sourceLabel(job)}</span>;
    case 'posted':
      return <time className="text-xs tabular-nums text-muted-foreground">{relativeTime(job.posted_date)}</time>;
    case 'added':
      return (
        <time
          className="text-xs tabular-nums text-muted-foreground"
          title={new Date(job.pool_added_at || job.created_at).toLocaleString()}
        >
          {relativeTime(job.pool_added_at || job.created_at)}
        </time>
      );
    case 'match':
      if (job.match_overall_score != null) return <MatchScore score={job.match_overall_score} />;
      if (job.match_in_progress || rerunning) {
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Matching
          </span>
        );
      }
      return <span className="text-xs text-muted-foreground">No score</span>;
    case 'docs':
      return <DocsCell job={job} onPreview={onPreviewDoc} />;
    case 'status': {
      const meta = STAGE_META[jobStage(job)];
      return (
        <span className="inline-flex min-w-0 items-center gap-2 text-xs">
          <span className="relative flex size-2 shrink-0">
            {meta.pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', meta.tone)} />}
            <span className={cn('relative size-2 rounded-full', meta.tone)} />
          </span>
          <span className="truncate">{meta.label}</span>
        </span>
      );
    }
    case 'track':
      return (
        <div className="flex items-center gap-0.5">
          {inlineJobActions(job, menuContext, tier).map((action) => {
            const Icon = action.icon;
            return (
              <TrackButton
                key={action.id}
                label={action.label}
                active={Boolean(action.active)}
                activeClass={ACTIVE_CLASS[action.id] ?? 'text-foreground'}
                disabled={action.disabled}
                destructive={action.destructive}
                onClick={() => onAction(action.id, [job])}
              >
                <Icon />
              </TrackButton>
            );
          })}
          {tier !== 'full' && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Job actions"
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-60 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100 data-popup-open:bg-accent data-popup-open:opacity-100"
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <JobMenuItems kind="dropdown" entries={buildJobMenu(targetsFor(job), menuContext)} onAction={onAction} />
            </DropdownMenuContent>
          </DropdownMenu>
          )}
        </div>
      );
    default:
      return null;
  }
}

const ACTIVE_CLASS: Partial<Record<JobActionId, string>> = {
  'mark-applied': 'text-status-applied',
  'unmark-applied': 'text-status-applied',
  'post-sheet': 'text-match-strong',
  'post-pumble': 'text-brand',
};

function TrackButton({
  label,
  active,
  activeClass,
  disabled,
  destructive,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  activeClass: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            aria-disabled={disabled || undefined}
            onClick={() => {
              if (!disabled) onClick();
            }}
            className={cn(
              'inline-flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5',
              disabled
                ? 'cursor-not-allowed text-muted-foreground/25'
                : active
                  ? cn(activeClass, 'hover:bg-accent')
                  : destructive
                    ? 'text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive'
                    : 'text-muted-foreground/50 hover:bg-accent hover:text-foreground',
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function DocsCell({
  job,
  onPreview,
}: {
  job: DashboardJob;
  onPreview: (job: DashboardJob, type: 'resume_pdf' | 'cover_letter_pdf') => void;
}) {
  if (isDocsBuilding(job)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Writing
      </span>
    );
  }
  const resume = job.resume_pdf_status === 'completed';
  const cover = job.cover_letter_pdf_status === 'completed';
  if (!resume && !cover) return <span className="text-xs text-muted-foreground">-</span>;
  return (
    <div className="flex items-center gap-0.5">
      {resume && (
        <TrackButton label="Preview resume" active activeClass="text-foreground" onClick={() => onPreview(job, 'resume_pdf')}>
          <FileText />
        </TrackButton>
      )}
      {cover && (
        <TrackButton
          label="Preview cover letter"
          active
          activeClass="text-foreground"
          onClick={() => onPreview(job, 'cover_letter_pdf')}
        >
          <Mail />
        </TrackButton>
      )}
    </div>
  );
}
