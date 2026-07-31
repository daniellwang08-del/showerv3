import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
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
  Rocket,
  MessageSquare,
  FileText,
} from 'lucide-react';
import { Badge } from '../shared/Badge';
import { ConfirmDialog } from '../extraction/ConfirmDialog';
import { JobAnalysisModal } from './JobAnalysisModal';
import { DocumentPreviewModal, type PreviewDocType } from './DocumentPreviewModal';
import { InstallExtensionModal } from './InstallExtensionModal';
import { detectExtension, applyViaExtension } from '../../lib/extensionBridge';
import { useScraperStore } from '../../stores/scraperStore';
import { fetchSheetsConfig } from '../../api/googleSheetsApi';
import { fetchPumbleConfig } from '../../api/pumbleApi';
import { PumbleDestinationModal } from './PumbleDestinationModal';
import type { PumbleIntegration } from '../../types/pumble';
import { apiClient } from '../../api/client';
import { namedDownloadFile } from '../../utils/resumeFileName';
import type { DashboardJob, ExtractionStatus } from '../../types/scraper';
import { dashboardJobMarkedApplied, dashboardJobRowSurfaceClass, dashboardJobStickyCellClass } from '../../utils/appliedStatus';
import { BrandedLoader } from '../layout/BrandedLoader';

interface ScraperJobsTableProps {
  jobs: DashboardJob[];
  loading: boolean;
  sortField: string;
  sortOrder: 'asc' | 'desc';
  onSort: (field: string) => void;
  rowOffset?: number;
  /** When true, empty-state copy can mention Sync All (admins only). */
  canSync?: boolean;
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
  onPumblePostedStateChange?: (patches: Array<{
    id: string;
    pumble_posted_at: string | null;
  }>) => void;
}

const SOURCE_BADGE_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  remoterocketship: 'default',
  jobright: 'info',
  welcometothejungle: 'success',
  adzuna: 'info',
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
  if (!dateStr) return '-';
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
  { key: 'work_mode',      label: 'Work mode',  sortable: false },
  { key: 'salary_raw',     label: 'Salary',     sortable: false },
  { key: 'job_type',       label: 'Type',       sortable: false },
  { key: 'source',         label: 'Source',     sortable: false },
  { key: 'posted_date',    label: 'Posted',     sortable: true  },
  { key: 'created_at',     label: 'Added',      sortable: true  },
  { key: '__processing__', label: 'Match',      sortable: true, sortKey: 'match_score' },
  { key: '__docs__',       label: 'Docs',       sortable: false },
  { key: '__status__',     label: 'Status',     sortable: false },
  { key: '__actions__',    label: 'Actions',    sortable: false },
] as const;

/** Fixed column widths - prevents layout shift when rows update during polling. */
const COLUMN_WIDTHS: Record<(typeof columns)[number]['key'], string> = {
  __check__: '32px',
  __no__: '44px',
  title: '220px',
  company: '118px',
  location: '108px',
  work_mode: '74px',
  salary_raw: '100px',
  job_type: '78px',
  source: '108px',
  posted_date: '68px',
  created_at: '68px',
  __processing__: '108px',
  __docs__: '120px',
  __status__: '112px',
  __actions__: '300px',
};

