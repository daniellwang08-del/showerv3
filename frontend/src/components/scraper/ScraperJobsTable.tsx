import { useState, useEffect, useRef, useCallback, useMemo, memo, type ReactNode } from 'react';
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
  /** Admins run extract-only; applicants run analyze (from saved JD when ready). */
  isAdmin?: boolean;
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
  { key: 'added_from',     label: 'Added from', sortable: false },
  { key: 'created_at',     label: 'Added',      sortable: true  },
  { key: '__processing__', label: 'Match',      sortable: true, sortKey: 'match_score' },
  { key: '__resume__',     label: 'Resume',     sortable: false },
  { key: '__cover__',      label: 'Cover',      sortable: false },
  { key: '__status__',     label: 'Status',     sortable: false },
  { key: '__actions__',    label: 'Actions',    sortable: false },
] as const;

type ColumnKey = (typeof columns)[number]['key'];

/** Left cluster keeps fixed widths; Source (omitted) absorbs remaining table width. */
const COLUMN_WIDTHS: Partial<Record<ColumnKey, string>> = {
  __check__: '32px',
  __no__: '44px',
  title: '220px',
  company: '118px',
  location: '108px',
  work_mode: '74px',
  salary_raw: '100px',
  job_type: '78px',
  posted_date: '68px',
  // 1.5× prior 130px so labels like "Welcome to the Jungle" fit without clipping.
  added_from: '195px',
  created_at: '68px',
  __processing__: '120px',
  __resume__: '108px',
  __cover__: '108px',
  __status__: '112px',
  __actions__: '300px',
};

/** Columns pinned to the right edge of the table. */
const RIGHT_ALIGN_KEYS = new Set<ColumnKey>([
  'posted_date',
  'created_at',
  '__processing__',
  '__resume__',
  '__cover__',
  '__status__',
  '__actions__',
]);

/** Hide Source first when the viewport cannot fit every column comfortably. */
const SOURCE_COL_CLASS = 'hidden min-[1600px]:table-column';
const SOURCE_CELL_CLASS = 'hidden min-[1600px]:table-cell';

/** Shared height with MatchScoreBadge so status squares align visually. */
const MATCH_BADGE_H = 28;

const ROW_H = 'h-[52px] max-h-[52px]';
const CELL = 'px-3 py-0 align-middle overflow-hidden';

const STICKY_SHADOW = 'shadow-[-4px_0_8px_-2px_rgba(0,0,0,0.06)]';

// ---------------------------------------------------------------------------
// Resume / Cover letter column helpers
// ---------------------------------------------------------------------------

function isDocsBuilding(job: DashboardJob): boolean {
  const cg = job.content_generation_status;
  return (
    cg !== 'failed' &&
    cg !== 'skipped' &&
    (cg === 'pending' ||
      cg === 'processing' ||
      ((cg === 'completed' || !cg) &&
        (job.resume_build_status === 'pending' || job.resume_build_status === 'processing')))
  );
}

const DocActionPair = memo(function DocActionPair({
  shortLabel,
  fullLabel,
  jobId,
  filePath,
  fileType,
  docTitle,
  accent,
}: {
  shortLabel: string;
  fullLabel: string;
  jobId: string;
  filePath: string | null;
  fileType: PreviewDocType;
  docTitle: string;
  accent: 'violet' | 'sky';
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewOpen(true);
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (downloading) return;
    setDownloading(true);
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
    } finally {
      setDownloading(false);
    }
  };

  const labelTone =
    accent === 'violet'
      ? 'text-violet-700 dark:text-violet-300'
      : 'text-sky-700 dark:text-sky-300';
  const viewTone =
    accent === 'violet'
      ? 'border-violet-200 bg-violet-50 text-violet-700 hover:border-violet-300 hover:bg-violet-100 dark:border-violet-500/30 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/25'
      : 'border-sky-200 bg-sky-50 text-sky-700 hover:border-sky-300 hover:bg-sky-100 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-200 dark:hover:bg-sky-500/25';
  const downloadTone =
    'border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-300 hover:bg-blue-100 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-200 dark:hover:bg-blue-500/25';

  return (
    <>
      <div className="inline-flex items-center gap-1.5" style={{ height: MATCH_BADGE_H }}>
        {/* Plain type label — not a chip/button, so users don't click it by mistake */}
        <span
          title={fullLabel}
          aria-hidden
          className={`pointer-events-none select-none inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide ${labelTone}`}
        >
          <FileText size={11} strokeWidth={2.2} className="opacity-70" />
          {shortLabel}
        </span>
        <button
          type="button"
          onClick={handleOpen}
          title={`View ${fullLabel}`}
          aria-label={`View ${fullLabel}`}
          className={`inline-flex h-full w-[28px] items-center justify-center rounded-lg border shadow-sm transition ${viewTone}`}
        >
          <Eye size={14} strokeWidth={2.35} />
        </button>
        <button
          type="button"
          onClick={(e) => void handleDownload(e)}
          disabled={downloading}
          title={`Download ${fullLabel}`}
          aria-label={`Download ${fullLabel}`}
          className={`inline-flex h-full w-[28px] items-center justify-center rounded-lg border shadow-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${downloadTone}`}
        >
          {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} strokeWidth={2.35} />}
        </button>
      </div>
      {previewOpen && (
        <DocumentPreviewModal
          jobId={jobId}
          fileType={fileType}
          title={docTitle}
          filePath={filePath}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  );
});

