import { useEffect, useState } from 'react';
import { X, FileText } from 'lucide-react';
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
};

type ExtractionResponse = {
  job_id: string;
  status: string;
  source_url: string;
  extraction_method: string | null;
  job_data: JobData | null;
  error_message: string | null;
  confidence_score: number | null;
};

type Props = {
  extractionId: string | null;
  onClose: () => void;
};

export function ScrapedContentModal({ extractionId, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ExtractionResponse | null>(null);

  useEffect(() => {
    if (!extractionId) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    apiClient
      .get<ExtractionResponse>(`/extract/${extractionId}`)
      .then((res) => {
        if (!cancelled) {
          setData(res.data);
        }
      })
      .catch((e: any) => {
        if (!cancelled) {
          setError(e.response?.data?.detail || 'Failed to load scraped content');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [extractionId]);

  if (!extractionId) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-2 text-base font-bold text-slate-900">
            <FileText className="h-5 w-5 text-emerald-600" />
            <span>Scraped content</span>
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
          {loading && (
            <div className="py-8 text-center text-slate-500">Loading...</div>
          )}
          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {!loading && !error && data && (
            <div className="space-y-4 text-sm">
              {data.job_data ? (
                <>
                  <div>
                    <span className="font-semibold text-slate-600">Title:</span>
                    <p className="mt-0.5 text-slate-900">{data.job_data.title}</p>
                  </div>
                  {data.job_data.company && (
                    <div>
                      <span className="font-semibold text-slate-600">Company:</span>
                      <p className="mt-0.5 text-slate-900">{data.job_data.company}</p>
                    </div>
                  )}
                  {data.job_data.location && (
                    <div>
                      <span className="font-semibold text-slate-600">Location:</span>
                      <p className="mt-0.5 text-slate-900">{data.job_data.location}</p>
                    </div>
                  )}
                  {data.job_data.salary_range && (
                    <div>
                      <span className="font-semibold text-slate-600">Salary:</span>
                      <p className="mt-0.5 text-slate-900">{data.job_data.salary_range}</p>
                    </div>
                  )}
                  <div>
                    <span className="font-semibold text-slate-600">Description:</span>
                    <div className="mt-1 whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-3 text-slate-800">
                      {data.job_data.description}
                    </div>
                  </div>
                  {data.job_data.responsibilities?.length > 0 && (
                    <div>
                      <span className="font-semibold text-slate-600">Responsibilities:</span>
                      <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-800">
                        {data.job_data.responsibilities.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {data.job_data.requirements?.length > 0 && (
                    <div>
                      <span className="font-semibold text-slate-600">Requirements:</span>
                      <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-800">
                        {data.job_data.requirements.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {data.job_data.benefits?.length > 0 && (
                    <div>
                      <span className="font-semibold text-slate-600">Benefits:</span>
                      <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-800">
                        {data.job_data.benefits.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="pt-2 text-xs text-slate-500">
                    Method: {data.extraction_method || '—'} · Confidence:{' '}
                    {data.confidence_score != null
                      ? `${(data.confidence_score * 100).toFixed(0)}%`
                      : '—'}
                  </div>
                </>
              ) : (
                <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
                  {data.error_message || 'No extracted content available'}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
