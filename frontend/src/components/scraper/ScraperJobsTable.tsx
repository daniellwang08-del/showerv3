import { useState, useEffect, useRef, useCallback, useMemo, memo, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
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
  ExternalLink as OpenUrl,
  Download,
  ClipboardCheck,
  ClipboardX,
  Table2,
  Rocket,
  MessageSquare,
  FileText,
  ListChecks,
} from 'lucide-react';
import { Badge } from '../shared/Badge';
import { ConfirmDialog } from '../extraction/ConfirmDialog';
import { JobAnalysisModal } from './JobAnalysisModal';
import { DocumentPreviewModal, type PreviewDocType } from './DocumentPreviewModal';
import { InstallExtensionModal } from './InstallExtensionModal';
import { detectExtension, applyViaExtension } from '../../lib/extensionBridge';
import { useScraperStore } from '../../stores/scraperStore';
import { fetchDashboardJobs } from '../../api/scraperApi';
import { fetchSheetsConfig } from '../../api/googleSheetsApi';
import { fetchPumbleConfig } from '../../api/pumbleApi';
import { PumbleDestinationModal } from './PumbleDestinationModal';
import type { PumbleIntegration } from '../../types/pumble';
import { apiClient } from '../../api/client';
import { namedDownloadFile } from '../../utils/resumeFileName';
import type { DashboardJob, ExtractionStatus } from '../../types/scraper';
import { dashboardJobMarkedApplied, dashboardJobRowSurfaceClass } from '../../utils/appliedStatus';
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

const ALL_COLUMNS = [
  { key: '__check__',      label: '',           sortable: false },
  { key: '__no__',         label: 'No.',        sortable: false },
  { key: 'title',          label: 'Title',      sortable: true  },
  { key: 'company',        label: 'Company',    sortable: true  },
  // Admin: raw listing metadata is usually empty — show the posting URL instead.
  { key: 'source_url',     label: 'URL',        sortable: false, adminOnly: true as const },
  // Applicant-only listing metadata (admin table uses URL in their place).
  { key: 'location',       label: 'Location',   sortable: false, applicantOnly: true as const },
  { key: 'work_mode',      label: 'Mode',       sortable: false, applicantOnly: true as const },
  { key: 'salary_raw',     label: 'Salary',     sortable: false, applicantOnly: true as const },
  { key: 'job_type',       label: 'Type',       sortable: false, applicantOnly: true as const },
  { key: 'source',         label: 'Source',     sortable: false },
  { key: 'posted_date',    label: 'Posted',     sortable: true, applicantOnly: true as const },
  { key: 'added_from',     label: 'Added from', sortable: false },
  { key: 'created_at',     label: 'Added',      sortable: true  },
  { key: '__processing__', label: 'Match',      sortable: true, sortKey: 'match_score' as const, applicantOnly: true as const },
  { key: '__resume__',     label: 'Resume',     sortable: false, applicantOnly: true as const },
  { key: '__cover__',      label: 'Cover',      sortable: false, applicantOnly: true as const },
  { key: '__status__',     label: 'Status',     sortable: false },
  { key: '__actions__',    label: 'Actions',    sortable: false },
] as const;

type ColumnDef = (typeof ALL_COLUMNS)[number];
type ColumnKey = ColumnDef['key'];

function visibleColumns(isAdmin: boolean): ColumnDef[] {
  return ALL_COLUMNS.filter((col) => {
    if ('applicantOnly' in col && col.applicantOnly && isAdmin) return false;
    if ('adminOnly' in col && col.adminOnly && !isAdmin) return false;
    return true;
  });
}

/**
 * Column sizing for applicant + admin jobs tables:
 * - `table-auto` (w-max): every column width follows its content
 * - Cell padding (`px`/`py`) is the only horizontal constraint
 * - No fixed widths, no max-width caps, no truncate on body cells
 * - Horizontal scroll when the row is wider than the viewport
 */
const RIGHT_ALIGN_KEYS = new Set<ColumnKey>([
  'posted_date',
  'created_at',
  '__processing__',
  '__resume__',
  '__cover__',
  '__status__',
  '__actions__',
]);

/** Shared height with MatchScoreBadge so status squares align visually. */
const MATCH_BADGE_H = 28;

const ROW_H = 'h-[52px] max-h-[52px]';
/**
 * Universal cell: padding + nowrap + visible overflow.
 * Width is intrinsic from content for every column (title → actions).
 */
const CELL =
  'px-2.5 py-1.5 align-middle whitespace-nowrap overflow-visible';
const CELL_END = `${CELL} text-right`;

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

/**
 * Apply with Assistant is only offered when the full applicant pipeline is done:
 * match scored, tailored resume PDF + cover letter PDF ready, nothing in-flight.
 */
function isJobApplyReady(job: DashboardJob): boolean {
  if (job.match_overall_score == null) return false;
  if (job.match_in_progress) return false;
  const ext = job.extraction_status;
  if (ext === 'pending' || ext === 'processing') return false;
  if (isDocsBuilding(job)) return false;
  if (job.resume_pdf_status !== 'completed') return false;
  if (job.cover_letter_pdf_status !== 'completed') return false;
  return true;
}

