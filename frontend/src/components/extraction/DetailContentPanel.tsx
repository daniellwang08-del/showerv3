/**
 * Unified job analysis panel: posting (from extraction) + AI match metrics.
 * Polls one endpoint so the UI updates when scraping finishes or LLM returns.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle,
  AlignLeft,
  Building2,
  Briefcase,
  ChevronLeft,
  CircleDollarSign,
  ClipboardList,
  Clock,
  Download,
  Factory,
  FileText,
  Gift,
  GraduationCap,
  Home,
  LayoutList,
  ListChecks,
  Link2,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Target,
  ThumbsUp,
} from 'lucide-react';
import { apiClient } from '../../api/client';
import { saveManualJobDescription } from '../../api/scraperApi';
import { useScraperStore } from '../../stores/scraperStore';
import { namedDownloadFile } from '../../utils/resumeFileName';
import { BrandedLoader } from '../layout/BrandedLoader';
import { JobLocationLabel } from '../app/JobLocationLabel';
import { JobFilenameEditor, type JobDocumentNames } from './JobFilenameEditor';

type JobData = {
  title: string;
  company: string | null;
  location: string | null;
  description: string;
  responsibilities: string[];
  requirements: string[];
  benefits: string[];
  employment_type: string | null;
  salary_range: string | null;
  experience_level: string | null;
  industry: string | null;
  remote_policy?: string | null;
  work_mode?: string | null;
};

type JobMatchPayload = {
  job_id: string;
  overall_score: number;
  dimension_scores: Record<string, number>;
  summary: string;
  strengths: string[];
  gaps: string[];
  recommendation: string;
  created_at: string | null;
};

type JobPromotionInfo = {
  reason: string;
  promoted_by: string;
  promoted_at: string | null;
};

type ResumeBuildStatus = {
  job_id: string;
  content_generation_status?: string;
  content_generation_error?: string | null;
  resume_docx_status: string;
  resume_pdf_status: string;
  cover_letter_docx_status: string;
  cover_letter_pdf_status: string;
  output_directory: string | null;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
  filename_override?: string | null;
  file_names?: JobDocumentNames | null;
};

type JobAnalysisResponse = {
  job_id: string;
  extraction_id: string | null;
  extraction_status: string | null;
  source_url: string;
  job_data: JobData | null;
  raw_plain_text?: string | null;
  extraction_method: string | null;
  is_job_posting: boolean | null;
  content_enriched_by_ai: boolean;
  match: JobMatchPayload | null;
  match_in_progress: boolean;
  promotion?: JobPromotionInfo | null;
  resume_build?: ResumeBuildStatus | null;
};

function formatPromotedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const RECOMMENDATION_LABELS: Record<string, string> = {
  strong_match: 'Strong match',
  good_match: 'Good match',
  moderate_match: 'Moderate match',
  weak_match: 'Weak match',
  poor_match: 'Poor match',
};

const DIMENSION_LABELS: Record<string, string> = {
  skills_match: 'Skills match',
  experience_match: 'Experience match',
  job_title_similarity: 'Job title similarity',
  industry_domain_match: 'Industry / domain match',
  education: 'Education',
  user_preferences: 'Your preferences',
  // Legacy keys from older analyses
  industry_alignment: 'Industry & project alignment',
  technical_skills: 'Technical skills',
  work_environment: 'Work environment',
};

type Props = {
  validJobId: string | null;
  onClose: () => void;
  onAnalysisUpdated?: () => void;
  refreshKey?: number;
  /** Admin inventory view: emphasize extracted raw JD, de-emphasize profile match. */
  isAdmin?: boolean;
};

/* ── Resume build file badges ────────────────────────────────────────── */

const FILE_BADGE_META: { key: keyof ResumeBuildStatus; label: string; downloadType: string }[] = [
  { key: 'resume_docx_status', label: 'Resume DOCX', downloadType: 'resume_docx' },
  { key: 'resume_pdf_status', label: 'Resume PDF', downloadType: 'resume_pdf' },
  { key: 'cover_letter_docx_status', label: 'Cover DOCX', downloadType: 'cover_letter_docx' },
  { key: 'cover_letter_pdf_status', label: 'Cover PDF', downloadType: 'cover_letter_pdf' },
];