function ResumeDocCell({ job }: { job: DashboardJob }) {
  const ready = job.resume_pdf_status === 'completed';
  const building = isDocsBuilding(job);
  const jobLabel = [job.title, job.company].filter(Boolean).join(' · ') || 'Job';

  if (!ready && building) {
    return <DocsProcessingRing />;
  }
  if (!ready) {
    return <span className="text-slate-300 text-xs">-</span>;
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      {building && <DocsProcessingRing compact />}
      <DocActionPair
        shortLabel="R"
        fullLabel="Resume"
        jobId={job.id}
        filePath={job.resume_pdf_path}
        fileType="resume_pdf"
        docTitle={`Resume - ${jobLabel}`}
        accent="violet"
      />
    </div>
  );
}

function CoverDocCell({ job }: { job: DashboardJob }) {
  const ready = job.cover_letter_pdf_status === 'completed';
  const building = isDocsBuilding(job);
  const jobLabel = [job.title, job.company].filter(Boolean).join(' · ') || 'Job';

  if (!ready && building) {
    return <span className="text-[11px] font-semibold text-emerald-600/80">…</span>;
  }
  if (!ready) {
    return <span className="text-slate-300 text-xs">-</span>;
  }

  return (
    <DocActionPair
      shortLabel="CL"
      fullLabel="Cover letter"
      jobId={job.id}
      filePath={job.cover_letter_pdf_path}
      fileType="cover_letter_pdf"
      docTitle={`Cover letter - ${jobLabel}`}
      accent="sky"
    />
  );
}

const DocsProcessingRing = memo(function DocsProcessingRing({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className="inline-flex items-center gap-1.5 text-emerald-600"
      title="Building resume & cover letter…"
      aria-label="Building resume and cover letter"
      style={{ height: MATCH_BADGE_H }}
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
      className={`inline-flex h-[28px] max-w-full shrink-0 items-center gap-1.5 rounded-lg border px-2.5 shadow-sm ${scoreColors(score)}`}
    >
      <Sparkles size={11} className="shrink-0 opacity-75" />
      <span className="text-sm font-bold tabular-nums leading-none">{score}</span>
      <span className="text-[10px] font-medium leading-none opacity-70">{scoreLabel(score)}</span>
    </div>
  );
});

/** How the job entered the pool — separate from ATS/platform Source. */
const ADDED_FROM_LABELS: Record<string, string> = {
  manual: 'Manual',
  job_sites: 'Job sites',
  remoterocketship: 'RemoteRocketship',
  jobright: 'Jobright.ai',
  welcometothejungle: 'Welcome to the Jungle',
  adzuna: 'Adzuna',
  ziprecruiter: 'ZipRecruiter',
};

const ADDED_FROM_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  manual: 'info',
  job_sites: 'default',
  remoterocketship: 'default',
  jobright: 'info',
  welcometothejungle: 'success',
  adzuna: 'info',
  ziprecruiter: 'warning',
};