/** Shared height with MatchScoreBadge so status squares align visually. */
const MATCH_BADGE_H = 28;

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
      const file = namedDownloadFile(
        res.data,
        res.headers?.['content-disposition'] as string | undefined,
        `${fileType}.pdf`,
        'application/pdf',
      );
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
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
  const cg = job.content_generation_status;
  // When content gen failed/skipped, leftover file `pending` must not look in-flight.
  const resumeBuilding =
    cg !== 'failed' &&
    cg !== 'skipped' &&
    (cg === 'pending' ||
      cg === 'processing' ||
      ((cg === 'completed' || !cg) &&
        (job.resume_build_status === 'pending' || job.resume_build_status === 'processing')));
  const jobLabel = [job.title, job.company].filter(Boolean).join(' · ') || 'Job';

  if (resumeBuilding && !resumeReady && !clReady) {
    return <DocsProcessingRing />;
  }

  if (!resumeReady && !clReady) {
    return <span className="text-slate-300 text-xs">-</span>;
  }

  return (
    <>
      <div className="flex items-center gap-1.5">
        {resumeBuilding && <DocsProcessingRing compact />}
        <div className="flex min-w-0 flex-col gap-0 leading-none">
          {resumeReady && (
            <DocButton
              label="R"
              jobId={job.id}
              filePath={job.resume_pdf_path}
              fileType="resume_pdf"
              docTitle={`Resume - ${jobLabel}`}
              onOpen={setPreview}
            />
          )}
          {clReady && (
            <DocButton
              label="CL"
              jobId={job.id}
              filePath={job.cover_letter_pdf_path}
              fileType="cover_letter_pdf"
              docTitle={`Cover letter - ${jobLabel}`}
              onOpen={setPreview}
            />
          )}
        </div>
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

/** Circular progress shown in the Docs column while resume/cover letter are building. */
const DocsProcessingRing = memo(function DocsProcessingRing({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className="inline-flex items-center gap-1.5 text-emerald-600"
      title="Building resume & cover letter…"
      aria-label="Building resume and cover letter"
    >
      <span className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center">
        <svg className="absolute inset-0 h-7 w-7 animate-spin" viewBox="0 0 28 28" aria-hidden>
          <circle
            cx="14"
            cy="14"
            r="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="text-emerald-200/80"
          />
          <circle
            cx="14"
            cy="14"
            r="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeDasharray="42 70"
            strokeLinecap="round"
            className="text-emerald-500"
          />
        </svg>
        <FileText size={11} className="relative text-emerald-600" />
      </span>
      {!compact && (
        <span className="text-[10px] font-semibold leading-tight text-emerald-700">
          Building
        </span>
      )}
    </div>
  );
});

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
  if (rs === 'completed' || job.resume_pdf_status === 'completed') dot3 = 'done';
  else if (cg === 'failed' || cg === 'skipped') dot3 = 'idle';
  else if (
    cg === 'pending' ||
    cg === 'processing' ||
    ((cg === 'completed' || !cg) && (rs === 'pending' || rs === 'processing'))
  ) {
    dot3 = 'active';
  }

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

/** Match score pill — fixed height so Status squares can match it exactly. */
const MatchScoreBadge = memo(function MatchScoreBadge({ score }: { score: number }) {
  return (
    <div
      title={`Match score: ${score}/100 - ${scoreLabel(score)}`}
      className={`inline-flex h-[28px] items-center gap-1.5 rounded-lg border px-2.5 shadow-sm ${scoreColors(score)}`}
    >
      <Sparkles size={11} className="shrink-0 opacity-75" />
      <span className="text-sm font-bold tabular-nums leading-none">{score}</span>
      <span className="text-[10px] font-medium leading-none opacity-70">{scoreLabel(score)}</span>
    </div>
  );
});

function WorkModeBadge({ mode, isRemoteFallback }: { mode: string | null | undefined; isRemoteFallback?: boolean }) {
  const raw = (mode || '').trim().toLowerCase();
  // "unknown" (and blanks) are not a real classification - fall back to is_remote.
  const meaningful = raw && raw !== 'unknown' ? raw : '';
  const normalized = meaningful || (isRemoteFallback ? 'remote' : '');
  if (normalized === 'remote') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-600">
        <Wifi size={13} />
        <span className="text-[11px] font-medium">Remote</span>
      </span>
    );
  }
  if (normalized === 'hybrid') {
    return <span className="text-[11px] font-semibold text-amber-700">Hybrid</span>;
  }
  if (normalized === 'onsite') {
    return <span className="text-[11px] font-semibold text-slate-600">Onsite</span>;
  }
  return <span className="text-slate-300 text-xs">-</span>;
}

