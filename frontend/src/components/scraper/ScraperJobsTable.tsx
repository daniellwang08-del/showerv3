import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { createPortal } from 'react-dom';
import {
  ExternalLink,
  ArrowUpDown,
  Wifi,
  RefreshCw,
  Trash2,
  CheckCircle2,
  Loader2,
  Eye,
  Sparkles,
  Copy,
  MousePointer2,
  SquareCheck,
  X,
  ExternalLink as OpenUrl,
  Download,
  ClipboardCopy,
  ClipboardCheck,
  ClipboardX,
  Table2,
} from 'lucide-react';
import { Badge } from '../shared/Badge';
import { ConfirmDialog } from '../extraction/ConfirmDialog';
import { JobAnalysisModal } from './JobAnalysisModal';
import { DocumentPreviewModal, type PreviewDocType } from './DocumentPreviewModal';
import { useScraperStore } from '../../stores/scraperStore';
import { fetchSheetsConfig } from '../../api/googleSheetsApi';
import { apiClient } from '../../api/client';
import type { DashboardJob, ExtractionStatus } from '../../types/scraper';
import { dashboardJobMarkedApplied, dashboardJobRowSurfaceClass, dashboardJobStickyCellClass } from '../../utils/appliedStatus';

interface ScraperJobsTableProps {
  jobs: DashboardJob[];
  loading: boolean;
  sortField: string;
  sortOrder: 'asc' | 'desc';
  onSort: (field: string) => void;
  rowOffset?: number;
  /** Instant patch for AI-search rows (not in paginated store). */
  onAppliedStateChange?: (patches: Array<{
    id: string;
    applied_at: string | null;
    applied_by_name: string | null;
  }>) => void;
  onSheetPostedStateChange?: (patches: Array<{
    id: string;
    sheet_posted_at: string | null;
  }>) => void;
}

const SOURCE_BADGE_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  adzuna: 'info',
  remoterocketship: 'default',
  jobright: 'info',
  welcometothejungle: 'success',
  ziprecruiter: 'warning',
  indeed: 'info',
  glassdoor: 'default',
};

type AppliedUiOverride = 'applied' | 'unapplied';

