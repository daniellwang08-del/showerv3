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
  Sparkles,
  Target,
  ThumbsUp,
} from 'lucide-react';
import { apiClient } from '../api/client';

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
};

type JobMatchPayload = {
  valid_job_id: string;
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
  valid_job_id: string;
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
};

type JobAnalysisResponse = {
  valid_job_id: string;
  extraction_id: string | null;
  extraction_status: string | null;
  source_url: string;
  job_data: JobData | null;
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
  industry_alignment: 'Industry & project alignment',
  experience_match: 'Experience match',
  technical_skills: 'Technical skills',
  work_environment: 'Work environment',
};

type Props = {
  validJobId: string | null;
  onClose: () => void;
  onAnalysisUpdated?: () => void;
  refreshKey?: number;
};

/* ── Resume build file badges ────────────────────────────────────────── */

const FILE_BADGE_META: { key: keyof ResumeBuildStatus; label: string; downloadType: string }[] = [
  { key: 'resume_docx_status', label: 'Resume DOCX', downloadType: 'resume_docx' },
  { key: 'resume_pdf_status', label: 'Resume PDF', downloadType: 'resume_pdf' },
  { key: 'cover_letter_docx_status', label: 'Cover DOCX', downloadType: 'cover_letter_docx' },
  { key: 'cover_letter_pdf_status', label: 'Cover PDF', downloadType: 'cover_letter_pdf' },
];

function statusDotClass(status: string): string {
  if (status === 'completed') return 'bg-emerald-500';
  if (status === 'processing') return 'bg-amber-400 animate-pulse';
  if (status === 'failed') return 'bg-red-500';
  return 'bg-slate-300';
}