function resolveAddedFromSlug(job: DashboardJob): string {
  if (job.added_from === 'manual' || job.from_me) return 'manual';
  const raw = (job.added_from || '').trim().toLowerCase();
  if (raw && raw !== 'job_sites') return raw;
  return 'job_sites';
}

function AddedFromBadge({ job }: { job: DashboardJob }) {
  const slug = resolveAddedFromSlug(job);
  const label = ADDED_FROM_LABELS[slug] || slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const title =
    slug === 'manual'
      ? 'You added this job by URL or attachment'
      : slug === 'job_sites'
        ? 'Fetched from job sites during platform sync'
        : `Fetched from ${label} during platform sync`;
  return (
    <span title={title} className="inline-flex max-w-full">
      <Badge variant={ADDED_FROM_VARIANT[slug] || 'default'}>
        <span className="whitespace-nowrap">{label}</span>
      </Badge>
    </span>
  );
}

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

/** Match column: score only (or pipeline dots). Integration badges live in Status.
 *
 * Both states must share the same right edge. Unscored rows used to left-align the
 * dots inside a block sized by the "No score yet" caption, so the dots sat left of
 * score badges on neighboring rows.
 */
const MatchCell = memo(function MatchCell({ job }: { job: DashboardJob }) {
  if (job.match_overall_score != null) {
    return <MatchScoreBadge score={job.match_overall_score} />;
  }

  const dots = processingDots(job);
  let caption: ReactNode = null;
  if (job.match_in_progress) {
    caption = (
      <span className="flex items-center gap-1 text-[10px] font-medium leading-none text-blue-500 animate-pulse dark:text-sky-300">
        <Sparkles size={9} className="shrink-0" />
        Matching…
      </span>
    );
  } else if (job.extraction_status === 'completed') {
    caption = (
      <span className="text-[10px] font-medium leading-none text-slate-400 dark:text-slate-600">
        No score yet
      </span>
    );
  }

  return (
    <div
      className="flex h-[28px] w-full min-w-0 flex-col items-end justify-center gap-0.5"
      title="Pipeline progress: scrape → structure → documents"
    >
      <div className="flex h-[10px] shrink-0 items-center justify-end gap-1.5">
        {dots.map((dot) => (
          <StatusDot key={dot.label} {...dot} />
        ))}
      </div>
      {caption}
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
  onClick,
  disabled = false,
  busy = false,
}: {
  filled: boolean;
  tone: StatusSquareTone;
  title: string;
  icon: typeof ClipboardCheck;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const palette = STATUS_SQUARE_TONES[tone];
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={filled}
      disabled={disabled || busy}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled || busy) return;
        onClick();
      }}
      className={[
        'inline-flex shrink-0 items-center justify-center rounded-md border-2 transition-all',
        filled ? palette.filled : palette.empty,
        disabled || busy
          ? 'cursor-not-allowed opacity-60'
          : 'cursor-pointer hover:scale-[1.06] hover:brightness-105 active:scale-[0.97]',
      ].join(' ')}
      style={{ width: MATCH_BADGE_H, height: MATCH_BADGE_H }}
    >
      {busy
        ? <Loader2 size={14} strokeWidth={2.4} className={`animate-spin ${palette.icon}`} />
        : <Icon size={14} strokeWidth={filled ? 2.6 : 2} className={palette.icon} />}
    </button>
  );
});

