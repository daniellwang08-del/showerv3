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

type JobAnalysisResponse = {
  valid_job_id: string;
  extraction_id: string | null;
  extraction_status: string | null;
  source_url: string;
  job_data: JobData | null;
  extraction_method: string | null;
  confidence_score: number | null;
  content_enriched_by_ai: boolean;
  match: JobMatchPayload | null;
  match_in_progress: boolean;
  promotion?: JobPromotionInfo | null;
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
  role_fit: 'Role fit',
  skills_match: 'Skills match',
  experience_level: 'Experience level',
  education_certifications: 'Education & certifications',
  location_work_style: 'Location & work style',
};

type Props = {
  validJobId: string | null;
  onClose: () => void;
  onAnalysisUpdated?: () => void;
};

function scoreColor(score: number) {
  if (score >= 80) return 'text-emerald-700 bg-emerald-100';
  if (score >= 65) return 'text-green-700 bg-green-100';
  if (score >= 50) return 'text-amber-700 bg-amber-100';
  if (score >= 35) return 'text-orange-700 bg-orange-100';
  return 'text-red-700 bg-red-100';
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

export function DetailContentPanel({ validJobId, onClose, onAnalysisUpdated }: Props) {
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
      const shouldRefresh =
        (!prev.match && next.match) ||
        (prev.extraction_status !== 'completed' && next.extraction_status === 'completed') ||
        (!prev.match_in_progress && next.match_in_progress) ||
        (!prev.content_enriched_by_ai && next.content_enriched_by_ai);
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

    void fetchAnalysis(false);
    const interval = window.setInterval(() => {
      void fetchAnalysis(true);
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [validJobId]);

  if (!validJobId) return null;

  const extractionStatus = analysis?.extraction_status;
  const extractionBusy = extractionStatus === 'pending' || extractionStatus === 'processing';

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
            <section className="glass-card relative rounded-xl border border-blue-300/60 bg-gradient-to-b from-blue-50/50 to-white/80 p-4 shadow-md">
              <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-blue-100 pb-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
                  <Target className="h-4 w-4" strokeWidth={2.25} aria-hidden />
                </span>
                <div>
                  <h3 className="text-base font-semibold text-slate-900">Profile match</h3>
                  <p className="text-xs text-slate-500">How well this role fits your profile</p>
                </div>
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

              {analysis.match && (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <div
                      className={`rounded-xl px-5 py-2.5 text-3xl font-bold tabular-nums shadow-sm ${scoreColor(analysis.match.overall_score)}`}
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
                          <span className={`rounded px-2 py-0.5 text-xs font-medium ${scoreColor(value)}`}>
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
                      <ul className="mt-2 list-inside list-disc space-y-0.5 pl-1 text-slate-800">
                        {analysis.match.gaps.map((g, i) => (
                          <li key={i}>{g}</li>
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
                <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
                  Method: {analysis.extraction_method} · Confidence:{' '}
                  {analysis.confidence_score != null
                    ? `${(analysis.confidence_score * 100).toFixed(0)}%`
                    : '—'}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
