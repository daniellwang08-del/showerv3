import { useEffect, useState } from 'react';
import { X, Target } from 'lucide-react';
import { apiClient } from '../api/client';

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
  validJobId: string | null;
  onClose: () => void;
  onMatchStored?: () => void;
};

export function JobMatchModal({ validJobId, onClose, onMatchStored }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<JobMatchResponse | null>(null);

  useEffect(() => {
    if (!validJobId) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    apiClient
      .get<JobMatchResponse>(`/jobs/valid/${validJobId}/match`)
      .then((res) => {
        if (!cancelled) {
          setData(res.data);
          onMatchStored?.();
        }
      })
      .catch((e: any) => {
        if (!cancelled) setError(e.response?.data?.detail || 'Failed to load job match');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [validJobId]);

  if (!validJobId) return null;

  const scoreColor = (score: number) => {
    if (score >= 80) return 'text-emerald-700 bg-emerald-100';
    if (score >= 65) return 'text-green-700 bg-green-100';
    if (score >= 50) return 'text-amber-700 bg-amber-100';
    if (score >= 35) return 'text-orange-700 bg-orange-100';
    return 'text-red-700 bg-red-100';
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-2 text-base font-bold text-slate-900">
            <Target className="h-5 w-5 text-blue-600" />
            <span>Job match analysis</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && !data && (
            <div className="py-8 text-center text-slate-500">Loading...</div>
          )}
          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {!loading && !error && data && (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <div
                  className={`rounded-lg px-4 py-2 text-2xl font-bold ${scoreColor(data.overall_score)}`}
                >
                  {data.overall_score}
                </div>
                <div>
                  <span className="font-semibold text-slate-700">
                    {RECOMMENDATION_LABELS[data.recommendation] || data.recommendation}
                  </span>
                </div>
              </div>
              <div>
                <span className="font-semibold text-slate-600">Summary</span>
                <p className="mt-1 text-slate-800">{data.summary}</p>
              </div>
              <div>
                <span className="font-semibold text-slate-600">Dimension scores</span>
                <ul className="mt-2 space-y-1">
                  {Object.entries(data.dimension_scores || {}).map(([key, value]) => (
                    <li key={key} className="flex items-center gap-2">
                      <span className="w-48 text-slate-700">
                        {DIMENSION_LABELS[key] || key}:
                      </span>
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${scoreColor(value)}`}>
                        {value}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {data.strengths?.length > 0 && (
                <div>
                  <span className="font-semibold text-slate-600">Strengths</span>
                  <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-800">
                    {data.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {data.gaps?.length > 0 && (
                <div>
                  <span className="font-semibold text-slate-600">Gaps</span>
                  <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-800">
                    {data.gaps.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