function applyAppliedUiOverride(
  job: DashboardJob,
  overrides: Record<string, AppliedUiOverride>,
): DashboardJob {
  const mode = overrides[job.id];
  if (mode === 'applied') {
    return {
      ...job,
      applied_at: job.applied_at ?? new Date().toISOString(),
      applied_by_name: job.applied_by_name,
    };
  }
  if (mode === 'unapplied') {
    return { ...job, applied_at: null, applied_by_name: null };
  }
  return job;
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const columns = [
  { key: '__check__',      label: '',           sortable: false },
  { key: '__no__',         label: 'No.',        sortable: false },
  { key: 'title',          label: 'Title',      sortable: true  },
  { key: 'company',        label: 'Company',    sortable: true  },
  { key: 'location',       label: 'Location',   sortable: false },
  { key: 'is_remote',      label: 'Remote',     sortable: false },
  { key: 'salary_raw',     label: 'Salary',     sortable: false },
  { key: 'job_type',       label: 'Type',       sortable: false },
  { key: 'source',         label: 'Source',     sortable: false },
  { key: 'posted_date',    label: 'Posted',     sortable: true  },
  { key: 'created_at',     label: 'Added',      sortable: true  },
  { key: '__processing__', label: 'Match',      sortable: true, sortKey: 'match_score' },
  { key: '__docs__',       label: 'Docs',       sortable: false },
  { key: '__actions__',    label: 'Actions',    sortable: false },
] as const;

/** Fixed column widths — prevents layout shift when rows update during polling. */
const COLUMN_WIDTHS: Record<(typeof columns)[number]['key'], string> = {
  __check__: '32px',
  __no__: '44px',
  title: '220px',
  company: '118px',
  location: '108px',
  is_remote: '74px',
  salary_raw: '100px',
  job_type: '78px',
  source: '108px',
  posted_date: '68px',
  created_at: '68px',
  __processing__: '118px',
  __docs__: '148px',
  __actions__: '220px',
};

const ROW_H = 'h-[52px] max-h-[52px]';
const CELL = 'px-3 py-0 align-middle overflow-hidden';

const STICKY_SHADOW = 'shadow-[-4px_0_8px_-2px_rgba(0,0,0,0.06)]';

// ---------------------------------------------------------------------------
// Docs column helpers
// ---------------------------------------------------------------------------

type DocPreviewTarget = {
  jobId: string;
  fileType: PreviewDocType;
  title: string;
  filePath: string | null;
};

function DocButton({
  label,
  jobId,
  filePath,
  fileType,
  docTitle,
  onOpen,
}: {
  label: string;
  jobId: string;
  filePath: string | null;
  fileType: PreviewDocType;
  docTitle: string;
  onOpen: (target: DocPreviewTarget) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpen({ jobId, fileType, title: docTitle, filePath });
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await apiClient.get(
        `/jobs/valid/${jobId}/resume-build/download/${fileType}`,
        { responseType: 'blob' },
      );
      const blob = new Blob([res.data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileType}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  };

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!filePath) return;
    navigator.clipboard.writeText(filePath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex items-center gap-0.5">
      <span className="text-[10px] font-medium text-slate-500 w-[16px] shrink-0">{label}</span>
      <button
        type="button"
        onClick={handleOpen}
        title={`View ${label} PDF`}
        className="inline-flex h-[20px] w-[20px] items-center justify-center rounded hover:bg-violet-100 text-violet-600 transition"
      >
        <Eye size={11} />
      </button>
      <button
        type="button"
        onClick={handleDownload}
        title={`Download ${label} PDF`}
        className="inline-flex h-[20px] w-[20px] items-center justify-center rounded hover:bg-blue-100 text-blue-600 transition"
      >
        <Download size={11} />
      </button>
      <button
        type="button"
        onClick={handleCopyPath}
        title={copied ? 'Copied!' : `Copy ${label} file path`}
        className={`inline-flex h-[20px] w-[20px] items-center justify-center rounded transition ${
          copied ? 'bg-emerald-100 text-emerald-600' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-600'
        }`}
      >
        {copied ? <CheckCircle2 size={11} /> : <ClipboardCopy size={11} />}
      </button>
    </div>
  );
}

function DocsCell({ job }: { job: DashboardJob }) {
  const [preview, setPreview] = useState<DocPreviewTarget | null>(null);
  const resumeReady = job.resume_pdf_status === 'completed';
  const clReady = job.cover_letter_pdf_status === 'completed';
  const jobLabel = [job.title, job.company].filter(Boolean).join(' · ') || 'Job';

  if (!resumeReady && !clReady) {
    return <span className="text-slate-300 text-xs">—</span>;
  }

  return (
    <>
      <div className="flex flex-col gap-0 leading-none">
        {resumeReady && (
          <DocButton
            label="R"
            jobId={job.id}
            filePath={job.resume_pdf_path}
            fileType="resume_pdf"
            docTitle={`Resume — ${jobLabel}`}
            onOpen={setPreview}
          />
        )}
        {clReady && (
          <DocButton
            label="CL"
            jobId={job.id}
            filePath={job.cover_letter_pdf_path}
            fileType="cover_letter_pdf"
            docTitle={`Cover letter — ${jobLabel}`}
            onOpen={setPreview}
          />
        )}
      </div>
      {preview && (
        <DocumentPreviewModal
          jobId={preview.jobId}
          fileType={preview.fileType}
          title={preview.title}
          filePath={preview.filePath}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Context menu positioning
// ---------------------------------------------------------------------------

function clampMenuPos(x: number, y: number): { x: number; y: number } {
  const MENU_W = 212;
  const MENU_H = 360;
  const PAD = 8;
  return {
    x: Math.min(x, window.innerWidth  - MENU_W - PAD),
    y: Math.min(y, window.innerHeight - MENU_H - PAD),
  };
}

// ---------------------------------------------------------------------------
// Pipeline status helpers (unchanged)
// ---------------------------------------------------------------------------

type DotState = 'idle' | 'active' | 'done';
interface DotConfig { state: DotState; color: string; label: string; }

function StatusDot({ color, state, label }: DotConfig) {
  if (state === 'idle')
    return <span title={`${label}: not started`} className="block h-2.5 w-2.5 rounded-full bg-slate-200" />;
  if (state === 'active')
    return (
      <span title={`${label}: in progress`} className="relative flex h-2.5 w-2.5">
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${color}`} />
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${color}`} />
      </span>
    );
  return <span title={`${label}: done`} className={`block h-2.5 w-2.5 rounded-full ${color}`} />;
}

function processingDots(job: DashboardJob): [DotConfig, DotConfig, DotConfig] {
  const es = job.extraction_status as ExtractionStatus | null;
  let dot1: DotState = 'idle';
  if (es === 'pending' || es === 'processing') dot1 = 'active';
  else if (es === 'extracted' || es === 'completed') dot1 = 'done';

  let dot2: DotState = 'idle';
  if (es === 'extracted') dot2 = 'active';
  else if (es === 'completed') dot2 = 'done';

  let dot3: DotState = 'idle';
  const cg = job.content_generation_status;
  const rs = job.resume_build_status;
  if (rs === 'completed') dot3 = 'done';
  else if (
    cg === 'pending' || cg === 'processing' ||
    rs === 'pending' || rs === 'processing'
  ) dot3 = 'active';

  return [
    { state: dot1, color: 'bg-yellow-400',  label: 'Scraping job description' },
    { state: dot2, color: 'bg-blue-500',    label: 'Structuring job description' },
    { state: dot3, color: 'bg-emerald-500', label: 'Resume & cover letter ready' },
  ];
}

function scoreColors(score: number): string {
  if (score >= 75) return 'border-emerald-300 bg-emerald-50 text-emerald-800';
  if (score >= 50) return 'border-sky-300    bg-sky-50    text-sky-800';
  if (score >= 30) return 'border-amber-300  bg-amber-50  text-amber-800';
  return 'border-red-300 bg-red-50 text-red-800';
}
function scoreLabel(score: number): string {
  if (score >= 75) return 'Strong';
  if (score >= 50) return 'Good';
  if (score >= 30) return 'Fair';
  return 'Weak';
}
function MatchScoreBadge({ score }: { score: number }) {
  return (
    <div title={`Match score: ${score}/100 — ${scoreLabel(score)}`}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 shadow-sm ${scoreColors(score)}`}>
      <Sparkles size={11} className="shrink-0 opacity-75" />
      <span className="text-sm font-bold tabular-nums leading-none">{score}</span>
      <span className="text-[10px] font-medium leading-none opacity-70">{scoreLabel(score)}</span>
    </div>
  );
}

function SheetPostedBadge({ postedAt }: { postedAt: string }) {
  return (
    <span
      title={`Posted to Google Sheet${postedAt ? ` · ${relativeTime(postedAt)}` : ''}`}
      className="inline-flex items-center gap-0.5 rounded border border-emerald-200 bg-emerald-50 px-1 py-0.5 text-[9px] font-semibold leading-none text-emerald-700"
    >
      <Table2 size={9} className="shrink-0" />
      Sheet
    </span>
  );
}

function StatusCell({ job }: { job: DashboardJob }) {
  const sheetBadge = job.sheet_posted_at ? <SheetPostedBadge postedAt={job.sheet_posted_at} /> : null;
  const contentGenActive =
    job.content_generation_status === 'pending' || job.content_generation_status === 'processing';
  const resumeBuildActive =
    job.resume_build_status === 'pending' || job.resume_build_status === 'processing';

  if (job.match_overall_score != null) {
    return (
      <div className="flex h-[40px] flex-col items-start justify-center">
        <div className="flex flex-wrap items-center gap-1">
          <MatchScoreBadge score={job.match_overall_score} />
          {sheetBadge}
        </div>
        {(contentGenActive || resumeBuildActive) && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 animate-pulse mt-0.5">
            <Sparkles size={9} />Resume…
          </span>
        )}
      </div>
    );
  }

  const dots = processingDots(job);
  return (
    <div className="flex h-[40px] flex-col justify-center gap-1">
      {sheetBadge && <div>{sheetBadge}</div>}
      <div className="flex h-[10px] items-center gap-2">
        {dots.map((dot) => <StatusDot key={dot.label} {...dot} />)}
      </div>
      {job.match_in_progress ? (
        <span className="flex items-center gap-1 text-[10px] font-medium text-blue-500 animate-pulse">
          <Sparkles size={9} />Matching…
        </span>
      ) : job.extraction_status === 'completed' ? (
        <span className="text-[10px] font-medium leading-none text-slate-400">No score yet</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context menu component (portal)
// ---------------------------------------------------------------------------

interface ContextMenuProps {
  job: DashboardJob;
  targets: DashboardJob[];
  x: number;
  y: number;
  onClose: () => void;
  onView: (jobId: string) => void;
  onRerun: (jobs: DashboardJob[]) => void;
  onMarkApplied: (jobs: DashboardJob[]) => void;
  onMarkUnapplied: (jobs: DashboardJob[]) => void;
  onPostToSheet: (jobs: DashboardJob[]) => void;
  onDelete: (jobs: DashboardJob[]) => void;
  sheetsConfigured: boolean;
  postingToSheet: boolean;
}

function ContextMenu({
  job,
  targets,
  x,
  y,
  onClose,
  onView,
  onRerun,
  onMarkApplied,
  onMarkUnapplied,
  onPostToSheet,
  onDelete,
  sheetsConfigured,
  postingToSheet,
}: ContextMenuProps) {
  const multi = targets.length > 1;
  const label = multi ? `${targets.length} jobs` : (job.title ? `"${job.title.slice(0, 28)}${job.title.length > 28 ? '…' : ''}"` : 'this job');
  const pipelineStatus = job.extraction_status;
  const isRunning = pipelineStatus === 'pending' || pipelineStatus === 'processing' || pipelineStatus === 'extracted';

  const unappliedTargets = targets.filter((t) => !dashboardJobMarkedApplied(t));
  const appliedTargets = targets.filter((t) => dashboardJobMarkedApplied(t));

  const appliedMenuItems: Array<{ icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }> = [];

  if (multi) {
    appliedMenuItems.push(
      {
        icon: <ClipboardCheck size={13} />,
        label: unappliedTargets.length > 0
          ? `Mark as applied (${unappliedTargets.length})`
          : 'Mark as applied',
        disabled: unappliedTargets.length === 0,
        onClick: () => { onMarkApplied(unappliedTargets); onClose(); },
      },
      {
        icon: <ClipboardX size={13} />,
        label: appliedTargets.length > 0
          ? `Unmark as applied (${appliedTargets.length})`
          : 'Unmark as applied',
        disabled: appliedTargets.length === 0,
        onClick: () => { onMarkUnapplied(appliedTargets); onClose(); },
      },
    );
  } else if (dashboardJobMarkedApplied(targets[0])) {
    appliedMenuItems.push({
      icon: <ClipboardX size={13} />,
      label: 'Unmark as applied',
      onClick: () => { onMarkUnapplied(targets); onClose(); },
    });
  } else {
    appliedMenuItems.push({
      icon: <ClipboardCheck size={13} />,
      label: 'Mark as applied',
      onClick: () => { onMarkApplied(targets); onClose(); },
    });
  }

  const menuItems: Array<{ icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; disabled?: boolean } | 'divider'> = [
    ...(!multi ? [{
      icon: <Eye size={13} />,
      label: 'View analysis',
      onClick: () => { onView(job.id); onClose(); },
    }] : []),
    {
      icon: <OpenUrl size={13} />,
      label: multi ? `Open ${targets.length} URLs` : 'Open URL',
      onClick: () => {
        targets.forEach((t) => window.open(t.source_url, '_blank', 'noopener,noreferrer'));
        onClose();
      },
    },
    ...(!multi ? [{
      icon: <Copy size={13} />,
      label: 'Copy URL',
      onClick: () => {
        void navigator.clipboard.writeText(job.source_url);
        onClose();
      },
    }] : []),
    'divider' as const,
    ...appliedMenuItems,
    'divider' as const,
    {
      icon: postingToSheet ? <Loader2 size={13} className="animate-spin" /> : <Table2 size={13} />,
      label: multi
        ? `Post ${targets.length} jobs to Google Sheet`
        : 'Post to Google Sheet',
      disabled: !sheetsConfigured || postingToSheet,
      onClick: () => { onPostToSheet(targets); onClose(); },
    },
    'divider' as const,
    {
      icon: isRunning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />,
      label: multi ? `Rerun ${targets.length} jobs` : (job.extraction_id ? 'Rerun extraction' : 'Run extraction'),
      disabled: isRunning && !multi,
      onClick: () => { onRerun(targets); onClose(); },
    },
    'divider' as const,
    {
      icon: <Trash2 size={13} />,
      label: multi ? `Delete ${targets.length} jobs` : 'Delete job',
      danger: true,
      onClick: () => { onDelete(targets); onClose(); },
    },
  ];

  return createPortal(
    <div
      data-scraper-menu="true"
      style={{ left: x, top: y, position: 'fixed', zIndex: 200 }}
      className="glass-card w-[212px] rounded-xl py-1.5 shadow-2xl ring-1 ring-slate-200/60 animate-[modal-in_0.12s_ease-out_both]"
    >
      {/* Header */}
      <div className="px-3 pb-1.5 pt-1">
        <p className="truncate text-[11px] font-semibold text-slate-500">{label}</p>
      </div>
      <div className="h-px bg-slate-100 mx-2 mb-1" />

      {menuItems.map((item, i) => {
        if (item === 'divider') {
          return <div key={`d${i}`} className="h-px bg-slate-100 mx-2 my-1" />;
        }
        return (
          <button
            key={item.label}
            type="button"
            disabled={item.disabled}
            title={
              item.disabled && item.label.includes('Google Sheet') && !sheetsConfigured
                ? 'Configure Google Sheets in Settings first'
                : undefined
            }
            onClick={item.onClick}
            className={[
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors',
              item.danger
                ? 'text-red-600 hover:bg-red-50 disabled:opacity-40'
                : 'text-slate-700 hover:bg-blue-50 hover:text-blue-800 disabled:opacity-40',
              item.disabled ? 'cursor-not-allowed' : 'cursor-pointer',
            ].join(' ')}
          >
            <span className="shrink-0">{item.icon}</span>
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Bulk action bar
// ---------------------------------------------------------------------------

interface BulkBarProps {
  count: number;
  totalVisible: number;
  onSelectAll: () => void;
  onClearAll: () => void;
  onRerun: () => void;
  onOpenUrls: () => void;
  onDelete: () => void;
  rerunning: boolean;
  deleting: boolean;
}

function BulkBar({ count, totalVisible, onSelectAll, onClearAll, onRerun, onOpenUrls, onDelete, rerunning, deleting }: BulkBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 shadow-sm">
      <SquareCheck size={15} className="text-blue-600 shrink-0" />
      <span className="text-sm font-bold text-blue-800">
        {count} selected
      </span>

      <div className="h-4 w-px bg-blue-200 mx-1" />

      <button type="button" onClick={onRerun} disabled={rerunning || deleting}
        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 py-1 text-xs font-semibold text-blue-700 shadow-sm transition hover:bg-blue-100 disabled:opacity-50">
        {rerunning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        Rerun selected
      </button>

      <button type="button" onClick={onOpenUrls} disabled={rerunning || deleting}
        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 py-1 text-xs font-semibold text-blue-700 shadow-sm transition hover:bg-blue-100 disabled:opacity-50">
        <OpenUrl size={12} />
        Open URLs
      </button>

      <button type="button" onClick={onDelete} disabled={rerunning || deleting}
        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1 text-xs font-semibold text-red-600 shadow-sm transition hover:bg-red-50 disabled:opacity-50">
        {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        Delete selected
      </button>

      <div className="ml-auto flex items-center gap-2">
        {count < totalVisible && (
          <button type="button" onClick={onSelectAll}
            className="text-xs font-medium text-blue-600 hover:underline">
            Select all {totalVisible}
          </button>
        )}
        <button type="button" onClick={onClearAll}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700">
          <X size={12} />
          Clear
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main table
// ---------------------------------------------------------------------------

export function ScraperJobsTable({
  jobs,
  loading,
  sortField,
  sortOrder,
  onSort,
  rowOffset = 0,
  onAppliedStateChange,
  onSheetPostedStateChange,
}: ScraperJobsTableProps) {
  const rerunJob         = useScraperStore((s) => s.rerunJob);
  const deleteJob        = useScraperStore((s) => s.deleteJob);
  const batchDeleteJobs  = useScraperStore((s) => s.batchDeleteJobs);
  const batchRerunJobs   = useScraperStore((s) => s.batchRerunJobs);
  const markJobsApplied  = useScraperStore((s) => s.markJobsApplied);
  const markJobsUnapplied = useScraperStore((s) => s.markJobsUnapplied);
  const postJobsToSheet  = useScraperStore((s) => s.postJobsToSheet);
  const optimisticMarkJobsSheetPosted = useScraperStore((s) => s.optimisticMarkJobsSheetPosted);
  const optimisticMarkJobsApplied = useScraperStore((s) => s.optimisticMarkJobsApplied);

  // Instant applied UI — local state avoids unstable Zustand selectors (infinite re-render loop).
  const [appliedUiOverride, setAppliedUiOverride] = useState<Record<string, AppliedUiOverride>>({});

  const displayJobs = useMemo(
    () => jobs.map((j) => applyAppliedUiOverride(j, appliedUiOverride)),
    [jobs, appliedUiOverride],
  );

  const clearAppliedUiOverrides = useCallback((ids: string[]) => {
    setAppliedUiOverride((prev) => {
      if (ids.every((id) => prev[id] == null)) return prev;
      const next = { ...prev };
      ids.forEach((id) => { delete next[id]; });
      return next;
    });
  }, []);

  const setAppliedUiOverrides = useCallback((ids: string[], mode: AppliedUiOverride) => {
    setAppliedUiOverride((prev) => {
      const next = { ...prev };
      ids.forEach((id) => { next[id] = mode; });
      return next;
    });
  }, []);

  // Drop local overrides once parent/store props reflect the persisted applied state.
  useEffect(() => {
    setAppliedUiOverride((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const job of jobs) {
        const mode = prev[job.id];
        if (mode === 'applied' && dashboardJobMarkedApplied(job)) {
          delete next[job.id];
          changed = true;
        } else if (mode === 'unapplied' && !dashboardJobMarkedApplied(job)) {
          delete next[job.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [jobs]);

  // ── Single-item action state ──────────────────────────────────────────────
  const [rerunningId,      setRerunningId]      = useState<string | null>(null);
  const [viewingJobId,     setViewingJobId]     = useState<string | null>(null);
  const [deleting,         setDeleting]         = useState<DashboardJob[] | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError,      setDeleteError]      = useState<string | null>(null);
  const [toast,            setToast]            = useState<{ kind: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [sheetsConfigured, setSheetsConfigured] = useState(false);
  const [postingToSheet,   setPostingToSheet]   = useState(false);

  // ── Selection state ───────────────────────────────────────────────────────
  const [selectedIds,     setSelectedIds]     = useState<Set<string>>(new Set());
  const [isSelectingMode, setIsSelectingMode] = useState(false);
  const longPressTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired   = useRef(false);

  // ── Context menu ──────────────────────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ job: DashboardJob; x: number; y: number } | null>(null);

  // ── Bulk action state ─────────────────────────────────────────────────────
  const [bulkRerunning, setBulkRerunning] = useState(false);
  const [bulkDeleting,  setBulkDeleting]  = useState(false);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const showToast = useCallback((kind: 'success' | 'warning' | 'error', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const addToSelect = useCallback((id: string) => {
    setSelectedIds((prev) => prev.has(id) ? prev : new Set([...prev, id]));
  }, []);

  // Global mouseup / pointercancel → end drag-select
  useEffect(() => {
    const end = () => {
      setIsSelectingMode(false);
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    };
    window.addEventListener('mouseup',       end, { capture: true });
    window.addEventListener('pointercancel', end, { capture: true });
    return () => {
      window.removeEventListener('mouseup',       end, { capture: true });
      window.removeEventListener('pointercancel', end, { capture: true });
    };
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest('[data-scraper-menu]')) setContextMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [contextMenu]);

  // Close context menu on Escape
  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [contextMenu]);

  useEffect(() => {
    let cancelled = false;
    void fetchSheetsConfig()
      .then((config) => {
        if (!cancelled) setSheetsConfigured(Boolean(config.configured));
      })
      .catch(() => {
        if (!cancelled) setSheetsConfigured(false);
      });
    return () => { cancelled = true; };
  }, []);

  // ── Row mouse handlers ────────────────────────────────────────────────────
  const handleRowMouseDown = useCallback((e: React.MouseEvent, job: DashboardJob) => {
    if (e.button !== 0) return;
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setIsSelectingMode(true);
      toggleSelect(job.id);
    }, 300);
  }, [toggleSelect]);

  const handleRowMouseUp = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  const handleRowMouseEnter = useCallback((job: DashboardJob) => {
    if (!isSelectingMode) return;
    addToSelect(job.id);
  }, [isSelectingMode, addToSelect]);

  const handleRowClick = useCallback((e: React.MouseEvent, job: DashboardJob) => {
    if (longPressFired.current) { e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey) { toggleSelect(job.id); return; }
    if (selectedIds.has(job.id)) { toggleSelect(job.id); return; }
    if (isSelectingMode) return;
    setViewingJobId(job.id);
  }, [toggleSelect, selectedIds, isSelectingMode]);

  const handleContextMenu = useCallback((e: React.MouseEvent, job: DashboardJob) => {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = clampMenuPos(e.clientX, e.clientY);
    setContextMenu({ job, x, y });
  }, []);

  // Context menu targets: if right-clicked job is in selection → all selected; else just that job
  const getContextTargets = useCallback((job: DashboardJob): DashboardJob[] => {
    if (selectedIds.has(job.id) && selectedIds.size > 1) {
      return displayJobs.filter((j) => selectedIds.has(j.id));
    }
    const row = displayJobs.find((j) => j.id === job.id) ?? job;
    return [row];
  }, [selectedIds, displayJobs]);

  // ── Action handlers ───────────────────────────────────────────────────────
  const handleRerun = async (job: DashboardJob) => {
    setRerunningId(job.id);
    const res = await rerunJob(job.id);
    setRerunningId(null);
    showToast(res.ok ? 'success' : 'error', res.message);
  };

  const handleRerunMany = useCallback(async (targets: DashboardJob[]) => {
    if (targets.length === 1) { await handleRerun(targets[0]); return; }
    setBulkRerunning(true);
    const res = await batchRerunJobs(targets.map((t) => t.id));
    setBulkRerunning(false);
    setSelectedIds(new Set());
    showToast(res.ok ? 'success' : res.partial ? 'warning' : 'error', res.message);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchRerunJobs, showToast]);

  const handleDeleteMany = useCallback(async (targets: DashboardJob[]) => {
    if (targets.length === 1) {
      setDeleteError(null);
      setDeleting(targets);
      return;
    }
    // Bulk — confirm via bulk delete dialog (reuse deleting state)
    setDeleteError(null);
    setDeleting(targets);
  }, []);

  const handleMarkApplied = useCallback((targets: DashboardJob[]) => {
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return;

    flushSync(() => {
      setAppliedUiOverrides(ids, 'applied');
      optimisticMarkJobsApplied(ids, true);
      setSelectedIds(new Set());
      setIsSelectingMode(false);
      onAppliedStateChange?.(
        ids.map((id) => ({ id, applied_at: new Date().toISOString(), applied_by_name: null })),
      );
    });

    void markJobsApplied(ids).then((res) => {
      showToast(res.ok ? 'success' : 'error', res.message);
      if (!res.ok) {
        flushSync(() => {
          clearAppliedUiOverrides(ids);
        });
        onAppliedStateChange?.(
          targets.map((t) => ({
            id: t.id,
            applied_at: t.applied_at,
            applied_by_name: t.applied_by_name,
          })),
        );
      }
    });
  }, [
    markJobsApplied,
    onAppliedStateChange,
    optimisticMarkJobsApplied,
    setAppliedUiOverrides,
    clearAppliedUiOverrides,
    showToast,
  ]);

  const handleMarkUnapplied = useCallback((targets: DashboardJob[]) => {
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return;

    flushSync(() => {
      setAppliedUiOverrides(ids, 'unapplied');
      optimisticMarkJobsApplied(ids, false);
      setSelectedIds(new Set());
      setIsSelectingMode(false);
      onAppliedStateChange?.(
        ids.map((id) => ({ id, applied_at: null, applied_by_name: null })),
      );
    });

    void markJobsUnapplied(ids).then((res) => {
      showToast(res.ok ? 'success' : 'error', res.message);
      if (!res.ok) {
        flushSync(() => {
          clearAppliedUiOverrides(ids);
        });
        onAppliedStateChange?.(
          targets.map((t) => ({
            id: t.id,
            applied_at: t.applied_at,
            applied_by_name: t.applied_by_name,
          })),
        );
      }
    });
  }, [
    markJobsUnapplied,
    onAppliedStateChange,
    optimisticMarkJobsApplied,
    setAppliedUiOverrides,
    clearAppliedUiOverrides,
    showToast,
  ]);

  const handlePostToSheet = useCallback((targets: DashboardJob[]) => {
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return;

    flushSync(() => {
      optimisticMarkJobsSheetPosted(ids);
      setSelectedIds(new Set());
      setIsSelectingMode(false);
      onSheetPostedStateChange?.(
        ids.map((id) => ({ id, sheet_posted_at: new Date().toISOString() })),
      );
    });

    setPostingToSheet(true);
    void postJobsToSheet(ids).then((res) => {
      setPostingToSheet(false);
      showToast(res.ok ? 'success' : 'error', res.message);
      if (!res.ok) {
        void useScraperStore.getState().bgRefreshJobs();
      }
    });
  }, [
    optimisticMarkJobsSheetPosted,
    onSheetPostedStateChange,
    postJobsToSheet,
    showToast,
  ]);

  const handleDeleteConfirm = async () => {
    if (!deleting) return;
    setDeleteSubmitting(true);
    setDeleteError(null);
    let res: { ok: boolean; message: string };
    if (deleting.length === 1) {
      res = await deleteJob(deleting[0].id);
    } else {
      setBulkDeleting(true);
      res = await batchDeleteJobs(deleting.map((j) => j.id));
      setBulkDeleting(false);
    }
    setDeleteSubmitting(false);
    if (res.ok) {
      setDeleting(null);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        deleting.forEach((j) => next.delete(j.id));
        return next;
      });
      showToast('success', res.message);
    } else {
      setDeleteError(res.message);
    }
  };

  // ── Bulk bar handlers ─────────────────────────────────────────────────────
  const selectedJobs = displayJobs.filter((j) => selectedIds.has(j.id));

  const handleBulkRerun = useCallback(() => void handleRerunMany(selectedJobs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedJobs]);

  const handleBulkOpenUrls = useCallback(() => {
    selectedJobs.forEach((j) => window.open(j.source_url, '_blank', 'noopener,noreferrer'));
  }, [selectedJobs]);

  const handleBulkDelete = useCallback(() => {
    setDeleteError(null);
    setDeleting(selectedJobs);
  }, [selectedJobs]);

  /* ── Loading / empty states ─────────────────────────────────────────── */
  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="p-8 text-center text-slate-400">Loading jobs…</div>
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="p-12 text-center">
          <p className="text-slate-500 text-sm">No scraped jobs found.</p>
          <p className="text-slate-400 text-xs mt-1">Hit "Sync All" to start scraping.</p>
        </div>
      </div>
    );
  }

  /* ── Table ──────────────────────────────────────────────────────────── */
  return (
    <>
      {/* ── Bulk action bar ─────────────────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <BulkBar
          count={selectedIds.size}
          totalVisible={jobs.length}
          onSelectAll={() => setSelectedIds(new Set(jobs.map((j) => j.id)))}
          onClearAll={() => setSelectedIds(new Set())}
          onRerun={handleBulkRerun}
          onOpenUrls={handleBulkOpenUrls}
          onDelete={handleBulkDelete}
          rerunning={bulkRerunning}
          deleting={bulkDeleting}
        />
      )}

      {/* ── Hint when nothing selected ──────────────────────────────────── */}
      {selectedIds.size === 0 && (
        <p className="flex items-center gap-1.5 text-[11px] text-slate-400 px-1">
          <MousePointer2 size={11} />
          Long-press a row to start drag-selecting · Right-click for actions · Ctrl+Click to toggle
        </p>
      )}

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1280px] table-fixed text-sm border-collapse">
            <colgroup>
              {columns.map((col) => (
                <col key={col.key} style={{ width: COLUMN_WIDTHS[col.key] }} />
              ))}
            </colgroup>

            {/* ── Header ── */}
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/70">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => {
                      const sortKey = 'sortKey' in col && col.sortKey ? col.sortKey : col.key;
                      if (col.sortable) onSort(sortKey);
                    }}
                    className={[
                      'px-3 py-3 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap overflow-hidden',
                      col.sortable ? 'cursor-pointer select-none hover:text-slate-700 hover:bg-slate-100/60' : '',
                      col.key === '__actions__' ? `sticky right-0 z-20 bg-slate-50/70 ${STICKY_SHADOW}` : '',
                      col.key === '__check__' ? 'px-2' : '',
                    ].join(' ')}
                  >
                    {col.key === '__check__' ? (
                      <button
                        type="button"
                        title={selectedIds.size === jobs.length ? 'Deselect all' : 'Select all'}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (selectedIds.size === jobs.length) setSelectedIds(new Set());
                          else setSelectedIds(new Set(jobs.map((j) => j.id)));
                        }}
                        className="flex h-4 w-4 items-center justify-center rounded border border-slate-300 bg-white transition hover:border-blue-400 hover:bg-blue-50"
                      >
                        {selectedIds.size === jobs.length && jobs.length > 0
                          ? <CheckCircle2 size={12} className="text-blue-600" />
                          : selectedIds.size > 0
                            ? <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                            : null}
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        {col.label}
                        {col.sortable && (
                          <ArrowUpDown
                            size={11}
                            className={
                              sortField === ('sortKey' in col && col.sortKey ? col.sortKey : col.key)
                                ? 'text-blue-600'
                                : 'text-slate-300'
                            }
                          />
                        )}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>

            {/* ── Body ── */}
            <tbody className="divide-y divide-slate-100">
              {displayJobs.map((job, idx) => {
                const isSelected      = selectedIds.has(job.id);
                const isApplied       = dashboardJobMarkedApplied(job);
                const isApiCallInFlight = rerunningId === job.id;
                const pipelineStatus  = job.extraction_status;
                const isPipelineRunning = pipelineStatus === 'pending' || pipelineStatus === 'processing' || pipelineStatus === 'extracted';
                const isRerunning     = isApiCallInFlight || isPipelineRunning;
                const hasExtraction   = !!job.extraction_id;

                return (
                  <tr
                    key={job.id}
                    onMouseDown={(e) => handleRowMouseDown(e, job)}
                    onMouseUp={handleRowMouseUp}
                    onMouseEnter={() => handleRowMouseEnter(job)}
                    onClick={(e) => handleRowClick(e, job)}
                    onContextMenu={(e) => handleContextMenu(e, job)}
                    className={[
                      `group ${ROW_H} select-none`,
                      dashboardJobRowSurfaceClass(job, { isSelected }),
                      isSelectingMode ? 'cursor-crosshair' : 'cursor-pointer',
                    ].join(' ')}
                  >
                    {/* Checkbox */}
                    <td className="px-2 py-0 align-middle w-[32px]">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleSelect(job.id); }}
                        className={[
                          'flex h-4 w-4 items-center justify-center rounded border transition',
                          isSelected
                            ? 'border-blue-500 bg-blue-500 text-white'
                            : 'border-slate-300 bg-white opacity-0 group-hover:opacity-100',
                        ].join(' ')}
                      >
                        {isSelected && <CheckCircle2 size={11} className="text-white" />}
                      </button>
                    </td>

                    {/* No. */}
                    <td className={`${CELL} text-xs text-slate-400 font-mono whitespace-nowrap`}>
                      {rowOffset + idx + 1}
                    </td>

                    {/* Title */}
                    <td className={CELL}>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <a
                          href={job.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex min-w-0 flex-1 items-center gap-1 text-blue-600 hover:text-blue-800 font-medium leading-snug"
                          title={job.title ?? undefined}
                        >
                          <span className="truncate">{job.title || 'Untitled'}</span>
                          <ExternalLink size={11} className="shrink-0 opacity-60" />
                        </a>
                        {isApplied && (
                          <span
                            className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 ring-1 ring-sky-200"
                            title="Marked as applied"
                          >
                            <ClipboardCheck size={10} />
                            Applied
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Company */}
                    <td className={`${CELL} text-slate-700 whitespace-nowrap text-xs truncate`}>
                      {job.company || '—'}
                    </td>

                    {/* Location */}
                    <td className={`${CELL} text-slate-500 text-xs truncate`}>
                      {job.location || '—'}
                    </td>

                    {/* Remote */}
                    <td className={CELL}>
                      {job.is_remote
                        ? <span className="inline-flex items-center gap-1 text-emerald-600"><Wifi size={13} /><span className="text-[11px] font-medium">Remote</span></span>
                        : <span className="text-slate-300 text-xs">—</span>}
                    </td>

                    {/* Salary */}
                    <td className={`${CELL} text-slate-500 whitespace-nowrap text-xs truncate`}>
                      {job.salary_raw || <span className="text-slate-300">—</span>}
                    </td>

                    {/* Type */}
                    <td className={`${CELL} text-slate-500 whitespace-nowrap text-xs truncate`}>
                      {job.job_type || <span className="text-slate-300">—</span>}
                    </td>

                    {/* Source */}
                    <td className={CELL}>
                      <Badge variant={SOURCE_BADGE_VARIANT[job.source?.toLowerCase() ?? ''] || 'default'}>
                        {job.source || job.domain}
                      </Badge>
                    </td>

                    {/* Posted */}
                    <td className={`${CELL} text-slate-400 whitespace-nowrap text-xs`}>
                      {relativeTime(job.posted_date)}
                    </td>

                    {/* Added */}
                    <td className={`${CELL} text-slate-400 whitespace-nowrap text-xs`}>
                      {relativeTime(job.created_at)}
                    </td>

                    {/* Status */}
                    <td className={CELL}>
                      <StatusCell job={job} />
                    </td>

                    {/* Docs (Resume / Cover Letter) */}
                    <td className={CELL} onClick={(e) => e.stopPropagation()}>
                      <DocsCell job={job} />
                    </td>

                    {/* Actions (sticky) */}
                    <td
                      onClick={(e) => e.stopPropagation()}
                      className={`sticky right-0 z-10 px-2 py-0 whitespace-nowrap align-middle ${STICKY_SHADOW} ${dashboardJobStickyCellClass(job, { isSelected })}`}
                    >
                      <div className="flex items-center gap-1">
                        {/* Run / Rerun */}
                        <button
                          type="button"
                          disabled={isRerunning}
                          onClick={() => handleRerun(job)}
                          title={
                            isApiCallInFlight         ? 'Starting pipeline…'
                            : pipelineStatus === 'pending'    ? 'Queued – waiting for worker'
                            : pipelineStatus === 'processing' ? 'Extracting job description…'
                            : pipelineStatus === 'extracted'  ? 'Analyzing with AI…'
                            : hasExtraction                   ? 'Rerun full lifecycle'
                            : 'Run extraction'
                          }
                          className={[
                            'relative inline-flex w-[84px] h-[28px] items-center justify-center gap-1 rounded-md border text-xs font-medium transition-all disabled:cursor-not-allowed',
                            isPipelineRunning
                              ? 'border-amber-300 bg-amber-50 text-amber-700 opacity-90'
                              : hasExtraction
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300'
                                : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-300',
                          ].join(' ')}
                        >
                          {isRerunning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                          <span>
                            {isApiCallInFlight         ? 'Starting…'
                              : pipelineStatus === 'pending'    ? 'Queued'
                              : pipelineStatus === 'processing' ? 'Extracting'
                              : pipelineStatus === 'extracted'  ? 'Analyzing'
                              : hasExtraction                   ? 'Rerun'
                              : 'Run'}
                          </span>
                          {hasExtraction && !isRerunning && (
                            <CheckCircle2 size={10} className="text-emerald-500 shrink-0" />
                          )}
                        </button>

                        {/* View */}
                        <button
                          type="button"
                          onClick={() => setViewingJobId(job.id)}
                          title="View job analysis"
                          className="inline-flex w-[56px] h-[28px] items-center justify-center gap-1 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-600 transition-all hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700"
                        >
                          <Eye size={12} /><span>View</span>
                        </button>

                        {/* Delete */}
                        <button
                          type="button"
                          onClick={() => { setDeleteError(null); setDeleting([job]); }}
                          title="Delete"
                          className="inline-flex w-[28px] h-[28px] items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400 transition-all hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Context menu portal ──────────────────────────────────────────── */}
      {contextMenu && (
        <ContextMenu
          job={contextMenu.job}
          targets={getContextTargets(contextMenu.job)}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onView={(id) => setViewingJobId(id)}
          onRerun={(targets) => void handleRerunMany(targets)}
          onMarkApplied={(targets) => void handleMarkApplied(targets)}
          onMarkUnapplied={(targets) => void handleMarkUnapplied(targets)}
          onPostToSheet={(targets) => void handlePostToSheet(targets)}
          onDelete={(targets) => handleDeleteMany(targets)}
          sheetsConfigured={sheetsConfigured}
          postingToSheet={postingToSheet}
        />
      )}

      {/* ── Modals & dialogs ─────────────────────────────────────────────── */}
      <ConfirmDialog
        open={!!deleting}
        title={deleting && deleting.length > 1 ? `Delete ${deleting.length} jobs?` : 'Delete this job?'}
        description={
          <div className="space-y-2">
            {deleting && deleting.length > 1 ? (
              <p>This will permanently remove <strong>{deleting.length} jobs</strong>.</p>
            ) : (
              <p>
                This removes the job
                {deleting?.[0]?.title ? <> for <strong>{deleting[0].title}</strong></> : null}
                {deleting?.[0]?.company ? <> at {deleting[0].company}</> : null}.
              </p>
            )}
          </div>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        loading={deleteSubmitting}
        error={deleteError ?? undefined}
        onConfirm={handleDeleteConfirm}
        onCancel={() => { if (!deleteSubmitting) { setDeleting(null); setDeleteError(null); } }}
      />

      {viewingJobId && (
        <JobAnalysisModal validJobId={viewingJobId} onClose={() => setViewingJobId(null)} />
      )}

      {/* ── Toast ────────────────────────────────────────────────────────── */}
      {toast && (
        <div role="status"
          className={`pointer-events-none fixed bottom-6 right-6 z-[120] max-w-sm rounded-xl px-4 py-3 text-sm shadow-lg ring-1 ${
            toast.kind === 'success'
              ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
              : toast.kind === 'warning'
                ? 'bg-amber-50 text-amber-800 ring-amber-200'
                : 'bg-red-50 text-red-800 ring-red-200'
          }`}>
          {toast.text}
        </div>
      )}
    </>
  );
}
