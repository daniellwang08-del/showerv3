import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { DashboardJob } from '@/types/scraper';
import { isApplied, isApplyReady, isJdReady, relativeTime } from '@/features/jobs/jobStatus';
import { addedFrom, EXTRACTION_META, extractionState, isExtracting } from './pipelineModel';

export type AdminActionId = 'view' | 'open-url' | 'copy-url' | 'extract' | 'delete';

type MenuEntry =
  | 'separator'
  | { id: AdminActionId; label: string; icon: LucideIcon; disabled?: boolean; destructive?: boolean };

export function buildAdminMenu(targets: DashboardJob[]): MenuEntry[] {
  if (targets.length > 1) {
    const n = targets.length;
    return [
      { id: 'open-url', label: `Open ${n} URLs`, icon: ExternalLink },
      'separator',
      { id: 'extract', label: `Extract ${n} jobs`, icon: RefreshCw },
      'separator',
      { id: 'delete', label: `Delete ${n} jobs`, icon: Trash2, destructive: true },
    ];
  }
  const job = targets[0];
  return [
    { id: 'view', label: 'View job details', icon: Eye },
    { id: 'open-url', label: 'Open URL', icon: ExternalLink },
    { id: 'copy-url', label: 'Copy URL', icon: Copy },
    'separator',
    {
      id: 'extract',
      label: job.extraction_id ? 'Re-extract job description' : 'Extract job description',
      icon: RefreshCw,
      disabled: isExtracting(job),
    },
    'separator',
    { id: 'delete', label: 'Delete job', icon: Trash2, destructive: true },
  ];
}

type Tone = 'fresh' | 'jd_ready' | 'apply_ready' | 'applied' | 'failed';
const TONE: Record<Tone, { cls: string; hint: string }> = {
  fresh: { cls: 'text-status-new', hint: 'No job description yet' },
  jd_ready: { cls: 'text-status-preparing', hint: 'Job description ready' },
  apply_ready: { cls: 'text-foreground', hint: 'Ready to apply' },
  applied: { cls: 'text-status-applied', hint: 'Marked as applied' },
  failed: { cls: 'text-status-failed', hint: 'Extraction failed' },
};

function titleTone(job: DashboardJob): Tone {
  if (isApplied(job)) return 'applied';
  if (job.extraction_status === 'failed') return 'failed';
  if (isApplyReady(job)) return 'apply_ready';
  if (isJdReady(job)) return 'jd_ready';
  return 'fresh';
}

interface Props {
  jobs: DashboardJob[];
  loading: boolean;
  rowOffset: number;
  sort: { field: string; order: 'asc' | 'desc' };
  onSort: (field: string) => void;
  selected: ReadonlyMap<string, DashboardJob>;
  onToggleSelect: (job: DashboardJob, opts: { range: boolean }) => void;
  onToggleAll: () => void;
  activeJobId: string | null;
  onOpen: (job: DashboardJob) => void;
  onAction: (id: AdminActionId, targets: DashboardJob[]) => void;
  busyIds: ReadonlySet<string>;
  targetsFor: (job: DashboardJob) => DashboardJob[];
  empty: ReactNode;
}

const TH = 'sticky top-0 z-10 h-9 bg-muted px-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap';
const TD = 'px-2 py-2 align-middle';