/** Match column: score only (or pipeline dots). Integration badges live in Status. */
const MatchCell = memo(function MatchCell({ job }: { job: DashboardJob }) {
  if (job.match_overall_score != null) {
    return <MatchScoreBadge score={job.match_overall_score} />;
  }

  const dots = processingDots(job);
  return (
    <div className="flex h-[28px] flex-col justify-center gap-0.5">
      <div className="flex h-[10px] items-center gap-2">
        {dots.map((dot) => (
          <StatusDot key={dot.label} {...dot} />
        ))}
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
});

// ---------------------------------------------------------------------------
// Status squares — Applied / Google Sheets / Pumble
// ---------------------------------------------------------------------------

type StatusSquareTone = 'sky' | 'emerald' | 'violet';

const STATUS_SQUARE_TONES: Record<StatusSquareTone, { filled: string; empty: string; icon: string }> = {
  sky: {
    filled: 'border-sky-500 bg-sky-500 text-white shadow-sm shadow-sky-500/40 dark:border-sky-400 dark:bg-sky-400',
    empty: 'border-sky-400/55 bg-sky-500/[0.06] text-sky-400/70 dark:border-sky-500/50 dark:bg-sky-400/10 dark:text-sky-400/55',
    icon: 'text-inherit',
  },
  emerald: {
    filled: 'border-emerald-500 bg-emerald-500 text-white shadow-sm shadow-emerald-500/40 dark:border-emerald-400 dark:bg-emerald-400',
    empty: 'border-emerald-400/55 bg-emerald-500/[0.06] text-emerald-400/70 dark:border-emerald-500/50 dark:bg-emerald-400/10 dark:text-emerald-400/55',
    icon: 'text-inherit',
  },
  violet: {
    filled: 'border-violet-500 bg-violet-500 text-white shadow-sm shadow-violet-500/40 dark:border-violet-400 dark:bg-violet-400',
    empty: 'border-violet-400/55 bg-violet-500/[0.06] text-violet-400/70 dark:border-violet-500/50 dark:bg-violet-400/10 dark:text-violet-400/55',
    icon: 'text-inherit',
  },
};

const StatusSquare = memo(function StatusSquare({
  filled,
  tone,
  title,
  icon: Icon,
}: {
  filled: boolean;
  tone: StatusSquareTone;
  title: string;
  icon: typeof ClipboardCheck;
}) {
  const palette = STATUS_SQUARE_TONES[tone];
  return (
    <span
      title={title}
      aria-label={title}
      className={[
        'inline-flex shrink-0 items-center justify-center rounded-md border-2 transition-colors',
        filled ? palette.filled : palette.empty,
      ].join(' ')}
      style={{ width: MATCH_BADGE_H, height: MATCH_BADGE_H }}
    >
      <Icon size={14} strokeWidth={filled ? 2.6 : 2} className={palette.icon} />
    </span>
  );
});

/** Three filled/empty squares for Applied → Sheets → Pumble. */
const StatusSquaresCell = memo(function StatusSquaresCell({ job }: { job: DashboardJob }) {
  const applied = dashboardJobMarkedApplied(job);
  const sheetPosted = Boolean(job.sheet_posted_at);
  const pumblePosted = Boolean(job.pumble_posted_at);

  return (
    <div className="inline-flex items-center gap-1.5" role="group" aria-label="Posting status">
      <StatusSquare
        filled={applied}
        tone="sky"
        icon={ClipboardCheck}
        title={
          applied
            ? `Applied${job.applied_at ? ` · ${relativeTime(job.applied_at)}` : ''}${job.applied_by_name ? ` · ${job.applied_by_name}` : ''}`
            : 'Not applied'
        }
      />
      <StatusSquare
        filled={sheetPosted}
        tone="emerald"
        icon={Table2}
        title={
          sheetPosted
            ? `Posted to Google Sheets · ${relativeTime(job.sheet_posted_at!)}`
            : 'Not posted to Google Sheets'
        }
      />
      <StatusSquare
        filled={pumblePosted}
        tone="violet"
        icon={MessageSquare}
        title={
          pumblePosted
            ? `Posted to Pumble · ${relativeTime(job.pumble_posted_at!)}`
            : 'Not posted to Pumble'
        }
      />
    </div>
  );
});

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
  onApply: (job: DashboardJob) => void;
  onRerun: (jobs: DashboardJob[]) => void;
  onMarkApplied: (jobs: DashboardJob[]) => void;
  onMarkUnapplied: (jobs: DashboardJob[]) => void;
  onPostToSheet: (jobs: DashboardJob[]) => void;
  onPostToPumble: (jobs: DashboardJob[]) => void;
  onDelete: (jobs: DashboardJob[]) => void;
  sheetsConfigured: boolean;
  postingToSheet: boolean;
  pumbleConfigured: boolean;
  postingToPumble: boolean;
}