function statusDotClass(status: string): string {
  if (status === 'completed') return 'bg-status-ready';
  if (status === 'processing') return 'bg-status-preparing animate-pulse';
  if (status === 'failed') return 'bg-destructive';
  return 'bg-border';
}

function ResumeBuildBadges({
  build,
  validJobId,
  onRetry,
  retrying,
}: {
  build: ResumeBuildStatus;
  validJobId: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const cg = build.content_generation_status;
  if (cg === 'pending' || cg === 'processing') {
    return (
      <span className="rounded-md border border-status-ready/30 bg-status-ready/10 px-2 py-1 text-[10px] font-medium text-foreground animate-pulse">
        Writing documents…
      </span>
    );
  }
  if (cg === 'failed') {
    return (
      <div className="flex items-center gap-1.5">
        <span
          className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] font-medium text-destructive"
          title={build.content_generation_error || 'Content generation failed'}
        >
          Resume generation failed
        </span>
        {onRetry && (
          <button
            type="button"
            disabled={retrying}
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[10px] font-medium text-foreground hover:bg-muted/50 disabled:opacity-60"
          >
            <RefreshCw className={`h-3 w-3 ${retrying ? 'animate-spin' : ''}`} />
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
      </div>
    );
  }
  if (cg === 'skipped') {
    return (
      <span
        className="rounded-md border border-border bg-muted/50 px-2 py-1 text-[10px] font-medium text-muted-foreground"
        title={build.content_generation_error || 'Tailoring was skipped for this job'}
      >
        Tailoring skipped
      </span>
    );
  }

  const handleDownload = async (downloadType: string) => {
    try {
      const res = await apiClient.get(`/jobs/valid/${validJobId}/resume-build/download/${downloadType}`, {
        responseType: 'blob',
        params: { source: 'tailored' },
      });
      const ext = downloadType.endsWith('_pdf') ? '.pdf' : '.docx';
      const mime = downloadType.endsWith('_pdf')
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const file = namedDownloadFile(
        res.data,
        res.headers?.['content-disposition'] as string | undefined,
        `${downloadType}${ext}`,
        mime,
      );
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  };

  // Original resume mode builds only the cover letter; the imported resume goes out unchanged.
  const coverOnly = build.resume_docx_status === 'skipped' && build.resume_pdf_status === 'skipped';
  const badges = coverOnly ? FILE_BADGE_META.filter(({ downloadType }) => !downloadType.startsWith('resume_')) : FILE_BADGE_META;

  return (
    <div className="flex items-center gap-1.5">
      {coverOnly && (
        <span className="text-[10px] text-muted-foreground" title="Applications upload the resume file you imported, unchanged.">
          Uses original resume
        </span>
      )}
      {badges.map(({ key, label, downloadType }) => {
        const status = (build[key] as string) || 'pending';
        const isReady = status === 'completed';
        return (
          <button
            key={key}
            type="button"
            disabled={!isReady}
            onClick={() => isReady && handleDownload(downloadType)}
            title={`${label}: ${status}${isReady ? ' - click to download' : ''}`}
            className={`group relative flex h-7 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium leading-none transition-colors ${
              isReady
                ? 'border-status-ready/40 bg-status-ready/10 text-foreground hover:bg-status-ready/20 cursor-pointer'
                : status === 'processing'
                  ? 'border-status-preparing/40 bg-status-preparing/10 text-foreground cursor-wait'
                  : status === 'failed'
                    ? 'border-destructive/40 bg-destructive/10 text-destructive cursor-not-allowed'
                    : 'border-border bg-muted/50 text-muted-foreground cursor-default'
            }`}
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDotClass(status)}`} />
            <span className="whitespace-nowrap">{label.split(' ')[0]}</span>
            <span className="uppercase">{label.split(' ')[1]}</span>
            {isReady && <Download className="h-2.5 w-2.5 opacity-60 group-hover:opacity-100" />}
          </button>
        );
      })}
    </div>
  );
}

/** Large overall score - same band language as `MatchScoreChip` */
function matchScoreHeroClass(score: number): string {
  if (score >= 75) {
    return 'border border-status-ready/40 bg-status-ready/15 text-foreground shadow-md';
  }
  if (score >= 45) {
    return 'border border-brand/40 bg-brand-soft text-brand shadow-md';
  }
  return 'border border-status-preparing/40 bg-status-preparing/15 text-foreground shadow-md';
}

/** Per-dimension mini badges - mid-strength tints */
function matchScoreDimensionBadgeClass(score: number): string {
  if (score >= 80) {
    return 'border border-status-ready/40 bg-status-ready/10 text-foreground shadow-sm';
  }
  if (score >= 65) {
    return 'border border-status-ready/40 bg-status-ready/10 text-foreground shadow-sm';
  }
  if (score >= 50) {
    return 'border border-status-preparing/40 bg-status-preparing/10 text-foreground shadow-sm';
  }
  if (score >= 35) {
    return 'border border-status-preparing/40 bg-status-preparing/10 text-foreground shadow-sm';
  }
  return 'border border-destructive/40 bg-destructive/10 text-destructive shadow-sm';
}

function MetaTile({
  icon: Icon,
  label,
  children,
  wide = false,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
  /** Span both columns on sm+ (e.g. long URLs) */
  wide?: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border border-border bg-card p-3 shadow-sm transition hover:border-brand/40 hover:shadow-md ${
        wide ? 'sm:col-span-2' : ''
      }`}
    >
      <span
        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft/90 text-brand shadow-sm"
        aria-hidden
      >
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-[10px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="min-w-0 text-sm font-medium leading-snug text-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold text-muted-foreground">
      <Icon className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} aria-hidden />
      {children}
    </span>
  );
}

function postingBody(data: JobData, sourceUrl?: string | null) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {sourceUrl && (
          <MetaTile icon={Link2} label="Original posting" wide>
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="break-all font-medium text-brand hover:text-brand/80 hover:underline"
            >
              {sourceUrl}
            </a>
          </MetaTile>
        )}
        <MetaTile icon={Briefcase} label="Role title">
          {data.title}
        </MetaTile>
        {data.company && (
          <MetaTile icon={Building2} label="Company">
            {data.company}
          </MetaTile>
        )}
        {data.location && (
          <MetaTile icon={MapPin} label="Location">
            <JobLocationLabel location={data.location} className="text-sm text-foreground" />
          </MetaTile>
        )}
        {data.salary_range && (
          <MetaTile icon={CircleDollarSign} label="Salary">
            {data.salary_range}
          </MetaTile>
        )}
        {data.employment_type && (
          <MetaTile icon={Clock} label="Employment type">
            {data.employment_type}
          </MetaTile>
        )}
        {data.work_mode && data.work_mode !== 'unknown' && (
          <MetaTile icon={Home} label="Work mode">
            {data.work_mode.charAt(0).toUpperCase() + data.work_mode.slice(1)}
          </MetaTile>
        )}
        {data.remote_policy && (
          <MetaTile icon={Home} label="Remote / workplace">
            {data.remote_policy}
          </MetaTile>
        )}
        {data.experience_level && (
          <MetaTile icon={GraduationCap} label="Experience level">
            {data.experience_level}
          </MetaTile>
        )}
        {data.industry && (
          <MetaTile icon={Factory} label="Industry" wide>
            {data.industry}
          </MetaTile>
        )}
      </div>
      <div>
        <SectionLabel icon={FileText}>Description</SectionLabel>
        <div className="mt-2 max-h-[28rem] overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-card p-4 text-sm leading-relaxed text-foreground shadow-inner">
          {data.description}
        </div>
      </div>
      {data.responsibilities?.length > 0 && (
        <div>
          <SectionLabel icon={ListChecks}>Responsibilities</SectionLabel>
          <ul className="mt-2 list-inside list-disc space-y-0.5 pl-1 text-foreground">
            {data.responsibilities.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {data.requirements?.length > 0 && (
        <div>
          <SectionLabel icon={ClipboardList}>Requirements</SectionLabel>
          <ul className="mt-2 list-inside list-disc space-y-0.5 pl-1 text-foreground">
            {data.requirements.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {data.benefits?.length > 0 && (
        <div>
          <SectionLabel icon={Gift}>Benefits</SectionLabel>
          <ul className="mt-2 list-inside list-disc space-y-0.5 pl-1 text-foreground">
            {data.benefits.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function DetailContentPanel({
  validJobId,
  onClose,
  onAnalysisUpdated,
  refreshKey,
  isAdmin = false,
}: Props) {
  const onAnalysisUpdatedRef = useRef(onAnalysisUpdated);
  onAnalysisUpdatedRef.current = onAnalysisUpdated;

  const wsRefreshNonce = useScraperStore((s) =>
    validJobId && s.analysisPanelRefresh?.jobId === validJobId
      ? s.analysisPanelRefresh.nonce
      : 0,
  );
  const effectiveRefreshKey = (refreshKey ?? 0) + wsRefreshNonce;

  const snapshotRef = useRef<JobAnalysisResponse | null>(null);
  const [analysis, setAnalysis] = useState<JobAnalysisResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(false);
  const [retryingBuild, setRetryingBuild] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [editingJd, setEditingJd] = useState(false);
  const [draftJd, setDraftJd] = useState('');
  const [savingJd, setSavingJd] = useState(false);
  const [saveJdError, setSaveJdError] = useState<string | null>(null);

  useEffect(() => {
    snapshotRef.current = null;
    setAnalysis(null);
    setLoadError(null);
    setRetryError(null);
    setRetryingBuild(false);
    setEditingJd(false);
    setDraftJd('');
    setSavingJd(false);
    setSaveJdError(null);
  }, [validJobId]);

  useEffect(() => {
    if (!validJobId) return;

    let cancelled = false;

    const applyAndMaybeRefresh = (next: JobAnalysisResponse) => {
      const prev = snapshotRef.current;
      snapshotRef.current = next;
      setAnalysis(next);

      if (!prev) {
        return;
      }
      const resumeChanged =
        JSON.stringify(prev.resume_build) !== JSON.stringify(next.resume_build);
      const shouldRefresh =
        (!prev.match && next.match) ||
        (prev.extraction_status !== 'completed' && next.extraction_status === 'completed') ||
        (prev.extraction_status !== 'extracted' && next.extraction_status === 'extracted') ||
        (!prev.match_in_progress && next.match_in_progress) ||
        (!prev.content_enriched_by_ai && next.content_enriched_by_ai) ||
        resumeChanged;
      if (shouldRefresh) {
        onAnalysisUpdatedRef.current?.();
      }
    };

    const fetchAnalysis = async (silent: boolean) => {
      if (!silent) {
        setInitialLoading(true);
        setLoadError(null);
      }
      try {
        const res = await apiClient.get<JobAnalysisResponse>(`/jobs/valid/${validJobId}/analysis`);
        if (!cancelled) {
          applyAndMaybeRefresh(res.data);
        }
      } catch (e: unknown) {
        if (!cancelled && !silent) {
          const detail =
            typeof e === 'object' && e !== null && 'response' in e
              ? (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
              : null;
          setLoadError(typeof detail === 'string' ? detail : 'Failed to load job analysis');
        }
      } finally {
        if (!cancelled && !silent) {
          setInitialLoading(false);
        }
      }
    };

    void fetchAnalysis(snapshotRef.current !== null);

    return () => {
      cancelled = true;
    };
  }, [validJobId, effectiveRefreshKey]);

  const contentGenStatus = analysis?.resume_build?.content_generation_status;
  const contentGenActive = contentGenStatus === 'pending' || contentGenStatus === 'processing';
  const matchActive = analysis?.match_in_progress === true;
  const resumeFilesActive = analysis?.resume_build && (
    analysis.resume_build.resume_docx_status === 'processing' ||
    analysis.resume_build.resume_pdf_status === 'processing' ||
    analysis.resume_build.cover_letter_docx_status === 'processing' ||
    analysis.resume_build.cover_letter_pdf_status === 'processing'
  );

  const retryResumeBuild = async () => {
    if (!validJobId || retryingBuild) return;
    setRetryingBuild(true);
    setRetryError(null);
    try {
      await apiClient.post(`/jobs/valid/${validJobId}/resume-build/trigger`);
      setAnalysis((prev) => {
        if (!prev?.resume_build) return prev;
        return {
          ...prev,
          resume_build: {
            ...prev.resume_build,
            content_generation_status: 'processing',
            content_generation_error: null,
          },
        };
      });
      onAnalysisUpdatedRef.current?.();
    } catch (e: unknown) {
      const detail =
        typeof e === 'object' && e !== null && 'response' in e
          ? (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setRetryError(typeof detail === 'string' ? detail : 'Could not retry resume generation');
    } finally {
      setRetryingBuild(false);
    }
  };

  // Fallback poll while pipeline is active (WS may be briefly disconnected).
  useEffect(() => {
    if (!validJobId || (!matchActive && !contentGenActive && !resumeFilesActive)) return;

    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const res = await apiClient.get<JobAnalysisResponse>(`/jobs/valid/${validJobId}/analysis`);
          const prev = snapshotRef.current;
          snapshotRef.current = res.data;
          setAnalysis(res.data);
          if (prev && JSON.stringify(prev.resume_build) !== JSON.stringify(res.data.resume_build)) {
            onAnalysisUpdatedRef.current?.();
          }
          if (prev && !prev.match && res.data.match) {
            onAnalysisUpdatedRef.current?.();
          }
        } catch {
          /* ignore background poll errors */
        }
      })();
    }, 15000);

    return () => window.clearInterval(timer);
  }, [validJobId, matchActive, contentGenActive, resumeFilesActive]);

  if (!validJobId) return null;

  const extractionStatus = analysis?.extraction_status;
  // Only pending/processing are in-flight. `extracted` means shared raw JD is ready
  // (admin inventory + Analyze); treating it as busy hid the JD and showed a false
  // "queued" banner while the table correctly offered Analyze / No score.
  const extractionBusy =
    extractionStatus === 'pending' || extractionStatus === 'processing';
  const jdReady =
    extractionStatus === 'extracted' || extractionStatus === 'completed';
  const adminRawJd = (analysis?.raw_plain_text || analysis?.job_data?.description || '').trim();
  const hasAdminRawJd = adminRawJd.length > 0;
  const extractionFailed = extractionStatus === 'failed';

  const startAddJd = () => {
    setDraftJd('');
    setSaveJdError(null);
    setEditingJd(true);
  };

  const startEditJd = () => {
    setDraftJd(adminRawJd);
    setSaveJdError(null);
    setEditingJd(true);
  };

  const cancelEditJd = () => {
    if (savingJd) return;
    setEditingJd(false);
    setDraftJd('');
    setSaveJdError(null);
  };

  const saveManualJd = async () => {
    if (!validJobId || savingJd) return;
    const text = draftJd.trim();
    if (text.length < 10) {
      setSaveJdError('Paste at least 10 characters of job description text.');
      return;
    }
    setSavingJd(true);
    setSaveJdError(null);
    try {
      const res = await saveManualJobDescription(validJobId, text);
      setAnalysis((prev) =>
        prev
          ? {
              ...prev,
              extraction_id: res.extraction_id || prev.extraction_id,
              extraction_status: 'extracted',
              raw_plain_text: res.raw_plain_text,
              content_enriched_by_ai: false,
              is_job_posting: true,
            }
          : prev,
      );
      snapshotRef.current = {
        ...(snapshotRef.current || analysis)!,
        extraction_id: res.extraction_id,
        extraction_status: 'extracted',
        raw_plain_text: res.raw_plain_text,
        content_enriched_by_ai: false,
        is_job_posting: true,
      } as JobAnalysisResponse;
      setEditingJd(false);
      setDraftJd('');
      useScraperStore.getState().markJobManualJdSaved(validJobId);
      onAnalysisUpdatedRef.current?.();
    } catch (e: unknown) {
      const detail =
        typeof e === 'object' && e !== null && 'response' in e
          ? (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setSaveJdError(typeof detail === 'string' ? detail : 'Could not save job description');
    } finally {
      setSavingJd(false);
    }
  };

  return (
    <div className="animate-detail-panel-in flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/50 px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1 rounded-lg p-1.5 text-muted-foreground transition hover:bg-brand-soft/80 hover:text-foreground"
          aria-label="Close panel"
        >
          <ChevronLeft className="h-5 w-5" />
          <span className="text-sm font-medium">Back</span>
        </button>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2 border-l border-brand/40 pl-3">
          <div className="flex min-w-0 items-center gap-2">
            <Target className="h-5 w-5 shrink-0 text-brand" />
            <span className="text-base font-bold text-foreground">
              {isAdmin ? 'Job description' : 'Job match analysis'}
            </span>
          </div>
          {analysis?.promotion ? (
            <div
              className="max-w-[min(300px,46vw)] shrink-0 rounded-xl border border-status-ready/40 bg-status-ready/10 px-2.5 py-1.5 text-foreground shadow-sm"
              title={`${analysis.promotion.reason}\nBy ${analysis.promotion.promoted_by}${
                analysis.promotion.promoted_at ? `\n${formatPromotedAt(analysis.promotion.promoted_at)}` : ''
              }`}
            >
              <div className="truncate text-xs font-semibold leading-tight">{analysis.promotion.reason}</div>
              <div className="mt-0.5 truncate text-[10px] font-normal leading-tight text-foreground/90">
                By {analysis.promotion.promoted_by}
                {analysis.promotion.promoted_at
                  ? ` · ${formatPromotedAt(analysis.promotion.promoted_at)}`
                  : ''}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 timeline-scroll">
        {initialLoading && (
          <BrandedLoader compact label="Loading analysis…" className="py-16" />
        )}

        {loadError && (
          <div className="animate-content-in rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {!initialLoading && !loadError && analysis && (
          <div className="animate-content-in space-y-6 text-sm">
            {!isAdmin && (
            <section className="relative overflow-hidden rounded-2xl border border-brand/30 bg-gradient-to-br from-brand-soft/70 to-card p-5 shadow-sm">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-brand/10 blur-2xl"
              />
              <div className="relative mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-brand/40 bg-brand-soft text-brand shadow-sm">
                  <Target className="h-4 w-4" strokeWidth={2.25} aria-hidden />
                </span>
                <div className="flex-1">
                  <h3 className="text-base font-semibold text-foreground">Profile match</h3>
                  <p className="text-xs text-muted-foreground">How well this role fits your profile</p>
                </div>
                {analysis.resume_build && (
                  <ResumeBuildBadges
                    build={analysis.resume_build}
                    validJobId={analysis.job_id}
                    onRetry={retryResumeBuild}
                    retrying={retryingBuild}
                  />
                )}
              </div>
              {analysis.resume_build?.content_generation_status === 'completed' && (
                <JobFilenameEditor
                  validJobId={analysis.job_id}
                  override={analysis.resume_build.filename_override}
                  names={analysis.resume_build.file_names}
                  coverOnly={
                    analysis.resume_build.resume_docx_status === 'skipped' &&
                    analysis.resume_build.resume_pdf_status === 'skipped'
                  }
                  onSaved={(result) =>
                    setAnalysis((prev) =>
                      prev?.resume_build ? { ...prev, resume_build: { ...prev.resume_build, ...result } } : prev,
                    )
                  }
                />
              )}

              {analysis.match_in_progress && !analysis.match && (
                <div className="flex flex-col items-center gap-3 py-6">
                  <div
                    className="h-9 w-9 animate-spinner rounded-full border-2 border-brand/30 border-t-brand"
                    aria-hidden
                  />
                  <p className="text-center text-muted-foreground">Running AI profile match…</p>
                  <p className="text-center text-xs text-muted-foreground">
                    Job details below update automatically when structured data is ready.
                  </p>
                </div>
              )}

              {!analysis.match_in_progress && !analysis.match && jdReady && (
                <p className="flex items-start gap-2 text-muted-foreground">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
                  <span>
                    No match score yet. Use Analyze on this job in the list to start analysis.
                  </span>
                </p>
              )}

              {!analysis.match_in_progress && !analysis.match && extractionBusy && (
                <p className="text-muted-foreground">Match analysis will be available after extraction completes.</p>
              )}

              {analysis.match && analysis.resume_build?.content_generation_status === 'failed' && (
                <div className="space-y-2">
                  <p className="flex items-start gap-2 text-sm text-destructive">
                    <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>
                      {analysis.resume_build.content_generation_error ||
                        'Tailored resume generation failed.'}
                    </span>
                  </p>
                  <button
                    type="button"
                    disabled={retryingBuild}
                    onClick={() => void retryResumeBuild()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-60"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${retryingBuild ? 'animate-spin' : ''}`} />
                    {retryingBuild ? 'Retrying…' : 'Retry resume generation'}
                  </button>
                  {retryError && <p className="text-xs text-destructive">{retryError}</p>}
                </div>
              )}

              {analysis.match && analysis.resume_build?.content_generation_status === 'skipped' && (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span>
                    {analysis.resume_build.content_generation_error ||
                      'Tailoring was skipped for this job (for example empty profile or non-job posting).'}
                  </span>
                </p>
              )}

              {analysis.match && analysis.resume_build &&
                (analysis.resume_build.content_generation_status === 'pending' ||
                  analysis.resume_build.content_generation_status === 'processing') && (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-status-ready animate-pulse" aria-hidden />
                  <span>Writing the documents for this job…</span>
                </p>
              )}

              {analysis.match && (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <div
                      className={`rounded-2xl px-6 py-3 text-3xl font-bold tabular-nums tracking-tight ${matchScoreHeroClass(analysis.match.overall_score)}`}
                    >
                      {analysis.match.overall_score}
                    </div>
                    <div>
                      <span className="text-base font-semibold text-foreground">
                        {RECOMMENDATION_LABELS[analysis.match.recommendation] || analysis.match.recommendation}
                      </span>
                    </div>
                  </div>
                  <div>
                    <SectionLabel icon={AlignLeft}>Summary</SectionLabel>
                    <p className="mt-2 leading-relaxed text-foreground">{analysis.match.summary}</p>
                  </div>
                  <div>
                    <SectionLabel icon={LayoutList}>Dimension scores</SectionLabel>
                    <ul className="mt-2 space-y-1.5">
                      {Object.entries(analysis.match.dimension_scores || {}).map(([key, value]) => (
                        <li key={key} className="flex items-center gap-2">
                          <span className="w-44 text-foreground">{DIMENSION_LABELS[key] || key}:</span>
                          <span
                            className={`rounded-md px-2.5 py-0.5 text-xs font-semibold tabular-nums ${matchScoreDimensionBadgeClass(value)}`}
                          >
                            {value}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {analysis.match.strengths?.length > 0 && (
                    <div>
                      <SectionLabel icon={ThumbsUp}>Strengths</SectionLabel>
                      <ul className="mt-2 list-inside list-disc space-y-0.5 pl-1 text-foreground">
                        {analysis.match.strengths.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {analysis.match.gaps?.length > 0 && (
                    <div>
                      <SectionLabel icon={AlertCircle}>Gaps</SectionLabel>
                      <ul className="mt-2 list-outside list-disc space-y-3 pl-5 text-foreground leading-relaxed">
                        {analysis.match.gaps.map((g, i) => (
                          <li key={i} className="marker:text-muted-foreground">
                            {g}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>
            )}

            <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-brand/30 bg-brand-soft text-brand">
                  <FileText className="h-4 w-4" strokeWidth={2} aria-hidden />
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-foreground">
                    {isAdmin ? 'Extracted job description' : 'Job details'}
                  </h3>
                  {analysis.content_enriched_by_ai && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand">
                      <Sparkles className="h-3 w-3" />
                      Structured by AI
                    </span>
                  )}
                </div>
              </div>

              {analysis.source_url && (
                <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <MetaTile icon={Link2} label="Original posting" wide>
                    <a
                      href={analysis.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all font-medium text-brand hover:text-brand/80 hover:underline"
                    >
                      {analysis.source_url}
                    </a>
                  </MetaTile>
                </div>
              )}

              {!analysis.extraction_id && !isAdmin && (
                <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-foreground">
                  Extraction has not started for this job yet.
                </div>
              )}

              {extractionBusy && (
                <div className="rounded-lg border border-status-preparing/40 bg-status-preparing/10 px-3 py-2 text-foreground">
                  {extractionStatus === 'processing'
                    ? 'Extracting job content from the posting…'
                    : 'Job extraction is queued. Content will appear here when ready.'}
                </div>
              )}

              {extractionStatus === 'failed' && !editingJd && (
                <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                  {isAdmin
                    ? 'Extraction failed. Open the posting URL above, then paste the job description here, or delete the job from the table.'
                    : 'Extraction failed. Try re-scraping from the job row menu.'}
                </div>
              )}

              {/* Admin inventory: raw JD viewer / manual paste editor */}
              {isAdmin && !extractionBusy && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <SectionLabel icon={FileText}>
                      {editingJd
                        ? (hasAdminRawJd ? 'Edit job description' : 'Add job description')
                        : 'Raw job description'}
                    </SectionLabel>
                    {!editingJd && hasAdminRawJd && (
                      <button
                        type="button"
                        onClick={startEditJd}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:border-brand/30 hover:bg-brand-soft hover:text-brand"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit JD
                      </button>
                    )}
                  </div>

                  {editingJd ? (
                    <div className="space-y-3">
                      <textarea
                        value={draftJd}
                        onChange={(e) => setDraftJd(e.target.value)}
                        rows={16}
                        placeholder="Paste the full job description text from the posting…"
                        disabled={savingJd}
                        className="w-full resize-y rounded-xl border border-border bg-card p-4 text-sm leading-relaxed text-foreground shadow-inner outline-none ring-brand/30 placeholder:text-muted-foreground focus:border-ring focus:ring-2 disabled:opacity-60"
                      />
                      {saveJdError && (
                        <p className="text-sm text-destructive">{saveJdError}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={savingJd}
                          onClick={() => void saveManualJd()}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
                        >
                          {savingJd ? 'Saving…' : 'Save JD'}
                        </button>
                        <button
                          type="button"
                          disabled={savingJd}
                          onClick={cancelEditJd}
                          className="inline-flex items-center rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted/50 disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Saving marks this job as extracted. The pasted text is used as the shared raw job description.
                      </p>
                    </div>
                  ) : hasAdminRawJd ? (
                    <div className="max-h-[min(36rem,55vh)] overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-muted/50 p-4 text-sm leading-relaxed text-foreground shadow-inner">
                      {adminRawJd}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-border bg-muted/50 px-4 py-6 text-center">
                      <p className="text-sm text-muted-foreground">
                        {extractionFailed
                          ? 'No job description was extracted. Paste it manually after checking the posting.'
                          : extractionStatus === 'completed' || extractionStatus === 'extracted'
                            ? 'Extraction finished but no posting text was saved.'
                            : 'No job description text yet.'}
                      </p>
                      <button
                        type="button"
                        onClick={startAddJd}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add JD
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Applicant / structured view, show once scrape finished (extracted) or structured (completed) */}
              {!isAdmin && analysis.job_data && jdReady && postingBody(analysis.job_data, null)}

              {!isAdmin && !analysis.job_data && jdReady && (
                <div className="rounded-lg border border-status-preparing/40 bg-status-preparing/10 px-3 py-2 text-foreground">
                  {analysis.raw_plain_text ? (
                    <div>
                      <p className="mb-2 font-medium">Extracted posting text</p>
                      <div className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap rounded-lg border border-status-preparing/30 bg-card p-3 text-foreground">
                        {analysis.raw_plain_text}
                      </div>
                    </div>
                  ) : (
                    'No posting text available yet.'
                  )}
                </div>
              )}

              {analysis.job_data && analysis.extraction_method != null && (
                <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground flex items-center gap-2">
                  <span>Method: {analysis.extraction_method}</span>
                  {analysis.is_job_posting === false && (
                    <span className="rounded bg-status-preparing/10 px-1.5 py-0.5 text-foreground font-medium">
                      Not a job posting
                    </span>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