const DocActionPair = memo(function DocActionPair({
  fullLabel,
  jobId,
  filePath,
  fileType,
  docTitle,
  accent,
}: {
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

  const viewTone =
    accent === 'violet'
      ? 'border-violet-200 bg-violet-50 text-violet-700 hover:border-violet-300 hover:bg-violet-100 dark:border-violet-500/30 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/25'
      : 'border-sky-200 bg-sky-50 text-sky-700 hover:border-sky-300 hover:bg-sky-100 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-200 dark:hover:bg-sky-500/25';
  const downloadTone =
    'border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-300 hover:bg-blue-100 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-200 dark:hover:bg-blue-500/25';

  return (
    <>
      <div className="inline-flex items-center gap-1" style={{ height: MATCH_BADGE_H }}>
        <button
          type="button"
          onClick={handleOpen}
          title={`View ${fullLabel}`}
          aria-label={`View ${fullLabel}`}
          className={`inline-flex h-full w-[26px] items-center justify-center rounded-md border shadow-sm transition ${viewTone}`}
        >
          <Eye size={13} strokeWidth={2.35} />
        </button>
        <button
          type="button"
          onClick={(e) => void handleDownload(e)}
          disabled={downloading}
          title={`Download ${fullLabel}`}
          aria-label={`Download ${fullLabel}`}
          className={`inline-flex h-full w-[26px] items-center justify-center rounded-md border shadow-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${downloadTone}`}
        >
          {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} strokeWidth={2.35} />}
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
    <div className="inline-flex items-center gap-1">
      {building && <DocsProcessingRing compact />}
      <DocActionPair
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
      className="inline-flex w-max shrink-0 items-center gap-1.5 whitespace-nowrap text-emerald-600"
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

  // Yellow = scrape. Done once raw JD exists (EXTRACTED or COMPLETED).
  let dot1: DotState = 'idle';
  if (es === 'pending' || es === 'processing') dot1 = 'active';
  else if (es === 'extracted' || es === 'completed') dot1 = 'done';

  // Blue = structuring (Phase A). Drive off match progress + true COMPLETED.
  // Legacy scrape-only COMPLETED rows (no is_job_posting) stay blue-idle until healed.
  let dot2: DotState = 'idle';
  if (job.match_in_progress) dot2 = 'active';
  else if (es === 'completed' && job.is_job_posting != null) dot2 = 'done';

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

/** Shared JD is on disk — same gate as Actions Run (yellow) / processing dots. */
function dashboardJobRawJdReady(job: DashboardJob): boolean {
  return (
    job.extraction_status === 'extracted' ||
    job.extraction_status === 'completed' ||
    job.match_overall_score != null
  );
}

/**
 * Title link color = job readiness at a glance:
 * - green  → marked applied (wins over everything)
 * - yellow → raw / shared JD ready (extracted or completed)
 * - blue   → fresh: no JD yet (not started, queued, or still extracting)
 * - rose   → extraction failed
 */
type JobTitleTone = 'fresh' | 'jd_ready' | 'applied' | 'failed';

function dashboardJobTitleTone(job: DashboardJob): JobTitleTone {
  if (dashboardJobMarkedApplied(job)) return 'applied';
  if (job.extraction_status === 'failed') return 'failed';
  if (dashboardJobRawJdReady(job)) return 'jd_ready';
  return 'fresh';
}

const JOB_TITLE_TONE_CLASS: Record<JobTitleTone, string> = {
  fresh: 'text-blue-600 hover:text-blue-800',
  jd_ready: 'text-yellow-700 hover:text-yellow-900',
  applied: 'text-emerald-600 hover:text-emerald-800',
  failed: 'text-rose-600 hover:text-rose-800',
};

const JOB_TITLE_TONE_HINT: Record<JobTitleTone, string> = {
  fresh: 'No job description yet',
  jd_ready: 'Job description ready',
  applied: 'Marked as applied',
  failed: 'Extraction failed',
};

const JobTitleLink = memo(function JobTitleLink({ job }: { job: DashboardJob }) {
  const tone = dashboardJobTitleTone(job);
  const label = job.title || 'Untitled';
  return (
    <a
      href={job.source_url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 font-medium leading-snug whitespace-nowrap ${JOB_TITLE_TONE_CLASS[tone]}`}
      title={`${JOB_TITLE_TONE_HINT[tone]} · ${label}`}
    >
      <span>{label}</span>
      <ExternalLink size={11} className="shrink-0 opacity-60" />
    </a>
  );
});

function scoreColors(score: number): string {
  if (score >= 75) {
    return 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300';
  }
  if (score >= 50) {
    return 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-300';
  }
  if (score >= 30) {
    return 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300';
  }
  return 'border-red-300 bg-red-50 text-red-800 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-300';
}
function scoreLabel(score: number): string {
  if (score >= 75) return 'Strong';
  if (score >= 50) return 'Good';
  if (score >= 30) return 'Fair';
  return 'Weak';
}

/** Shared Match column shell — content-sized with padding (no fixed width). */
const MATCH_PILL_BASE =
  'inline-flex h-[28px] w-max max-w-none shrink-0 items-center justify-center gap-1 rounded-lg border px-2 shadow-sm whitespace-nowrap';

/** Match score pill — grows with score + band label. */
const MatchScoreBadge = memo(function MatchScoreBadge({ score }: { score: number }) {
  return (
    <div
      title={`Match score: ${score}/100 - ${scoreLabel(score)}`}
      className={`${MATCH_PILL_BASE} ${scoreColors(score)}`}
    >
      <Sparkles size={11} className="shrink-0 opacity-75" aria-hidden />
      <span className="shrink-0 text-sm font-bold tabular-nums leading-none">{score}</span>
      <span className="shrink-0 text-[10px] font-medium leading-none opacity-70">
        {scoreLabel(score)}
      </span>
    </div>
  );
});

/** Match column: score only (or pipeline pending). Always the same pill footprint. */
const MatchCell = memo(function MatchCell({ job }: { job: DashboardJob }) {
  if (job.match_overall_score != null) {
    return <MatchScoreBadge score={job.match_overall_score} />;
  }

  const dots = processingDots(job).filter((dot) => dot.state !== 'idle');
  const matching = !!job.match_in_progress;
  const jdReady =
    job.extraction_status === 'extracted' || job.extraction_status === 'completed';

  let title = 'Pipeline progress: scrape → structure → documents';
  let shell =
    'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-600 dark:bg-slate-800/60 dark:text-slate-400';
  let body: ReactNode = <span className="text-[10px] font-medium leading-none">—</span>;

  if (matching) {
    title = 'Matching with your profile…';
    shell =
      'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-300';
    body = (
      <>
        <Sparkles size={11} className="shrink-0 animate-pulse opacity-80" aria-hidden />
        <span className="text-[10px] font-semibold leading-none animate-pulse">Matching…</span>
      </>
    );
  } else if (jdReady || dots.length > 0) {
    title = 'Job description ready — no match score yet';
    shell =
      'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300';
    body = (
      <>
        <span className="flex shrink-0 items-center gap-1" aria-hidden>
          {dots.length > 0
            ? dots.slice(0, 3).map((dot) => <StatusDot key={dot.label} {...dot} />)
            : <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
        </span>
        <span className="text-[10px] font-semibold leading-none">No score</span>
      </>
    );
  }

  return (
    <div title={title} className={`${MATCH_PILL_BASE} ${shell}`}>
      {body}
    </div>
  );
});

/** How the job entered the pool — short badges; full name stays in the tooltip. */
const ADDED_FROM_LABELS: Record<string, string> = {
  manual: 'FM',
  admin_manual: 'FA',
  job_sites: 'Sites',
  remoterocketship: 'RRS',
  jobright: 'JR.ai',
  welcometothejungle: 'WTTJ',
  adzuna: 'Aduna',
  ziprecruiter: 'ZR',
};

const ADDED_FROM_FULL_NAMES: Record<string, string> = {
  manual: 'Manual (from me)',
  admin_manual: 'Manual (from admin)',
  job_sites: 'Job sites',
  remoterocketship: 'RemoteRocketship',
  jobright: 'Jobright.ai',
  welcometothejungle: 'Welcome to the Jungle',
  adzuna: 'Adzuna',
  ziprecruiter: 'ZipRecruiter',
};

const ADDED_FROM_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  manual: 'info',
  admin_manual: 'warning',
  job_sites: 'default',
  remoterocketship: 'default',
  jobright: 'info',
  welcometothejungle: 'success',
  adzuna: 'info',
  ziprecruiter: 'warning',
};

function resolveAddedFromSlug(job: DashboardJob): string {
  const raw = (job.added_from || '').trim().toLowerCase();
  if (raw === 'admin_manual') return 'admin_manual';
  if (raw === 'manual' || job.from_me) return 'manual';
  if (raw && raw !== 'job_sites') return raw;
  return 'job_sites';
}

function AddedFromBadge({ job }: { job: DashboardJob }) {
  const slug = resolveAddedFromSlug(job);
  const label = ADDED_FROM_LABELS[slug] || slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const fullName = ADDED_FROM_FULL_NAMES[slug] || label;
  const title =
    slug === 'manual'
      ? 'You added this job by URL or attachment (FM)'
      : slug === 'admin_manual'
        ? 'Admin added this job manually to inventory (FA)'
        : slug === 'job_sites'
          ? 'Fetched from job sites during platform sync'
          : `Fetched from ${fullName} during platform sync`;
  return (
    <span title={title} className="inline-flex shrink-0">
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

/** Admin Status column: detailed JD extraction progress (not applicant apply/match). */
const AdminExtractionStatusCell = memo(function AdminExtractionStatusCell({
  job,
  onOpen,
}: {
  job: DashboardJob;
  onOpen?: (job: DashboardJob) => void;
}) {
  const status = (job.extraction_status || '').toLowerCase();
  const interactive = typeof onOpen === 'function';

  const wrap = (node: ReactNode, title: string) =>
    interactive ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(job);
        }}
        title={`${title} — click to view`}
        className="inline-flex cursor-pointer"
      >
        {node}
      </button>
    ) : (
      <div title={title}>{node}</div>
    );

  if (status === 'completed') {
    return wrap(
      <div
        className="inline-flex h-[28px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-2 text-emerald-800 shadow-sm transition hover:border-emerald-400 hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300"
      >
        <CheckCircle2 size={14} className="shrink-0" strokeWidth={2.25} />
        <span className="text-[11px] font-bold leading-none">Structured</span>
      </div>,
      'Job description structured by analysis',
    );
  }

  if (status === 'failed') {
    return wrap(
      <div
        className="inline-flex h-[28px] items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-2 text-rose-800 shadow-sm dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-300"
      >
        <AlertCircle size={13} className="shrink-0" />
        <span className="text-[11px] font-bold leading-none">Failed</span>
      </div>,
      'Job description extraction failed',
    );
  }

  if (status === 'processing') {
    return wrap(
      <div
        className="inline-flex h-[28px] items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2 text-amber-800 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
      >
        <Loader2 size={13} className="shrink-0 animate-spin" />
        <span className="text-[11px] font-bold leading-none">Extracting</span>
      </div>,
      'Extracting job description from the posting',
    );
  }

  if (status === 'pending') {
    return wrap(
      <div
        className="inline-flex h-[28px] items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-2 text-slate-700 shadow-sm dark:border-slate-500 dark:bg-slate-700/40 dark:text-slate-200"
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>
        <span className="text-[11px] font-bold leading-none">Queued</span>
      </div>,
      'Queued for job description extraction',
    );
  }

  if (status === 'extracted') {
    return wrap(
      <div
        className="inline-flex h-[28px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-2 text-emerald-800 shadow-sm transition hover:border-emerald-400 hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300"
      >
        <CheckCircle2 size={14} className="shrink-0" strokeWidth={2.25} />
        <span className="text-[11px] font-bold leading-none">Ready</span>
      </div>,
      'Shared job description scraped and ready',
    );
  }

  return wrap(
    <div
      className="inline-flex h-[28px] items-center gap-1.5 rounded-lg border border-dashed border-slate-300 bg-white px-2 text-slate-400 dark:border-slate-600 dark:bg-transparent dark:text-slate-500"
    >
      <span className="text-[11px] font-semibold leading-none">Not started</span>
    </div>,
    'No extraction started yet',
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
  const analysisDone = job.match_overall_score != null;
  // EXTRACTED = shared JD ready (not in-flight). Applicant analysis uses match_in_progress.
  const isRunning = isAdmin
    ? (pipelineStatus === 'pending' || pipelineStatus === 'processing')
    : (!analysisDone &&
      (pipelineStatus === 'pending' ||
        pipelineStatus === 'processing' ||
        job.match_in_progress === true));

  const unappliedTargets = targets.filter((t) => !dashboardJobMarkedApplied(t));
  const appliedTargets = targets.filter((t) => dashboardJobMarkedApplied(t));

  const appliedMenuItems: Array<{ icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }> = [];

  if (!isAdmin) {
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
  }

  const menuItems: Array<{ icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; disabled?: boolean } | 'divider'> = [
    ...(!multi && !isAdmin && isJobApplyReady(job) ? [{
      icon: <Rocket size={13} />,
      label: 'Apply with Assistant',
      onClick: () => { onApply(job); onClose(); },
    }] : []),
    ...(!multi ? [{
      icon: <Eye size={13} />,
      label: isAdmin ? 'View job details' : 'View analysis',
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
    ...(appliedMenuItems.length > 0 ? ['divider' as const, ...appliedMenuItems] : []),
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
        ? (isAdmin ? `Extract ${targets.length} jobs` : `Prepare ${targets.length} jobs`)
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
  unanalyzedCount: number;
  showSelectAllPages: boolean;
  selectingAllPages: boolean;
  onSelectAll: () => void;
  onSelectUnanalyzedPage: () => void;
  onSelectUnanalyzedAllPages: () => void;
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
  unanalyzedCount,
  showSelectAllPages,
  selectingAllPages,
  onSelectAll,
  onSelectUnanalyzedPage,
  onSelectUnanalyzedAllPages,
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
  const busy = rerunning || deleting || postingToSheet || postingToPumble || selectingAllPages;
  const unanalyzedLabel = isAdmin ? 'not extracted' : 'unanalyzed';

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 shadow-sm dark:border-blue-500/30 dark:bg-[#152033] sm:px-4">
      <button
        type="button"
        onClick={onClearAll}
        title="Clear selection (Esc)"
        aria-label={`Clear selection (${count} selected)`}
        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-white px-2 py-1 text-sm font-bold text-blue-800 shadow-sm transition hover:border-blue-400 hover:bg-blue-100 dark:border-blue-500/40 dark:bg-[#1a2740] dark:text-blue-100 dark:hover:bg-blue-500/20"
      >
        <SquareCheck size={15} className="shrink-0 text-blue-600 dark:text-blue-300" aria-hidden />
        {count} selected
      </button>

      <div className="mx-1 hidden h-4 w-px bg-blue-200 dark:bg-blue-500/30 sm:block" />

      <button type="button" onClick={onRerun} disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 shadow-sm transition hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200 dark:hover:bg-amber-500/25">
        {rerunning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        {isAdmin ? 'Extract selected' : 'Prepare selected'}
      </button>

      <button type="button" onClick={onOpenUrls} disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 py-1 text-xs font-semibold text-blue-700 shadow-sm transition hover:bg-blue-100 disabled:opacity-50 dark:border-blue-500/30 dark:bg-[#1a2740] dark:text-blue-200 dark:hover:bg-blue-500/20">
        <OpenUrl size={12} />
        Open URLs
      </button>

      {sheetsConfigured && (
        <button
          type="button"
          onClick={onPostToSheet}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1 text-xs font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-500/30 dark:bg-[#1a2740] dark:text-emerald-200 dark:hover:bg-emerald-500/15"
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
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-white px-3 py-1 text-xs font-semibold text-violet-800 shadow-sm transition hover:bg-violet-50 disabled:opacity-50 dark:border-violet-500/30 dark:bg-[#1a2740] dark:text-violet-200 dark:hover:bg-violet-500/15"
        >
          {postingToPumble ? <Loader2 size={12} className="animate-spin" /> : <MessageSquare size={12} />}
          Post to Pumble
        </button>
      )}

      <button type="button" onClick={onDelete} disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1 text-xs font-semibold text-red-600 shadow-sm transition hover:bg-red-50 disabled:opacity-50 dark:border-rose-500/30 dark:bg-[#1a2740] dark:text-rose-300 dark:hover:bg-rose-500/15">
        {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        Delete selected
      </button>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {count < totalVisible && (
          <button
            type="button"
            onClick={onSelectAll}
            title={`Select all ${totalVisible} jobs on this page`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-2.5 py-1 text-xs font-semibold text-blue-700 shadow-sm transition hover:bg-blue-100 dark:border-blue-500/30 dark:bg-[#1a2740] dark:text-blue-200 dark:hover:bg-blue-500/20"
          >
            <SquareCheck size={12} />
            Select all {totalVisible}
          </button>
        )}
        {unanalyzedCount > 0 && (
          <button
            type="button"
            onClick={onSelectUnanalyzedPage}
            disabled={busy}
            title={
              isAdmin
                ? `Select ${unanalyzedCount} jobs on this page without a job description`
                : `Select ${unanalyzedCount} jobs on this page that have not been analyzed yet`
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 shadow-sm transition hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200 dark:hover:bg-amber-500/25"
          >
            <ListChecks size={12} />
            {unanalyzedLabel} · page
            <span className="rounded-full bg-amber-200/80 px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums text-amber-900 dark:bg-amber-400/25 dark:text-amber-100">
              {unanalyzedCount}
            </span>
          </button>
        )}
        {showSelectAllPages && (
          <button
            type="button"
            onClick={onSelectUnanalyzedAllPages}
            disabled={busy}
            title={
              isAdmin
                ? 'Select every not-extracted job across all pages of the current filters'
                : 'Select every unanalyzed job across all pages of the current filters'
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 shadow-sm transition hover:bg-amber-200 disabled:opacity-50 dark:border-amber-400/50 dark:bg-amber-500/25 dark:text-amber-100 dark:hover:bg-amber-500/35"
          >
            {selectingAllPages ? <Loader2 size={12} className="animate-spin" /> : <ListChecks size={12} />}
            {unanalyzedLabel} · all pages
          </button>
        )}
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

  const columns = useMemo(() => visibleColumns(isAdmin), [isAdmin]);

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
  const applyInFlightRef = useRef<string | null>(null);

  // ── Selection state ───────────────────────────────────────────────────────
  const [selectedIds,     setSelectedIds]     = useState<Set<string>>(new Set());
  /**
   * Durable catalog of selected job rows. Without this, Prepare/Delete/etc. only
   * resolve jobs from the *current page* (`displayJobs`), so selections made on
   * other pages are counted in the bulk bar but silently dropped from processing.
   */
  const [selectedJobCatalog, setSelectedJobCatalog] = useState<DashboardJob[]>([]);
  const [selectingUnanalyzedAll, setSelectingUnanalyzedAll] = useState(false);
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

  // Keep catalog in sync: merge visible selected rows in, drop deselected rows.
  // Must run when either selection or the current page changes.
  useEffect(() => {
    setSelectedJobCatalog((prev) => {
      const byId = new Map<string, DashboardJob>();
      for (const j of prev) {
        if (selectedIds.has(j.id)) byId.set(j.id, j);
      }
      for (const j of displayJobs) {
        if (selectedIds.has(j.id)) byId.set(j.id, j);
      }
      const next: DashboardJob[] = [];
      for (const id of selectedIds) {
        const job = byId.get(id);
        if (job) next.push(job);
      }
      if (
        next.length === prev.length
        && next.every((j, i) => j.id === prev[i]?.id && j === prev[i])
      ) {
        return prev;
      }
      return next;
    });
  }, [selectedIds, displayJobs]);

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

  // Escape: close context menu first, otherwise clear the row selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (contextMenu) {
        setContextMenu(null);
        return;
      }
      if (selectedIds.size > 0) {
        setSelectedIds(new Set());
        setSelectedJobCatalog([]);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [contextMenu, selectedIds.size]);
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
      // Use the durable catalog — not just the current page — so multi-page
      // selections are not silently truncated to visible rows.
      const fromDisplay = new Map(displayJobs.map((j) => [j.id, j]));
      const fromCatalog = new Map(selectedJobCatalog.map((j) => [j.id, j]));
      const resolved: DashboardJob[] = [];
      for (const id of selectedIds) {
        const row = fromDisplay.get(id) ?? fromCatalog.get(id);
        if (row) resolved.push(row);
      }
      return resolved.length > 0 ? resolved : [job];
    }
    const row = displayJobs.find((j) => j.id === job.id) ?? job;
    return [row];
  }, [selectedIds, displayJobs, selectedJobCatalog]);

  // ── Action handlers ───────────────────────────────────────────────────────
  // "Apply with Assistant": hand the job to the extension AND open its side
  // panel. We must dispatch synchronously inside the click so the user gesture
  // survives long enough for the worker to open the panel (Chrome requirement).
  // If the in-page bridge doesn't acknowledge, decide the fallback by install
  // state: installed-but-stale-tab -> open the URL and ask for a reload; not
  // installed -> prompt to install (and retry once they have).
  const handleApply = useCallback(async (job: DashboardJob) => {
    if (!isJobApplyReady(job)) {
      showToast('warning', 'Finish match analysis and document generation before applying.');
      return;
    }
    // Synchronous in-flight guard (state alone is too late for double-clicks).
    if (applyInFlightRef.current) return;
    applyInFlightRef.current = job.id;
    // Must dispatch the CustomEvent inside this click turn (gesture → side panel).
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
        // NEVER window.open here. The bridge may have already told the worker to
        // chrome.tabs.create; a page-level open was the second identical tab.
        // Installed-but-stale-tab: user must reload so the content script attaches.
        showToast(
          'warning',
          'Extension is installed but this tab is not connected. Reload the dashboard, then click Apply again.',
        );
      } else {
        setInstallFor(job);
      }
    } finally {
      applyInFlightRef.current = null;
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
    if (targets.length === 0) return;
    if (targets.length === 1) { await handleRerun(targets[0]); return; }
    setBulkRerunning(true);
    try {
      const res = await batchRerunJobs(targets.map((t) => t.id));
      setSelectedIds(new Set());
      setSelectedJobCatalog([]);
      showToast(res.ok ? 'success' : res.partial ? 'warning' : 'error', res.message);
    } finally {
      setBulkRerunning(false);
    }
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
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedJobCatalog([]);
  }, []);

  const isUnanalyzedJob = useCallback(
    (j: DashboardJob) =>
      isAdmin ? !dashboardJobRawJdReady(j) : j.match_overall_score == null,
    [isAdmin],
  );

  /** Resolved selected rows in selection order (current page preferred over catalog). */
  const selectedJobs = useMemo(() => {
    const fromDisplay = new Map(displayJobs.map((j) => [j.id, j]));
    const fromCatalog = new Map(selectedJobCatalog.map((j) => [j.id, j]));
    const resolved: DashboardJob[] = [];
    for (const id of selectedIds) {
      const job = fromDisplay.get(id) ?? fromCatalog.get(id);
      if (job) resolved.push(job);
    }
    return resolved;
  }, [displayJobs, selectedJobCatalog, selectedIds]);

  const unanalyzedJobs = useMemo(
    () => displayJobs.filter(isUnanalyzedJob),
    [displayJobs, isUnanalyzedJob],
  );

  const tablePages = useScraperStore((s) => s.pages);

  /**
   * Prepare selected — always enqueue every id in `selectedIds`.
   * Using only `selectedJobs` previously dropped any selected row that had left
   * the current page (catalog was not kept for manual selection).
   */
  const handleBulkRerun = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    if (ids.length === 1) {
      const job = selectedJobs.find((j) => j.id === ids[0]);
      if (job) {
        await handleRerun(job);
        return;
      }
    }

    setBulkRerunning(true);
    try {
      const res = await batchRerunJobs(ids);
      setSelectedIds(new Set());
      setSelectedJobCatalog([]);
      showToast(res.ok ? 'success' : res.partial ? 'warning' : 'error', res.message);
    } finally {
      setBulkRerunning(false);
    }
  }, [selectedIds, selectedJobs, batchRerunJobs, showToast, handleRerun]);

  const handleSelectUnanalyzedPage = useCallback(() => {
    setSelectedJobCatalog([]);
    setSelectedIds(new Set(unanalyzedJobs.map((j) => j.id)));
  }, [unanalyzedJobs]);

  const handleSelectUnanalyzedAllPages = useCallback(async () => {
    if (selectingUnanalyzedAll) return;
    setSelectingUnanalyzedAll(true);
    try {
      const s = useScraperStore.getState();
      const perPage = 200;
      const collected: DashboardJob[] = [];
      let page = 1;
      let pages = 1;
      do {
        const result = await fetchDashboardJobs({
          page,
          per_page: perPage,
          source: s.sourceFilter || undefined,
          q: s.searchQuery || undefined,
          title: s.titleFilter || undefined,
          company: s.companyFilter || undefined,
          remote_only: s.remoteOnly || undefined,
          min_match_score: s.minScore || undefined,
          sort: s.sortField,
          order: s.sortOrder,
          view: s.view,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        collected.push(...result.items);
        pages = Math.max(1, result.pages || 1);
        page += 1;
      } while (page <= pages);

      const unanalyzed = collected.filter(isUnanalyzedJob);
      setSelectedJobCatalog(unanalyzed);
      setSelectedIds(new Set(unanalyzed.map((j) => j.id)));
      const label = isAdmin ? 'not extracted' : 'unanalyzed';
      showToast(
        'success',
        unanalyzed.length > 0
          ? `Selected ${unanalyzed.length} ${label} job${unanalyzed.length === 1 ? '' : 's'} across all pages.`
          : `No ${label} jobs found across all pages.`,
      );
    } catch {
      showToast('error', 'Could not load all pages for selection.');
    } finally {
      setSelectingUnanalyzedAll(false);
    }
  }, [isAdmin, isUnanalyzedJob, selectingUnanalyzedAll, showToast]);

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
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden dark:border-slate-700 dark:bg-[#141d31]">
        <div className="p-12 text-center">
          <p className="text-slate-500 text-sm dark:text-slate-400">
            {isAdmin ? 'No jobs match this view.' : 'No scraped jobs found.'}
          </p>
          <p className="text-slate-400 text-xs mt-1 dark:text-slate-500">
            {isAdmin
              ? 'Try another board filter, or Sync All if the pool is empty.'
              : canSync
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
          unanalyzedCount={unanalyzedJobs.length}
          showSelectAllPages={tablePages > 1}
          selectingAllPages={selectingUnanalyzedAll}
          onSelectAll={() => {
            setSelectedJobCatalog([]);
            setSelectedIds(new Set(jobs.map((j) => j.id)));
          }}
          onSelectUnanalyzedPage={handleSelectUnanalyzedPage}
          onSelectUnanalyzedAllPages={() => void handleSelectUnanalyzedAllPages()}
          onClearAll={clearSelection}
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
        <p className="hidden items-center gap-1.5 px-1 text-[11px] text-slate-500 md:flex dark:text-slate-300">
          <MousePointer2 size={11} />
          Long-press a row to start drag-selecting · Right-click for actions · Ctrl+Click to toggle
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-[#141d31]">
        <div className="w-full min-w-0 overflow-x-auto overscroll-x-contain">
          <table className="w-max min-w-full border-collapse text-sm">
            {/* ── Header ── */}
            <thead>
              <tr className="border-b border-slate-200 bg-slate-100 dark:border-slate-500/70 dark:bg-[#243148]">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => {
                      const sortKey = 'sortKey' in col && col.sortKey ? col.sortKey : col.key;
                      if (col.sortable) onSort(sortKey);
                    }}
                    className={[
                      'px-2.5 py-3.5 text-[11px] font-bold uppercase tracking-[0.08em] whitespace-nowrap',
                      'text-slate-700 dark:text-[#e8eef7]',
                      RIGHT_ALIGN_KEYS.has(col.key) ? 'text-right' : 'text-left',
                      col.sortable
                        ? 'cursor-pointer select-none hover:bg-slate-200/70 hover:text-slate-900 dark:hover:bg-[#2f3d58] dark:hover:text-white'
                        : '',
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
                        className="flex h-4 w-4 items-center justify-center rounded border border-slate-300 bg-white transition hover:border-blue-400 hover:bg-blue-50 dark:border-slate-500 dark:bg-slate-800 dark:hover:border-blue-400 dark:hover:bg-slate-700"
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
                        title={
                          isAdmin
                            ? 'Job description extraction progress'
                            : [
                                'Applied',
                                sheetsConfigured ? 'Google Sheets' : null,
                                pumbleConfigured ? 'Pumble' : null,
                              ].filter(Boolean).join(' · ')
                        }
                      >
                        <span>{isAdmin ? 'Extraction' : 'Status'}</span>
                        {!isAdmin && (
                          <span className="inline-flex items-center gap-0.5" aria-hidden>
                            <span className="h-2 w-2 rounded-[2px] bg-sky-500" />
                            {sheetsConfigured && <span className="h-2 w-2 rounded-[2px] bg-emerald-500" />}
                            {pumbleConfigured && <span className="h-2 w-2 rounded-[2px] bg-violet-500" />}
                          </span>
                        )}
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
                            size={12}
                            className={
                              sortField === ('sortKey' in col && col.sortKey ? col.sortKey : col.key)
                                ? 'text-blue-600 dark:text-sky-300'
                                : 'text-slate-400 dark:text-slate-300'
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
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700/80">
              {displayJobs.map((job, idx) => {
                const isSelected      = selectedIds.has(job.id);
                const isApiCallInFlight = rerunningId === job.id;
                const pipelineStatus  = job.extraction_status;
                const analysisDone = job.match_overall_score != null;
                // EXTRACTED = shared JD ready (not in-flight). Analysis uses match_in_progress.
                const isPipelineRunning = isAdmin
                  ? (pipelineStatus === 'pending' || pipelineStatus === 'processing')
                  : (!analysisDone &&
                    (pipelineStatus === 'pending' ||
                      pipelineStatus === 'processing' ||
                      job.match_in_progress === true));
                const isRerunning     = isApiCallInFlight || isPipelineRunning;
                const hasExtraction   =
                  !!job.extraction_id ||
                  analysisDone ||
                  pipelineStatus === 'completed' ||
                  pipelineStatus === 'extracted';
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
                    <td className="px-2 py-1.5 align-middle whitespace-nowrap">
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
                    <td className={`${CELL} text-xs text-slate-400 font-mono`}>
                      {rowOffset + idx + 1}
                    </td>

                    {/* Title — full text; column grows with content */}
                    <td className={CELL}>
                      <JobTitleLink job={job} />
                    </td>

                    {/* Company */}
                    <td className={`${CELL} text-slate-700 text-xs`}>
                      {job.company || '-'}
                    </td>

                    {/* Admin: posting URL — full URL, content-sized */}
                    {isAdmin && (
                      <td className={CELL}>
                        <a
                          href={job.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-block whitespace-nowrap font-mono text-[11px] leading-snug text-slate-600 hover:text-blue-600 dark:text-[#cbd5e1] dark:hover:text-[#93c5fd]"
                          title={job.source_url}
                        >
                          {job.source_url || <span className="text-slate-400 dark:text-[#64748b]">-</span>}
                        </a>
                      </td>
                    )}

                    {/* Applicant listing metadata */}
                    {!isAdmin && (
                      <>
                        <td className={`${CELL} text-slate-500 text-xs`}>
                          {job.location || '-'}
                        </td>
                        <td className={CELL}>
                          <WorkModeBadge mode={job.work_mode} isRemoteFallback={job.is_remote} />
                        </td>
                        <td className={`${CELL} text-slate-500 text-xs`}>
                          {job.salary_raw || <span className="text-slate-300">-</span>}
                        </td>
                        <td className={`${CELL} text-slate-500 text-xs`}>
                          {job.job_type || <span className="text-slate-300">-</span>}
                        </td>
                      </>
                    )}

                    {/* Source */}
                    <td className={CELL}>
                      <Badge variant={SOURCE_BADGE_VARIANT[job.source?.toLowerCase() ?? ''] || 'default'}>
                        <span className="whitespace-nowrap">{job.source || job.domain || '-'}</span>
                      </Badge>
                    </td>

                    {/* Posted (applicant only) */}
                    {!isAdmin && (
                      <td className={`${CELL_END} text-slate-500 text-xs`}>
                        {relativeTime(job.posted_date)}
                      </td>
                    )}

                    {/* Added from */}
                    <td className={CELL}>
                      <AddedFromBadge job={job} />
                    </td>

                    {/* Added */}
                    <td className={`${CELL_END} text-slate-500 text-xs`}>
                      {relativeTime(job.created_at)}
                    </td>

                    {/* Match / Resume / Cover — applicant only */}
                    {!isAdmin && (
                      <>
                        <td className={CELL_END}>
                          <div className="inline-flex h-[28px] items-center justify-end">
                            <MatchCell job={job} />
                          </div>
                        </td>
                        <td className={CELL_END} onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex h-[28px] items-center justify-end">
                            <ResumeDocCell job={job} />
                          </div>
                        </td>
                        <td className={CELL_END} onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex h-[28px] items-center justify-end">
                            <CoverDocCell job={job} />
                          </div>
                        </td>
                      </>
                    )}

                    {/* Status */}
                    <td className={CELL_END}>
                      <div className="inline-flex h-[28px] items-center justify-end gap-1.5">
                        {isAdmin ? (
                          <AdminExtractionStatusCell
                            job={job}
                            onOpen={(j) => setViewingJobId(j.id)}
                          />
                        ) : (
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
                        )}
                      </div>
                    </td>

                    {/* Actions */}
                    <td
                      onClick={(e) => e.stopPropagation()}
                      className={CELL_END}
                    >
                      <div className="inline-flex items-center justify-end gap-1">
                        {/* Apply with Assistant — only when match + resume + cover are done */}
                        {/* Apply with Assistant — only when match + resume + cover are done */}
                        {!isAdmin && isJobApplyReady(job) && (
                          <button
                            type="button"
                            disabled={applyChecking === job.id}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void handleApply(job);
                            }}
                            title="Apply with the Job Application Assistant extension"
                            className="inline-flex h-[28px] shrink-0 items-center justify-center gap-0.5 rounded-md border border-blue-200 bg-blue-50 px-1.5 text-[11px] font-medium text-blue-700 transition-all hover:border-blue-300 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-70 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-200"
                          >
                            {applyChecking === job.id
                              ? <Loader2 size={12} className="animate-spin" />
                              : <Rocket size={12} />}
                            <span>Apply</span>
                          </button>
                        )}

                        {/* Run / Rerun */}
                        <button
                          type="button"
                          disabled={isRerunning}
                          onClick={() => handleRerun(job)}
                          title={
                            isApiCallInFlight         ? 'Starting pipeline…'
                            : isPipelineRunning && pipelineStatus === 'pending'    ? 'Queued – waiting for worker'
                            : isPipelineRunning && pipelineStatus === 'processing' ? 'Extracting job description…'
                            : isPipelineRunning && job.match_in_progress
                              ? 'Analyzing with AI…'
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
                            'relative inline-flex h-[28px] shrink-0 items-center justify-center gap-0.5 rounded-md border px-1.5 text-[11px] font-medium transition-all disabled:cursor-not-allowed',
                            isPipelineRunning
                              ? 'border-amber-300 bg-amber-50 text-amber-700 opacity-90 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300'
                              : isAdmin
                                ? (jdReady
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300'
                                  : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-300 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-300')
                                : analysisDone
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300'
                                  : hasExtraction
                                    ? 'border-yellow-300 bg-yellow-50 text-yellow-800 hover:bg-yellow-100 hover:border-yellow-400 dark:border-yellow-500/40 dark:bg-yellow-500/15 dark:text-yellow-300'
                                    : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-300 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-300',
                          ].join(' ')}
                        >
                          {isRerunning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                          <span>
                            {isApiCallInFlight         ? '…'
                              : isPipelineRunning && pipelineStatus === 'pending'    ? 'Wait'
                              : isPipelineRunning && pipelineStatus === 'processing' ? '…'
                              : isPipelineRunning && job.match_in_progress           ? '…'
                              : isAdmin
                                ? (jdReady ? 'Re-run' : 'Run')
                                : analysisDone
                                  ? 'Re-run'
                                  : 'Run'}
                          </span>
                          {!isRerunning && (
                            isAdmin
                              ? (jdReady && (
                                  <CheckCircle2 size={10} className="text-emerald-500 shrink-0 dark:text-emerald-400" />
                                ))
                              : analysisDone
                                ? (
                                  <CheckCircle2 size={10} className="text-emerald-500 shrink-0 dark:text-emerald-400" />
                                )
                                : hasExtraction
                                  ? (
                                    <CheckCircle2 size={10} className="text-yellow-500 shrink-0 dark:text-yellow-400" />
                                  )
                                  : null
                          )}
                        </button>

                        {/* Delete — always visible; never shrink away behind Apply/Re-run */}
                        <button
                          type="button"
                          onClick={() => { setDeleteError(null); setDeleting([job]); }}
                          title="Delete"
                          aria-label="Delete job"
                          className="inline-flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition-all hover:border-red-200 hover:bg-red-50 hover:text-red-600 dark:border-slate-500/50 dark:bg-[#0b1220] dark:text-slate-300 dark:hover:border-rose-400/50 dark:hover:bg-rose-500/15 dark:hover:text-rose-300"
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
        <JobAnalysisModal
          validJobId={viewingJobId}
          onClose={() => setViewingJobId(null)}
          isAdmin={isAdmin}
          onAnalysisUpdated={() => {
            void useScraperStore.getState().bgRefreshJobs();
            void useScraperStore.getState().loadStats({
              silent: true,
              isAdmin: useScraperStore.getState().statsRole === 'admin',
            });
          }}
        />
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