function ContextMenu({
  job,
  targets,
  x,
  y,
  onClose,
  onView,
  onApply,
  onRerun,
  onMarkApplied,
  onMarkUnapplied,
  onPostToSheet,
  onPostToPumble,
  onDelete,
  sheetsConfigured,
  postingToSheet,
  pumbleConfigured,
  postingToPumble,
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
      icon: <Rocket size={13} />,
      label: 'Apply with Assistant',
      onClick: () => { onApply(job); onClose(); },
    }] : []),
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
    {
      icon: postingToPumble ? <Loader2 size={13} className="animate-spin" /> : <MessageSquare size={13} />,
      label: multi
        ? `Post ${targets.length} jobs to Pumble`
        : 'Post to Pumble',
      disabled: !pumbleConfigured || postingToPumble,
      onClick: () => { onPostToPumble(targets); onClose(); },
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
      className="w-[212px] rounded-xl border border-slate-200 bg-white py-1.5 shadow-2xl animate-[modal-in_0.12s_ease-out_both]"
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
                : item.disabled && item.label.includes('Pumble') && !pumbleConfigured
                  ? 'Configure Pumble in Settings first'
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
  onPostToSheet: () => void;
  onPostToPumble: () => void;
  onDelete: () => void;
  rerunning: boolean;
  deleting: boolean;
  sheetsConfigured: boolean;
  pumbleConfigured: boolean;
  postingToSheet: boolean;
  postingToPumble: boolean;
}