export function AdminJobsTable(props: Props) {
  const { jobs, loading, sort, onSort, selected } = props;
  const [menuJob, setMenuJob] = useState<DashboardJob | null>(null);
  const allSelected = jobs.length > 0 && jobs.every((j) => selected.has(j.id));
  const someSelected = !allSelected && jobs.some((j) => selected.has(j.id));
  const menuTargets = menuJob ? props.targetsFor(menuJob) : [];

  const sortHeader = (field: string, label: string) => (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        'inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
        sort.field === field && 'text-foreground',
      )}
    >
      {label}
      {sort.field === field && (sort.order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
    </button>
  );
  const ariaSort = (field: string) =>
    sort.field === field ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined;

  return (
    <div className="scrollbar-thin max-h-[min(72vh,52rem)] overflow-auto rounded-xl border bg-card">
      <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className={cn(TH, 'w-10 border-b text-center')}>
              <Checkbox
                aria-label="Select all jobs on this page"
                checked={allSelected}
                indeterminate={someSelected}
                onCheckedChange={props.onToggleAll}
                disabled={jobs.length === 0}
              />
            </th>
            <th className={cn(TH, 'hidden w-12 border-b md:table-cell')}>No.</th>
            <th className={cn(TH, 'border-b')} aria-sort={ariaSort('title')}>{sortHeader('title', 'Title')}</th>
            <th className={cn(TH, 'hidden w-[14%] border-b sm:table-cell')} aria-sort={ariaSort('company')}>
              {sortHeader('company', 'Company')}
            </th>
            <th className={cn(TH, 'hidden w-[22%] border-b xl:table-cell')}>URL</th>
            <th className={cn(TH, 'hidden w-28 border-b lg:table-cell')}>Source</th>
            <th className={cn(TH, 'hidden w-20 border-b md:table-cell')}>Added from</th>
            <th className={cn(TH, 'w-14 border-b text-right sm:w-16')} aria-sort={ariaSort('created_at')}>
              {sortHeader('created_at', 'Added')}
            </th>
            <th className={cn(TH, 'w-24 border-b sm:w-28')}>Extraction</th>
            <th className={cn(TH, 'w-24 border-b text-right sm:w-40')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <ContextMenu onOpenChange={(open) => !open && setMenuJob(null)}>
          <ContextMenuTrigger
            render={
              <tbody
                onContextMenu={(e: MouseEvent<HTMLTableSectionElement>) => {
                  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-job-id]');
                  const job = row ? jobs.find((j) => j.id === row.dataset.jobId) : undefined;
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
              Array.from({ length: 8 }, (_, i) => (
                <tr key={i} aria-hidden>
                  <td colSpan={10} className="border-b px-3 py-3">
                    <Skeleton className="h-4 w-full" />
                  </td>
                </tr>
              ))
            ) : jobs.length === 0 ? (
              <tr>
                <td colSpan={10}>{props.empty}</td>
              </tr>
            ) : (
              jobs.map((job, i) => (
                <Row key={job.id} {...props} job={job} index={props.rowOffset + i + 1} />
              ))
            )}
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-56">
            {menuJob && (
              <ContextMenuGroup>
                <ContextMenuLabel className="max-w-64 truncate text-xs text-muted-foreground">
                  {menuTargets.length > 1 ? `${menuTargets.length} selected jobs` : menuJob.title || 'Untitled'}
                </ContextMenuLabel>
                {buildAdminMenu(menuTargets).map((entry, i) =>
                  entry === 'separator' ? (
                    <ContextMenuSeparator key={`s${i}`} />
                  ) : (
                    <ContextMenuItem
                      key={entry.id}
                      disabled={entry.disabled}
                      variant={entry.destructive ? 'destructive' : 'default'}
                      onClick={() => props.onAction(entry.id, menuTargets)}
                    >
                      <entry.icon /> {entry.label}
                    </ContextMenuItem>
                  ),
                )}
              </ContextMenuGroup>
            )}
          </ContextMenuContent>
        </ContextMenu>
      </table>
    </div>
  );
}

function Row({
  job,
  index,
  selected,
  activeJobId,
  busyIds,
  onOpen,
  onToggleSelect,
  onAction,
  targetsFor,
}: Props & { job: DashboardJob; index: number }) {
  const isSelected = selected.has(job.id);
  const tone = TONE[titleTone(job)];
  const state = extractionState(job);
  const meta = EXTRACTION_META[state];
  const extracting = isExtracting(job);
  const busy = busyIds.has(job.id) || extracting;
  const jdReady = isJdReady(job);
  const from = addedFrom(job);

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>) => {
    if (!e.currentTarget.contains(e.target as Node)) return;
    if ((e.target as HTMLElement).closest('button, a, [role="checkbox"]')) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      onToggleSelect(job, { range: e.shiftKey });
      return;
    }
    onOpen(job);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(job);
    } else if (e.key === ' ') {
      e.preventDefault();
      onToggleSelect(job, { range: e.shiftKey });
    }
  };

  const runLabel = busyIds.has(job.id)
    ? 'Starting…'
    : state === 'queued'
      ? 'Wait'
      : state === 'extracting'
        ? 'Extracting'
        : jdReady
          ? 'Re-run'
          : 'Run';
  const runHint = busyIds.has(job.id)
    ? 'Starting pipeline…'
    : state === 'queued'
      ? 'Queued – waiting for worker'
      : state === 'extracting'
        ? 'Extracting job description…'
        : jdReady
          ? 'Re-extract shared job description (inventory only)'
          : 'Extract shared job description (inventory only)';

  return (
    <tr
      data-job-id={job.id}
      tabIndex={0}
      aria-selected={isSelected}
      onClick={onRowClick}
      onKeyDown={onKeyDown}
      className={cn(
        'group cursor-default outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:shadow-[inset_2px_0_0_var(--brand)]',
        isSelected && 'bg-brand-soft/60 hover:bg-brand-soft',
        activeJobId === job.id && 'bg-muted shadow-[inset_2px_0_0_var(--brand)]',
        '[&>td]:border-b [&>td]:border-border/60',
      )}
    >
      <td className={cn(TD, 'text-center')}>
        <Checkbox
          aria-label={`Select ${job.title || 'job'}`}
          checked={isSelected}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(job, { range: e.shiftKey });
          }}
        />
      </td>
      <td className={cn(TD, 'hidden font-mono text-xs tabular-nums text-muted-foreground md:table-cell')}>{index}</td>
      <td className={TD}>
        <a
          href={job.source_url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${tone.hint} · ${job.title || 'Untitled'}`}
          className={cn('inline-flex max-w-full items-center gap-1 font-medium hover:underline', tone.cls)}
        >
          <span className="truncate">{job.title || 'Untitled'}</span>
          <ExternalLink className="size-3 shrink-0 opacity-60" />
        </a>
        <div className="truncate text-xs text-muted-foreground sm:hidden">{job.company || job.domain}</div>
      </td>
      <td className={cn(TD, 'hidden truncate text-muted-foreground sm:table-cell')} title={job.company || undefined}>
        {job.company || '-'}
      </td>
      <td className={cn(TD, 'hidden xl:table-cell')}>
        {job.source_url ? (
          <a
            href={job.source_url}
            target="_blank"
            rel="noopener noreferrer"
            title={job.source_url}
            className="block truncate font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            {job.source_url}
          </a>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </td>
      <td className={cn(TD, 'hidden lg:table-cell')}>
        <Badge variant="outline" className="max-w-full" title={job.source || job.domain}>
          <span className="truncate">{job.source || job.domain || '-'}</span>
        </Badge>
      </td>
      <td className={cn(TD, 'hidden md:table-cell')}>
        <Badge variant="secondary" title={from.hint}>
          {from.short}
        </Badge>
      </td>
      <td className={cn(TD, 'text-right text-xs tabular-nums text-muted-foreground')}>
        <time title={new Date(job.created_at).toLocaleString()}>{relativeTime(job.created_at)}</time>
      </td>
      <td className={TD}>
        <button
          type="button"
          onClick={() => onOpen(job)}
          title={`${meta.hint}, click to view`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="relative flex size-2 shrink-0">
            {meta.pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', meta.tone)} />}
            <span className={cn('relative size-2 rounded-full', meta.tone)} />
          </span>
          <span className="truncate">{meta.label}</span>
        </button>
      </td>
      <td className={cn(TD, 'text-right')}>
        <div className="inline-flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            title={runHint}
            onClick={() => onAction('extract', [job])}
            className="tabular-nums"
          >
            {busy ? <Loader2 className="animate-spin" /> : jdReady ? <CheckCircle2 className="text-status-ready" /> : <RefreshCw />}
            <span className="max-sm:sr-only">{runLabel}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Delete job"
            title="Delete"
            onClick={() => onAction('delete', [job])}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label="Job actions" className="text-muted-foreground" />}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuGroup>
                {buildAdminMenu(targetsFor(job)).map((entry, i) =>
                  entry === 'separator' ? (
                    <DropdownMenuSeparator key={`s${i}`} />
                  ) : (
                    <DropdownMenuItem
                      key={entry.id}
                      disabled={entry.disabled}
                      variant={entry.destructive ? 'destructive' : 'default'}
                      onClick={() => onAction(entry.id, targetsFor(job))}
                    >
                      <entry.icon /> {entry.label}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  );
}
