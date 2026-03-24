/**
 * Displays scraped job content or job match analysis in the right panel.
 * Replaces modal-based display with inline panel + smooth animation.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, FileText, Target } from 'lucide-react';
import { apiClient } from '../api/client';

type ExtractionResponse = {
  job_id: string;
  status: string;
  source_url: string;
  extraction_method: string | null;
  job_data: {
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
  } | null;
  error_message: string | null;
  confidence_score: number | null;
};

type JobMatchResponse = {
  valid_job_id: string;
  overall_score: number;
  dimension_scores: Record<string, number>;
  summary: string;
  strengths: string[];
  gaps: string[];
  recommendation: string;
  created_at: string | null;
};

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
  mode: 'scraped' | 'jobmatch' | null;
  extractionId: string | null;
  validJobId: string | null;
  onClose: () => void;
  onMatchStored?: () => void;
};

function scoreColor(score: number) {
  if (score >= 80) return 'text-emerald-700 bg-emerald-100';
  if (score >= 65) return 'text-green-700 bg-green-100';
  if (score >= 50) return 'text-amber-700 bg-amber-100';
  if (score >= 35) return 'text-orange-700 bg-orange-100';
  return 'text-red-700 bg-red-100';
}

export function DetailContentPanel({ mode, extractionId, validJobId, onClose, onMatchStored }: Props) {
  const onMatchStoredRef = useRef(onMatchStored);
  onMatchStoredRef.current = onMatchStored;

  const [scrapedLoading, setScrapedLoading] = useState(false);
  const [scrapedError, setScrapedError] = useState<string | null>(null);
  const [scrapedData, setScrapedData] = useState<ExtractionResponse | null>(null);

  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchData, setMatchData] = useState<JobMatchResponse | null>(null);

  useEffect(() => {
    if (mode === 'scraped' && extractionId) {
      let cancelled = false;
      setScrapedLoading(true);
      setScrapedError(null);
      setScrapedData(null);
      apiClient
        .get<ExtractionResponse>(`/extract/${extractionId}`)
        .then((res) => {
          if (!cancelled) setScrapedData(res.data);
        })
        .catch((e: any) => {
          if (!cancelled) setScrapedError(e.response?.data?.detail || 'Failed to load scraped content');
        })
        .finally(() => {
          if (!cancelled) setScrapedLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
  }, [mode, extractionId]);

  useEffect(() => {
    if (mode === 'jobmatch' && validJobId) {
      let cancelled = false;
      setMatchLoading(true);
      setMatchError(null);
      setMatchData(null);
      apiClient
        .get<JobMatchResponse>(`/jobs/valid/${validJobId}/match`)
        .then((res) => {
          if (!cancelled) {
            setMatchData(res.data);
            onMatchStoredRef.current?.();
          }
        })
        .catch((e: any) => {
          if (!cancelled) setMatchError(e.response?.data?.detail || 'Failed to load job match');
        })
        .finally(() => {
          if (!cancelled) setMatchLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
  }, [mode, validJobId]);

  if (!mode) return null;

  const title = mode === 'scraped' ? 'Scraped content' : 'Job match analysis';
  const Icon = mode === 'scraped' ? FileText : Target;
  const iconColor = mode === 'scraped' ? 'text-emerald-600' : 'text-blue-600';

  const loading = mode === 'scraped' ? scrapedLoading : matchLoading;
  const error = mode === 'scraped' ? scrapedError : matchError;

  return (
    <div className="animate-detail-panel-in flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-slate-50/80 px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1 rounded p-1.5 text-slate-600 transition hover:bg-slate-200 hover:text-slate-800"
          aria-label="Back to duplicates"
        >
          <ChevronLeft className="h-5 w-5" />
          <span className="text-sm font-medium">Back</span>
        </button>
        <div className="flex flex-1 items-center gap-2 border-l border-slate-200 pl-3">
          <Icon className={`h-5 w-5 shrink-0 ${iconColor}`} />
          <span className="text-base font-bold text-slate-900">{title}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading && (
          <div className="flex flex-col items-center justify-center py-16 animate-panel-fade-in">
            <div
              className="h-10 w-10 animate-spinner rounded-full border-2 border-slate-200 border-t-blue-500"
              aria-hidden
            />
            <p className="mt-4 text-sm text-slate-500">Loading...</p>
            <div className="mt-6 w-full max-w-md space-y-3 animate-skeleton-pulse">
              <div className="h-4 w-3/4 rounded bg-slate-200" />
              <div className="h-4 w-full rounded bg-slate-200" />
              <div className="h-4 w-5/6 rounded bg-slate-200" />
              <div className="h-20 w-full rounded bg-slate-200" />
              <div className="h-4 w-2/3 rounded bg-slate-200" />
            </div>
          </div>
        )}
        {error && (
          <div className="animate-content-in rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {mode === 'scraped' && !loading && !error && scrapedData && (
          <div className="animate-content-in space-y-4 text-sm">
            {scrapedData.job_data ? (
              <>
                <div>
                  <span className="font-semibold text-slate-600">Title:</span>
                  <p className="mt-0.5 text-slate-900">{scrapedData.job_data.title}</p>
                </div>
                {scrapedData.job_data.company && (
                  <div>
                    <span className="font-semibold text-slate-600">Company:</span>
                    <p className="mt-0.5 text-slate-900">{scrapedData.job_data.company}</p>
                  </div>
                )}
                {scrapedData.job_data.location && (
                  <div>
                    <span className="font-semibold text-slate-600">Location:</span>
                    <p className="mt-0.5 text-slate-900">{scrapedData.job_data.location}</p>
                  </div>
                )}
                {scrapedData.job_data.salary_range && (
                  <div>
                    <span className="font-semibold text-slate-600">Salary:</span>
                    <p className="mt-0.5 text-slate-900">{scrapedData.job_data.salary_range}</p>
                  </div>
                )}
                <div>
                  <span className="font-semibold text-slate-600">Description:</span>
                  <div className="mt-1 whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-3 text-slate-800">
                    {scrapedData.job_data.description}
                  </div>
                </div>
                {scrapedData.job_data.responsibilities?.length > 0 && (
                  <div>
                    <span className="font-semibold text-slate-600">Responsibilities:</span>
                    <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-800">
                      {scrapedData.job_data.responsibilities.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {scrapedData.job_data.requirements?.length > 0 && (
                  <div>
                    <span className="font-semibold text-slate-600">Requirements:</span>
                    <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-800">
                      {scrapedData.job_data.requirements.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {scrapedData.job_data.benefits?.length > 0 && (
                  <div>
                    <span className="font-semibold text-slate-600">Benefits:</span>
                    <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-800">
                      {scrapedData.job_data.benefits.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="pt-2 text-xs text-slate-500">
                  Method: {scrapedData.extraction_method || '—'} · Confidence:{' '}
                  {scrapedData.confidence_score != null
                    ? `${(scrapedData.confidence_score * 100).toFixed(0)}%`
                    : '—'}
                </div>
              </>
            ) : (
              <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
                {scrapedData.error_message || 'No extracted content available'}
              </div>
            )}
          </div>
        )}

        {mode === 'jobmatch' && !loading && !error && matchData && (
          <div className="animate-content-in space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <div
                className={`rounded-lg px-4 py-2 text-2xl font-bold ${scoreColor(matchData.overall_score)}`}
              >
                {matchData.overall_score}
              </div>
              <div>
                <span className="font-semibold text-slate-700">
                  {RECOMMENDATION_LABELS[matchData.recommendation] || matchData.recommendation}
                </span>
              </div>
            </div>
            <div>
              <span className="font-semibold text-slate-600">Summary</span>
              <p className="mt-1 text-slate-800">{matchData.summary}</p>
            </div>
            <div>
              <span className="font-semibold text-slate-600">Dimension scores</span>
              <ul className="mt-2 space-y-1">
                {Object.entries(matchData.dimension_scores || {}).map(([key, value]) => (
                  <li key={key} className="flex items-center gap-2">
                    <span className="w-44 text-slate-700">
                      {DIMENSION_LABELS[key] || key}:
                    </span>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${scoreColor(value)}`}>
                      {value}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {matchData.strengths?.length > 0 && (
              <div>
                <span className="font-semibold text-slate-600">Strengths</span>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-800">
                  {matchData.strengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {matchData.gaps?.length > 0 && (
              <div>
                <span className="font-semibold text-slate-600">Gaps</span>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-800">
                  {matchData.gaps.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