function BulkBar({
  count,
  totalVisible,
  onSelectAll,
  onClearAll,
  onRerun,
  onOpenUrls,
  onPostToSheet,
  onPostToPumble,
  onDelete,
  rerunning,
  deleting,
  sheetsConfigured,
  pumbleConfigured,
  postingToSheet,
  postingToPumble,
}: BulkBarProps) {
  const busy = rerunning || deleting || postingToSheet || postingToPumble;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 shadow-sm">
      <SquareCheck size={15} className="text-blue-600 shrink-0" />
      <span className="text-sm font-bold text-blue-800">
        {count} selected
      </span>

      <div className="h-4 w-px bg-blue-200 mx-1" />

      <button type="button" onClick={onRerun} disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 py-1 text-xs font-semibold text-blue-700 shadow-sm transition hover:bg-blue-100 disabled:opacity-50">
        {rerunning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        Rerun selected
      </button>

      <button type="button" onClick={onOpenUrls} disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 py-1 text-xs font-semibold text-blue-700 shadow-sm transition hover:bg-blue-100 disabled:opacity-50">
        <OpenUrl size={12} />
        Open URLs
      </button>

      <button
        type="button"
        onClick={onPostToSheet}
        disabled={busy || !sheetsConfigured}
        title={!sheetsConfigured ? 'Configure Google Sheets in Settings first' : undefined}
        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1 text-xs font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-50 disabled:opacity-50"
      >
        {postingToSheet ? <Loader2 size={12} className="animate-spin" /> : <Table2 size={12} />}
        Post to Sheet
      </button>

      <button
        type="button"
        onClick={onPostToPumble}
        disabled={busy || !pumbleConfigured}
        title={!pumbleConfigured ? 'Configure Pumble in Settings first' : undefined}
        className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-white px-3 py-1 text-xs font-semibold text-violet-800 shadow-sm transition hover:bg-violet-50 disabled:opacity-50"
      >
        {postingToPumble ? <Loader2 size={12} className="animate-spin" /> : <MessageSquare size={12} />}
        Post to Pumble
      </button>

      <button type="button" onClick={onDelete} disabled={busy}
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
  canSync = false,
  onAppliedStateChange,
  onSheetPostedStateChange,
  onPumblePostedStateChange,
}: ScraperJobsTableProps) {
  const rerunJob         = useScraperStore((s) => s.rerunJob);
  const deleteJob        = useScraperStore((s) => s.deleteJob);
  const batchDeleteJobs  = useScraperStore((s) => s.batchDeleteJobs);
  const batchRerunJobs   = useScraperStore((s) => s.batchRerunJobs);
  const markJobsApplied  = useScraperStore((s) => s.markJobsApplied);
  const markJobsUnapplied = useScraperStore((s) => s.markJobsUnapplied);
  const postJobsToSheet  = useScraperStore((s) => s.postJobsToSheet);
  const postJobsToPumble = useScraperStore((s) => s.postJobsToPumble);
  const optimisticMarkJobsSheetPosted = useScraperStore((s) => s.optimisticMarkJobsSheetPosted);
  const optimisticMarkJobsPumblePosted = useScraperStore((s) => s.optimisticMarkJobsPumblePosted);
  const optimisticMarkJobsApplied = useScraperStore((s) => s.optimisticMarkJobsApplied);

  // Instant applied UI - local state avoids unstable Zustand selectors (infinite re-render loop).
  const [appliedUiOverride, setAppliedUiOverride] = useState<Record<string, AppliedUiOverride>>({});
  const knownJobIdsRef = useRef<Set<string>>(new Set());
  const wasLoadingRef = useRef(loading);
  const jobsPrimedRef = useRef(false);
  const [enteringJobIds, setEnteringJobIds] = useState<Set<string>>(() => new Set());

  const displayJobs = useMemo(
    () => jobs.map((j) => applyAppliedUiOverride(j, appliedUiOverride)),
    [jobs, appliedUiOverride],
  );

  useEffect(() => {
    const finishedLoading = wasLoadingRef.current && !loading;
    wasLoadingRef.current = loading;

    const prev = knownJobIdsRef.current;
    const nextIds = new Set(jobs.map((j) => j.id));
    const added = jobs.filter((j) => !prev.has(j.id)).map((j) => j.id);

    if (!jobsPrimedRef.current) {
      if (!loading) {
        jobsPrimedRef.current = true;
        knownJobIdsRef.current = nextIds;
      }
      return;
    }

    if (finishedLoading) {
      knownJobIdsRef.current = nextIds;
      return;
    }

    knownJobIdsRef.current = nextIds;
    if (added.length === 0) return;

    const overlapCount = jobs.length - added.length;
    if (prev.size > 0 && overlapCount === 0) return;
    if (added.length > 25) return;

    setEnteringJobIds(new Set(added));
    const timer = window.setTimeout(() => setEnteringJobIds(new Set()), 550);
    return () => window.clearTimeout(timer);
  }, [jobs, loading]);

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
  const [pumbleConfigured, setPumbleConfigured] = useState(false);
  const [pumbleIntegrations, setPumbleIntegrations] = useState<PumbleIntegration[]>([]);
  const [postingToPumble,  setPostingToPumble]  = useState(false);
  const [pumbleDestModalOpen, setPumbleDestModalOpen] = useState(false);
  const [pendingPumbleTargets, setPendingPumbleTargets] = useState<DashboardJob[]>([]);
  const [installFor,       setInstallFor]       = useState<DashboardJob | null>(null);
  const [applyChecking,    setApplyChecking]    = useState<string | null>(null);

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
    void fetchPumbleConfig()
      .then((config) => {
        if (cancelled) return;
        const integrations = (config.integrations ?? []).filter((i) => i.is_enabled !== false);
        setPumbleIntegrations(integrations);
        setPumbleConfigured(integrations.length > 0 || Boolean(config.configured));
      })
      .catch(() => {
        if (!cancelled) {
          setPumbleConfigured(false);
          setPumbleIntegrations([]);
        }
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
  // "Apply with Assistant": hand the job to the extension AND open its side
  // panel. We must dispatch synchronously inside the click so the user gesture
  // survives long enough for the worker to open the panel (Chrome requirement).
  // If the in-page bridge doesn't acknowledge, decide the fallback by install
  // state: installed-but-stale-tab -> open the URL and ask for a reload; not
  // installed -> prompt to install (and retry once they have).
  const handleApply = useCallback(async (job: DashboardJob) => {
    const ackPromise = applyViaExtension(job.id, job.source_url);
    setApplyChecking(job.id);
    try {
      const acked = await ackPromise;
      if (acked) {
        showToast('success', 'Sent to the Job Application Assistant - opening it now…');
        return;
      }
      const info = await detectExtension();
      if (info.installed) {
        window.open(job.source_url, '_blank', 'noopener,noreferrer');
        showToast('warning', 'Opened the job in a new tab. Reload this dashboard once so the assistant opens automatically.');
      } else {
        setInstallFor(job);
      }
    } finally {
      setApplyChecking(null);
    }
  }, [showToast]);

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
    // Bulk - confirm via bulk delete dialog (reuse deleting state)
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

  const executePostToPumble = useCallback((targets: DashboardJob[], integrationIds?: string[]) => {
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return;

    flushSync(() => {
      optimisticMarkJobsPumblePosted(ids);
      setSelectedIds(new Set());
      setIsSelectingMode(false);
      onPumblePostedStateChange?.(
        ids.map((id) => ({ id, pumble_posted_at: new Date().toISOString() })),
      );
    });

    setPostingToPumble(true);
    void postJobsToPumble(ids, integrationIds).then((res) => {
      setPostingToPumble(false);
      showToast(res.ok ? 'success' : 'error', res.message);
      if (!res.ok) {
        void useScraperStore.getState().bgRefreshJobs();
      }
    });
  }, [
    optimisticMarkJobsPumblePosted,
    onPumblePostedStateChange,
    postJobsToPumble,
    showToast,
  ]);

  const handlePostToPumble = useCallback((targets: DashboardJob[]) => {
    if (targets.length === 0) return;
    const enabled = pumbleIntegrations.filter((i) => i.is_enabled !== false);
    if (enabled.length > 1) {
      setPendingPumbleTargets(targets);
      setPumbleDestModalOpen(true);
      return;
    }
    executePostToPumble(targets, enabled.length === 1 ? [enabled[0].id] : undefined);
  }, [executePostToPumble, pumbleIntegrations]);

  const handlePumbleDestConfirm = useCallback((integrationIds: string[]) => {
    const targets = pendingPumbleTargets;
    setPumbleDestModalOpen(false);
    setPendingPumbleTargets([]);
    if (targets.length === 0 || integrationIds.length === 0) return;
    executePostToPumble(targets, integrationIds);
  }, [executePostToPumble, pendingPumbleTargets]);

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

  const handleBulkPostToSheet = useCallback(() => {
    void handlePostToSheet(selectedJobs);
  }, [handlePostToSheet, selectedJobs]);

  const handleBulkPostToPumble = useCallback(() => {
    void handlePostToPumble(selectedJobs);
  }, [handlePostToPumble, selectedJobs]);

  /* ── Loading / empty states ─────────────────────────────────────────── */
  if (loading) {
    return (
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <BrandedLoader compact label="Loading jobs…" />
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="p-12 text-center">
          <p className="text-slate-500 text-sm">No scraped jobs found.</p>
          <p className="text-slate-400 text-xs mt-1">
            {canSync
              ? 'Hit "Sync All" to start scraping.'
              : 'Jobs will appear here once an admin runs a sync.'}
          </p>
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
          onPostToSheet={handleBulkPostToSheet}
          onPostToPumble={handleBulkPostToPumble}
          onDelete={handleBulkDelete}
          rerunning={bulkRerunning}
          deleting={bulkDeleting}
          sheetsConfigured={sheetsConfigured}
          pumbleConfigured={pumbleConfigured}
          postingToSheet={postingToSheet}
          postingToPumble={postingToPumble}
        />
      )}

      {/* ── Hint when nothing selected ──────────────────────────────────── */}
      {selectedIds.size === 0 && (
        <p className="hidden items-center gap-1.5 px-1 text-[11px] text-slate-400 md:flex">
          <MousePointer2 size={11} />
          Long-press a row to start drag-selecting · Right-click for actions · Ctrl+Click to toggle
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="-mx-0 overflow-x-auto overscroll-x-contain">
          <table className="w-full min-w-[1100px] table-fixed border-collapse text-sm md:min-w-[1450px]">
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
                    ) : col.key === '__status__' ? (
                      <span className="inline-flex items-center gap-1.5" title="Applied · Google Sheets · Pumble">
                        <span>Status</span>
                        <span className="inline-flex items-center gap-0.5" aria-hidden>
                          <span className="h-2 w-2 rounded-[2px] bg-sky-500" />
                          <span className="h-2 w-2 rounded-[2px] bg-emerald-500" />
                          <span className="h-2 w-2 rounded-[2px] bg-violet-500" />
                        </span>
                      </span>
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
                const isApiCallInFlight = rerunningId === job.id;
                const pipelineStatus  = job.extraction_status;
                const isPipelineRunning = pipelineStatus === 'pending' || pipelineStatus === 'processing' || pipelineStatus === 'extracted';
                const isRerunning     = isApiCallInFlight || isPipelineRunning;
                const hasExtraction   = !!job.extraction_id;

                const isEntering = enteringJobIds.has(job.id);

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
                      isEntering ? 'animate-job-row-enter' : '',
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
                      </div>
                    </td>

                    {/* Company */}
                    <td className={`${CELL} text-slate-700 whitespace-nowrap text-xs truncate`}>
                      {job.company || '-'}
                    </td>

                    {/* Location */}
                    <td className={`${CELL} text-slate-500 text-xs truncate`}>
                      {job.location || '-'}
                    </td>

                    {/* Work mode */}
                    <td className={CELL}>
                      <WorkModeBadge mode={job.work_mode} isRemoteFallback={job.is_remote} />
                    </td>

                    {/* Salary */}
                    <td className={`${CELL} text-slate-500 whitespace-nowrap text-xs truncate`}>
                      {job.salary_raw || <span className="text-slate-300">-</span>}
                    </td>

                    {/* Type */}
                    <td className={`${CELL} text-slate-500 whitespace-nowrap text-xs truncate`}>
                      {job.job_type || <span className="text-slate-300">-</span>}
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

                    {/* Match (score only) */}
                    <td className={CELL}>
                      <MatchCell job={job} />
                    </td>

                    {/* Docs (Resume / Cover Letter / build progress) */}
                    <td className={CELL} onClick={(e) => e.stopPropagation()}>
                      <DocsCell job={job} />
                    </td>

                    {/* Status squares: Applied · Sheets · Pumble */}
                    <td className={CELL}>
                      <StatusSquaresCell job={job} />
                    </td>

                    {/* Actions (sticky) */}
                    <td
                      onClick={(e) => e.stopPropagation()}
                      className={`sticky right-0 z-10 px-2 py-0 whitespace-nowrap align-middle ${STICKY_SHADOW} ${dashboardJobStickyCellClass(job, { isSelected })}`}
                    >
                      <div className="flex items-center gap-1">
                        {/* Apply with Assistant */}
                        <button
                          type="button"
                          disabled={applyChecking === job.id}
                          onClick={() => void handleApply(job)}
                          title="Apply with the Job Application Assistant extension"
                          className="inline-flex w-[72px] h-[28px] items-center justify-center gap-1 rounded-md border border-blue-200 bg-blue-50 text-xs font-medium text-blue-700 transition-all hover:border-blue-300 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {applyChecking === job.id
                            ? <Loader2 size={12} className="animate-spin" />
                            : <Rocket size={12} />}
                          <span>Apply</span>
                        </button>

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
          onApply={(j) => void handleApply(j)}
          onRerun={(targets) => void handleRerunMany(targets)}
          onMarkApplied={(targets) => void handleMarkApplied(targets)}
          onMarkUnapplied={(targets) => void handleMarkUnapplied(targets)}
          onPostToSheet={(targets) => void handlePostToSheet(targets)}
          onPostToPumble={(targets) => void handlePostToPumble(targets)}
          onDelete={(targets) => handleDeleteMany(targets)}
          sheetsConfigured={sheetsConfigured}
          postingToSheet={postingToSheet}
          pumbleConfigured={pumbleConfigured}
          postingToPumble={postingToPumble}
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

      <InstallExtensionModal
        open={!!installFor}
        onClose={() => setInstallFor(null)}
        onInstalled={() => {
          const job = installFor;
          setInstallFor(null);
          if (job) void handleApply(job);
        }}
      />

      <PumbleDestinationModal
        open={pumbleDestModalOpen}
        integrations={pumbleIntegrations}
        jobCount={pendingPumbleTargets.length}
        posting={postingToPumble}
        onClose={() => {
          if (postingToPumble) return;
          setPumbleDestModalOpen(false);
          setPendingPumbleTargets([]);
        }}
        onConfirm={handlePumbleDestConfirm}
      />

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