/** Applied always; Sheets / Pumble only when the user has integrated them. */
const StatusSquaresCell = memo(function StatusSquaresCell({
  job,
  sheetsConfigured,
  pumbleConfigured,
  postingToSheet,
  postingToPumble,
  onToggleApplied,
  onPostToSheet,
  onPostToPumble,
}: {
  job: DashboardJob;
  sheetsConfigured: boolean;
  pumbleConfigured: boolean;
  postingToSheet: boolean;
  postingToPumble: boolean;
  onToggleApplied: (job: DashboardJob) => void;
  onPostToSheet: (job: DashboardJob) => void;
  onPostToPumble: (job: DashboardJob) => void;
}) {
  const applied = dashboardJobMarkedApplied(job);
  const sheetPosted = Boolean(job.sheet_posted_at);
  const pumblePosted = Boolean(job.pumble_posted_at);

  return (
    <div
      className="inline-flex items-center gap-1.5"
      role="group"
      aria-label="Job status actions"
      onClick={(e) => e.stopPropagation()}
    >
      <StatusSquare
        filled={applied}
        tone="sky"
        icon={ClipboardCheck}
        onClick={() => onToggleApplied(job)}
        title={
          applied
            ? `Applied${job.applied_at ? ` · ${relativeTime(job.applied_at)}` : ''}${job.applied_by_name ? ` · ${job.applied_by_name}` : ''} — click to unmark`
            : 'Mark as applied'
        }
      />
      {sheetsConfigured && (
        <StatusSquare
          filled={sheetPosted}
          tone="emerald"
          icon={Table2}
          busy={postingToSheet}
          onClick={() => onPostToSheet(job)}
          title={
            sheetPosted
              ? `Posted to Google Sheets · ${relativeTime(job.sheet_posted_at!)} — click to post again`
              : 'Post to Google Sheets'
          }
        />
      )}
      {pumbleConfigured && (
        <StatusSquare
          filled={pumblePosted}
          tone="violet"
          icon={MessageSquare}
          busy={postingToPumble}
          onClick={() => onPostToPumble(job)}
          title={
            pumblePosted
              ? `Posted to Pumble · ${relativeTime(job.pumble_posted_at!)} — click to post again`
              : 'Post to Pumble'
          }
        />
      )}
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
  isAdmin?: boolean;
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
  isAdmin = false,
}: ContextMenuProps) {
  const multi = targets.length > 1;
  const label = multi ? `${targets.length} jobs` : (job.title ? `"${job.title.slice(0, 28)}${job.title.length > 28 ? '…' : ''}"` : 'this job');
  const pipelineStatus = job.extraction_status;
  // Once a match score exists, Phase A is done — never treat as still "Analyzing".
  const analysisDone = job.match_overall_score != null;
  const isRunning =
    !analysisDone &&
    (pipelineStatus === 'pending' ||
      pipelineStatus === 'processing' ||
      (!isAdmin && pipelineStatus === 'extracted'));

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
    ...(sheetsConfigured || pumbleConfigured ? ['divider' as const] : []),
    ...(sheetsConfigured
      ? [{
          icon: postingToSheet ? <Loader2 size={13} className="animate-spin" /> : <Table2 size={13} />,
          label: multi
            ? `Post ${targets.length} jobs to Google Sheet`
            : 'Post to Google Sheet',
          disabled: postingToSheet,
          onClick: () => { onPostToSheet(targets); onClose(); },
        }]
      : []),
    ...(pumbleConfigured
      ? [{
          icon: postingToPumble ? <Loader2 size={13} className="animate-spin" /> : <MessageSquare size={13} />,
          label: multi
            ? `Post ${targets.length} jobs to Pumble`
            : 'Post to Pumble',
          disabled: postingToPumble,
          onClick: () => { onPostToPumble(targets); onClose(); },
        }]
      : []),
    'divider' as const,
    {
      icon: isRunning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />,
      label: multi
        ? `Prepare ${targets.length} jobs`
        : (isAdmin
          ? (job.extraction_id ? 'Re-extract job description' : 'Extract job description')
          : (job.extraction_id ? 'Analyze with saved JD' : 'Extract then analyze')),
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
  isAdmin?: boolean;
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
  isAdmin = false,
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
        {isAdmin ? 'Extract selected' : 'Prepare selected'}
      </button>

      <button type="button" onClick={onOpenUrls} disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 py-1 text-xs font-semibold text-blue-700 shadow-sm transition hover:bg-blue-100 disabled:opacity-50">
        <OpenUrl size={12} />
        Open URLs
      </button>

      {sheetsConfigured && (
        <button
          type="button"
          onClick={onPostToSheet}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1 text-xs font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-50 disabled:opacity-50"
        >
          {postingToSheet ? <Loader2 size={12} className="animate-spin" /> : <Table2 size={12} />}
          Post to Sheet
        </button>
      )}

      {pumbleConfigured && (
        <button
          type="button"
          onClick={onPostToPumble}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-white px-3 py-1 text-xs font-semibold text-violet-800 shadow-sm transition hover:bg-violet-50 disabled:opacity-50"
        >
          {postingToPumble ? <Loader2 size={12} className="animate-spin" /> : <MessageSquare size={12} />}
          Post to Pumble
        </button>
      )}

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
  isAdmin = false,
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
    if (isAdmin) {
      setSheetsConfigured(false);
      setPumbleConfigured(false);
      setPumbleIntegrations([]);
      return;
    }
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
  }, [isAdmin]);

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
    const jdReady =
      job.extraction_status === 'extracted' ||
      job.extraction_status === 'completed' ||
      job.match_overall_score != null;
    // Admin "Re-extract" must reset shared JD; applicants re-analyze without rescrape.
    const res = await rerunJob(job.id, {
      forceRescrape: isAdmin && jdReady,
    });
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

  const handleToggleApplied = useCallback((job: DashboardJob) => {
    if (dashboardJobMarkedApplied(job)) {
      handleMarkUnapplied([job]);
    } else {
      handleMarkApplied([job]);
    }
  }, [handleMarkApplied, handleMarkUnapplied]);

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
          isAdmin={isAdmin}
        />
      )}

      {/* ── Hint when nothing selected ──────────────────────────────────── */}
      {selectedIds.size === 0 && (
        <p className="hidden items-center gap-1.5 px-1 text-[11px] text-slate-400 md:flex">
          <MousePointer2 size={11} />
          Long-press a row to start drag-selecting · Right-click for actions · Ctrl+Click to toggle
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-600 dark:bg-slate-100">
        <div className="w-full min-w-0 overflow-x-auto overscroll-x-contain">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              {columns.map((col) => (
                <col
                  key={col.key}
                  style={
                    COLUMN_WIDTHS[col.key]
                      ? { width: COLUMN_WIDTHS[col.key], minWidth: COLUMN_WIDTHS[col.key] }
                      : undefined
                  }
                  className={col.key === 'source' ? SOURCE_COL_CLASS : undefined}
                />
              ))}
            </colgroup>

            {/* ── Header ── */}
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/70 dark:border-slate-600 dark:bg-slate-200/40">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => {
                      const sortKey = 'sortKey' in col && col.sortKey ? col.sortKey : col.key;
                      if (col.sortable) onSort(sortKey);
                    }}
                    className={[
                      'px-3 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap overflow-hidden',
                      RIGHT_ALIGN_KEYS.has(col.key) ? 'text-right' : 'text-left',
                      col.sortable ? 'cursor-pointer select-none hover:text-slate-700 hover:bg-slate-100/60' : '',
                      col.key === '__actions__' ? `sticky right-0 z-20 bg-slate-50/70 dark:bg-slate-200/40 ${STICKY_SHADOW}` : '',
                      col.key === '__check__' ? 'px-2' : '',
                      col.key === 'source' ? SOURCE_CELL_CLASS : '',
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
                      <span
                        className="inline-flex items-center gap-1.5"
                        title={[
                          'Applied',
                          sheetsConfigured ? 'Google Sheets' : null,
                          pumbleConfigured ? 'Pumble' : null,
                        ].filter(Boolean).join(' · ')}
                      >
                        <span>Status</span>
                        <span className="inline-flex items-center gap-0.5" aria-hidden>
                          <span className="h-2 w-2 rounded-[2px] bg-sky-500" />
                          {sheetsConfigured && <span className="h-2 w-2 rounded-[2px] bg-emerald-500" />}
                          {pumbleConfigured && <span className="h-2 w-2 rounded-[2px] bg-violet-500" />}
                        </span>
                      </span>
                    ) : col.key === '__resume__' ? (
                      <span title="Tailored resume PDF">Resume</span>
                    ) : col.key === '__cover__' ? (
                      <span title="Cover letter PDF">Cover</span>
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
                const analysisDone = job.match_overall_score != null;
                const isPipelineRunning =
                  !analysisDone &&
                  (pipelineStatus === 'pending' ||
                    pipelineStatus === 'processing' ||
                    (!isAdmin && pipelineStatus === 'extracted') ||
                    (!isAdmin && job.match_in_progress === true));
                const isRerunning     = isApiCallInFlight || isPipelineRunning;
                const hasExtraction   = !!job.extraction_id || analysisDone;
                const jdReady =
                  pipelineStatus === 'extracted' ||
                  pipelineStatus === 'completed' ||
                  analysisDone;

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

                    {/* Source — flex column; hidden when viewport is too narrow */}
                    <td className={`${CELL} ${SOURCE_CELL_CLASS}`}>
                      <Badge variant={SOURCE_BADGE_VARIANT[job.source?.toLowerCase() ?? ''] || 'default'}>
                        {job.source || job.domain}
                      </Badge>
                    </td>

                    {/* Posted */}
                    <td className={`${CELL} text-right text-slate-500 whitespace-nowrap text-xs`}>
                      {relativeTime(job.posted_date)}
                    </td>

                    {/* Added from — scrape site or Manual (Source stays the ATS/site) */}
                    <td className="px-3 py-0 align-middle whitespace-nowrap overflow-visible">
                      <AddedFromBadge job={job} />
                    </td>

                    {/* Added */}
                    <td className={`${CELL} text-right text-slate-500 whitespace-nowrap text-xs`}>
                      {relativeTime(job.created_at)}
                    </td>

                    {/* Match (score only) */}
                    <td className={`${CELL} text-right`}>
                      <div className="flex h-[28px] w-full items-center justify-end">
                        <MatchCell job={job} />
                      </div>
                    </td>

                    {/* Resume */}
                    <td className={`${CELL} text-right`} onClick={(e) => e.stopPropagation()}>
                      <div className="flex h-[28px] w-full items-center justify-end">
                        <ResumeDocCell job={job} />
                      </div>
                    </td>

                    {/* Cover letter */}
                    <td className={`${CELL} text-right`} onClick={(e) => e.stopPropagation()}>
                      <div className="flex h-[28px] w-full items-center justify-end">
                        <CoverDocCell job={job} />
                      </div>
                    </td>

                    {/* Status actions: Applied · Sheets? · Pumble? */}
                    <td className={`${CELL} text-right`}>
                      <div className="flex h-[28px] w-full items-center justify-end">
                        <StatusSquaresCell
                          job={job}
                          sheetsConfigured={sheetsConfigured}
                          pumbleConfigured={pumbleConfigured}
                          postingToSheet={postingToSheet}
                          postingToPumble={postingToPumble}
                          onToggleApplied={handleToggleApplied}
                          onPostToSheet={(j) => void handlePostToSheet([j])}
                          onPostToPumble={(j) => void handlePostToPumble([j])}
                        />
                      </div>
                    </td>

                    {/* Actions (sticky) */}
                    <td
                      onClick={(e) => e.stopPropagation()}
                      className={`sticky right-0 z-10 px-2 py-0 whitespace-nowrap align-middle text-right ${STICKY_SHADOW} ${dashboardJobStickyCellClass(job, { isSelected })}`}
                    >
                      <div className="flex items-center justify-end gap-1">
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
                            : isPipelineRunning && pipelineStatus === 'pending'    ? 'Queued – waiting for worker'
                            : isPipelineRunning && pipelineStatus === 'processing' ? 'Extracting job description…'
                            : isPipelineRunning && pipelineStatus === 'extracted'  ? 'Analyzing with AI…'
                            : isAdmin
                              ? (jdReady
                                ? 'Re-extract shared job description (inventory only)'
                                : 'Extract shared job description (inventory only)')
                              : job.match_overall_score != null
                                ? 'Re-analyze with your profile (uses saved job description)'
                                : hasExtraction
                                  ? 'Analyze with your profile (uses saved job description)'
                                  : 'Extract job description then analyze'
                          }
                          className={[
                            'relative inline-flex w-[96px] h-[28px] items-center justify-center gap-1 rounded-md border text-xs font-medium transition-all disabled:cursor-not-allowed',
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
                              : isPipelineRunning && pipelineStatus === 'pending'    ? 'Queued'
                              : isPipelineRunning && pipelineStatus === 'processing' ? 'Extracting'
                              : isPipelineRunning && pipelineStatus === 'extracted'  ? 'Analyzing'
                              : isAdmin
                                ? (jdReady ? 'Re-extract' : 'Extract')
                                : job.match_overall_score != null ? 'Re-analyze'
                                : hasExtraction                   ? 'Analyze'
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
          isAdmin={isAdmin}
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