function ResumeBuildBadges({ build, validJobId }: { build: ResumeBuildStatus; validJobId: string }) {
  const cg = build.content_generation_status;
  if (cg === 'pending' || cg === 'processing') {
    return (
      <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700 animate-pulse">
        Generating resume…
      </span>
    );
  }
  if (cg === 'failed') {
    return (
      <span
        className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-medium text-red-700"
        title={build.content_generation_error || 'Content generation failed'}
      >
        Resume generation failed
      </span>
    );
  }
  if (cg === 'skipped') {
    return null;
  }

  const handleDownload = async (downloadType: string) => {
    try {
      const res = await apiClient.get(`/jobs/valid/${validJobId}/resume-build/download/${downloadType}`, {
        responseType: 'blob',
      });
      const blob = new Blob([res.data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ext = downloadType.endsWith('_pdf') ? '.pdf' : '.docx';
      a.download = `${downloadType}${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  };

  return (
    <div className="flex items-center gap-1.5">
      {FILE_BADGE_META.map(({ key, label, downloadType }) => {
        const status = (build[key] as string) || 'pending';
        const isReady = status === 'completed';
        return (
          <button
            key={key}
            type="button"
            disabled={!isReady}
            onClick={() => isReady && handleDownload(downloadType)}
            title={`${label}: ${status}${isReady ? ' — click to download' : ''}`}
            className={`group relative flex h-7 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium leading-none transition-colors ${
              isReady
                ? 'border-emerald-300/80 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 cursor-pointer'
                : status === 'processing'
                  ? 'border-amber-300/80 bg-amber-50 text-amber-700 cursor-wait'
                  : status === 'failed'
                    ? 'border-red-300/80 bg-red-50 text-red-700 cursor-not-allowed'
                    : 'border-slate-200 bg-slate-50 text-slate-400 cursor-default'
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

/** Large overall score — same band language as `MatchScoreChip` */
function matchScoreHeroClass(score: number): string {
  if (score >= 75) {
    return 'border border-emerald-300/95 bg-gradient-to-b from-emerald-100 to-emerald-50/95 text-emerald-950 shadow-md shadow-emerald-900/12';
  }
  if (score >= 45) {
    return 'border border-sky-300/90 bg-gradient-to-b from-sky-100 to-slate-50 text-sky-950 shadow-md shadow-sky-900/10';
  }
  return 'border border-amber-300/95 bg-gradient-to-b from-amber-100 to-amber-50/95 text-amber-950 shadow-md shadow-amber-900/12';
}

/** Per-dimension mini badges — mid-strength tints */
function matchScoreDimensionBadgeClass(score: number): string {
  if (score >= 80) {
    return 'border border-emerald-300/85 bg-gradient-to-b from-emerald-100 to-emerald-50 text-emerald-950 shadow-sm';
  }
  if (score >= 65) {
    return 'border border-green-300/85 bg-gradient-to-b from-green-100 to-green-50 text-green-950 shadow-sm';
  }
  if (score >= 50) {
    return 'border border-amber-300/85 bg-gradient-to-b from-amber-100 to-amber-50 text-amber-950 shadow-sm';
  }
  if (score >= 35) {
    return 'border border-orange-300/85 bg-gradient-to-b from-orange-100 to-orange-50 text-orange-950 shadow-sm';
  }
  return 'border border-red-300/85 bg-gradient-to-b from-red-100 to-red-50 text-red-950 shadow-sm';
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
      className={`flex items-start gap-3 rounded-xl border border-blue-200/55 bg-gradient-to-br from-white/95 to-blue-50/35 p-3 shadow-sm ring-1 ring-blue-100/40 transition hover:border-blue-300/70 hover:shadow-md ${
        wide ? 'sm:col-span-2' : ''
      }`}
    >
      <span
        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-100/90 text-blue-600 shadow-sm"
        aria-hidden
      >
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-[10px] font-semibold uppercase leading-tight tracking-wide text-slate-500">{label}</div>
        <div className="min-w-0 text-sm font-medium leading-snug text-slate-900">{children}</div>
      </div>
    </div>
  );
}

function SectionLabel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold text-slate-600">
      <Icon className="h-4 w-4 shrink-0 text-blue-600" strokeWidth={2} aria-hidden />
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
              className="break-all font-medium text-blue-600 hover:text-blue-800 hover:underline"
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
            {data.location}
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
        <div className="mt-2 whitespace-pre-wrap rounded-xl border border-blue-200/60 bg-white/80 p-3 text-slate-800 shadow-inner backdrop-blur-sm">
          {data.description}
        </div>
      </div>
      {data.responsibilities?.length > 0 && (
        <div>
          <SectionLabel icon={ListChecks}>Responsibilities</SectionLabel>
          <ul className="mt-2 list-inside list-disc space-y-0.5 pl-1 text-slate-800">
            {data.responsibilities.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {data.requirements?.length > 0 && (
        <div>
          <SectionLabel icon={ClipboardList}>Requirements</SectionLabel>
          <ul className="mt-2 list-inside list-disc space-y-0.5 pl-1 text-slate-800">
            {data.requirements.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {data.benefits?.length > 0 && (
        <div>
          <SectionLabel icon={Gift}>Benefits</SectionLabel>
          <ul className="mt-2 list-inside list-disc space-y-0.5 pl-1 text-slate-800">
            {data.benefits.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function DetailContentPanel({ validJobId, onClose, onAnalysisUpdated, refreshKey }: Props) {
  const onAnalysisUpdatedRef = useRef(onAnalysisUpdated);
  onAnalysisUpdatedRef.current = onAnalysisUpdated;

  const snapshotRef = useRef<JobAnalysisResponse | null>(null);
  const [analysis, setAnalysis] = useState<JobAnalysisResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(false);

  useEffect(() => {
    snapshotRef.current = null;
    setAnalysis(null);
    setLoadError(null);
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
  }, [validJobId, refreshKey]);

  const contentGenStatus = analysis?.resume_build?.content_generation_status;
  const contentGenActive = contentGenStatus === 'pending' || contentGenStatus === 'processing';
  const matchActive = analysis?.match_in_progress === true;
  const resumeFilesActive = analysis?.resume_build && (
    analysis.resume_build.resume_docx_status === 'processing' ||
    analysis.resume_build.resume_pdf_status === 'processing' ||
    analysis.resume_build.cover_letter_docx_status === 'processing' ||
    analysis.resume_build.cover_letter_pdf_status === 'processing'
  );

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
    }, 6000);

    return () => window.clearInterval(timer);
  }, [validJobId, matchActive, contentGenActive, resumeFilesActive]);

  if (!validJobId) return null;

  const extractionStatus = analysis?.extraction_status;
  const extractionBusy = extractionStatus === 'pending' || extractionStatus === 'processing' || extractionStatus === 'extracted';

  return (
    <div className="animate-detail-panel-in flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-blue-200/70 bg-white/90 shadow-lg backdrop-blur-md">
      <div className="flex shrink-0 items-center gap-2 border-b border-blue-200/60 bg-gradient-to-r from-blue-50/90 to-white/90 px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1 rounded-lg p-1.5 text-slate-600 transition hover:bg-blue-100/80 hover:text-slate-900"
          aria-label="Close panel"
        >
          <ChevronLeft className="h-5 w-5" />
          <span className="text-sm font-medium">Back</span>
        </button>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2 border-l border-blue-200/60 pl-3">
          <div className="flex min-w-0 items-center gap-2">
            <Target className="h-5 w-5 shrink-0 text-blue-600" />
            <span className="text-base font-bold text-slate-900">Job match analysis</span>
          </div>
          {analysis?.promotion ? (
            <div
              className="max-w-[min(300px,46vw)] shrink-0 rounded-xl border border-emerald-200/80 bg-emerald-50/95 px-2.5 py-1.5 text-emerald-900 shadow-sm"
              title={`${analysis.promotion.reason}\nBy ${analysis.promotion.promoted_by}${
                analysis.promotion.promoted_at ? `\n${formatPromotedAt(analysis.promotion.promoted_at)}` : ''
              }`}
            >
              <div className="truncate text-xs font-semibold leading-tight">{analysis.promotion.reason}</div>
              <div className="mt-0.5 truncate text-[10px] font-normal leading-tight text-emerald-800/90">
                By {analysis.promotion.promoted_by}
                {analysis.promotion.promoted_at
                  ? ` · ${formatPromotedAt(analysis.promotion.promoted_at)}`
                  : ''}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 timeline-scroll">
        {initialLoading && (
          <div className="flex flex-col items-center justify-center py-16 animate-panel-fade-in">
            <div
              className="h-10 w-10 animate-spinner rounded-full border-2 border-blue-200 border-t-blue-600"
              aria-hidden
            />
            <p className="mt-4 text-sm text-slate-600">Loading analysis…</p>
          </div>
        )}

        {loadError && (
          <div className="animate-content-in rounded-xl border border-red-200 bg-red-50/90 px-4 py-3 text-sm text-red-700">
            {loadError}
          </div>
        )}

        {!initialLoading && !loadError && analysis && (
          <div className="animate-content-in space-y-6 text-sm">
            <section className="relative overflow-hidden rounded-2xl border border-sky-200/70 bg-gradient-to-br from-sky-50/95 via-white to-slate-50/50 p-5 shadow-md shadow-sky-900/5 ring-1 ring-sky-100/70">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br from-sky-300/25 to-indigo-200/15 blur-2xl"
              />
              <div className="relative mb-4 flex flex-wrap items-center gap-2 border-b border-sky-200/55 pb-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-sky-300/80 bg-gradient-to-b from-sky-100 to-sky-50 text-sky-800 shadow-sm">
                  <Target className="h-4 w-4" strokeWidth={2.25} aria-hidden />
                </span>
                <div className="flex-1">
                  <h3 className="text-base font-semibold text-slate-900">Profile match</h3>
                  <p className="text-xs text-slate-500">How well this role fits your profile</p>
                </div>
                {analysis.resume_build && <ResumeBuildBadges build={analysis.resume_build} validJobId={analysis.valid_job_id} />}
              </div>

              {analysis.match_in_progress && !analysis.match && (
                <div className="flex flex-col items-center gap-3 py-6">
                  <div
                    className="h-9 w-9 animate-spinner rounded-full border-2 border-blue-200 border-t-blue-600"
                    aria-hidden
                  />
                  <p className="text-center text-slate-600">Running AI profile match…</p>
                  <p className="text-center text-xs text-slate-500">
                    Job details below update automatically when structured data is ready.
                  </p>
                </div>
              )}

              {!analysis.match_in_progress && !analysis.match && extractionStatus === 'completed' && (
                <p className="flex items-start gap-2 text-slate-600">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" aria-hidden />
                  <span>
                    No match score yet. Use the match badge on this job in the list to start analysis.
                  </span>
                </p>
              )}

              {!analysis.match_in_progress && !analysis.match && extractionBusy && (
                <p className="text-slate-500">Match analysis will be available after extraction completes.</p>
              )}

              {analysis.match && analysis.resume_build?.content_generation_status === 'failed' && (
                <p className="flex items-start gap-2 text-sm text-red-600">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    {analysis.resume_build.content_generation_error ||
                      'Tailored resume generation failed. Use resume build trigger to retry.'}
                  </span>
                </p>
              )}

              {analysis.match && analysis.resume_build &&
                (analysis.resume_build.content_generation_status === 'pending' ||
                  analysis.resume_build.content_generation_status === 'processing') && (
                <p className="flex items-start gap-2 text-sm text-slate-600">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500 animate-pulse" aria-hidden />
                  <span>Generating tailored resume and cover letter…</span>
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
                      <span className="text-base font-semibold text-slate-800">
                        {RECOMMENDATION_LABELS[analysis.match.recommendation] || analysis.match.recommendation}
                      </span>
                    </div>
                  </div>
                  <div>
                    <SectionLabel icon={AlignLeft}>Summary</SectionLabel>
                    <p className="mt-2 leading-relaxed text-slate-800">{analysis.match.summary}</p>
                  </div>
                  <div>
                    <SectionLabel icon={LayoutList}>Dimension scores</SectionLabel>
                    <ul className="mt-2 space-y-1.5">
                      {Object.entries(analysis.match.dimension_scores || {}).map(([key, value]) => (
                        <li key={key} className="flex items-center gap-2">
                          <span className="w-44 text-slate-700">{DIMENSION_LABELS[key] || key}:</span>
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
                      <ul className="mt-2 list-inside list-disc space-y-0.5 pl-1 text-slate-800">
                        {analysis.match.strengths.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {analysis.match.gaps?.length > 0 && (
                    <div>
                      <SectionLabel icon={AlertCircle}>Gaps</SectionLabel>
                      <ul className="mt-2 list-outside list-disc space-y-3 pl-5 text-slate-800 leading-relaxed">
                        {analysis.match.gaps.map((g, i) => (
                          <li key={i} className="marker:text-slate-400">
                            {g}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="glass-card rounded-xl border border-blue-200/50 p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-blue-100 bg-blue-50 text-blue-600">
                  <FileText className="h-4 w-4" strokeWidth={2} aria-hidden />
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-slate-900">Job details</h3>
                  {analysis.content_enriched_by_ai && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800">
                      <Sparkles className="h-3 w-3" />
                      Structured by AI
                    </span>
                  )}
                </div>
              </div>

              {analysis.source_url && (!analysis.job_data || extractionBusy) && (
                <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <MetaTile icon={Link2} label="Original posting" wide>
                    <a
                      href={analysis.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all font-medium text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      {analysis.source_url}
                    </a>
                  </MetaTile>
                </div>
              )}

              {!analysis.extraction_id && (
                <div className="rounded-lg border border-slate-200 bg-slate-50/90 px-3 py-2 text-slate-700">
                  Extraction has not started for this job yet.
                </div>
              )}

              {extractionBusy && (
                <div className="rounded-lg border border-amber-200/80 bg-amber-50/90 px-3 py-2 text-amber-900">
                  {extractionStatus === 'processing'
                    ? 'Extracting job content from the posting…'
                    : 'Job extraction is queued. Content will appear here when ready.'}
                </div>
              )}

              {extractionStatus === 'failed' && (
                <div className="rounded-lg border border-red-200/80 bg-red-50/90 px-3 py-2 text-red-800">
                  Extraction failed. Try re-scraping from the job row menu.
                </div>
              )}

              {analysis.job_data && !extractionBusy && postingBody(analysis.job_data, analysis.source_url)}

              {!analysis.job_data && extractionStatus === 'completed' && (
                <div className="rounded-lg border border-amber-200/80 bg-amber-50/90 px-3 py-2 text-amber-900">
                  No posting text available yet.
                </div>
              )}

              {analysis.job_data && analysis.extraction_method != null && (
                <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500 flex items-center gap-2">
                  <span>Method: {analysis.extraction_method}</span>
                  {analysis.is_job_posting === false && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 font-medium">
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
