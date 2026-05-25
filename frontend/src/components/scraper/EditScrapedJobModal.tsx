import { useEffect, useState } from 'react';
import { X, Loader2, ExternalLink } from 'lucide-react';
import type { ScrapedJob } from '../../types/scraper';

interface Props {
  job: ScrapedJob;
  onClose: () => void;
  onSave: (payload: { url: string; origin_url: string | null }) => Promise<{ ok: boolean; message: string }>;
}

function isLikelyValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function EditScrapedJobModal({ job, onClose, onSave }: Props) {
  const [url, setUrl] = useState(job.url);
  const [originUrl, setOriginUrl] = useState(job.origin_url ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(job.url);
    setOriginUrl(job.origin_url ?? '');
    setError(null);
  }, [job.id, job.url, job.origin_url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submitting, onClose]);

  const handleSave = async () => {
    const trimmedUrl = url.trim();
    const trimmedOrigin = originUrl.trim();
    if (!trimmedUrl) {
      setError('URL is required.');
      return;
    }
    if (!isLikelyValidUrl(trimmedUrl)) {
      setError('URL must be a valid http(s) URL.');
      return;
    }
    if (trimmedOrigin && !isLikelyValidUrl(trimmedOrigin)) {
      setError('Origin URL must be a valid http(s) URL.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await onSave({
      url: trimmedUrl,
      origin_url: trimmedOrigin ? trimmedOrigin : null,
    });
    setSubmitting(false);
    if (!res.ok) setError(res.message);
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="relative w-full max-w-xl rounded-2xl border border-slate-200/80 bg-white shadow-2xl ring-1 ring-slate-200/60">
        <button
          type="button"
          onClick={() => !submitting && onClose()}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="border-b border-slate-100 px-5 pb-4 pt-5 pr-12">
          <h2 className="text-lg font-semibold text-slate-900">Edit scraped job URL</h2>
          <p className="mt-1 text-xs text-slate-500 truncate" title={job.title}>
            {job.title}
            {job.company_name ? <> — {job.company_name}</> : null}
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              URL <span className="text-red-500">*</span>
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              This is the URL displayed in the table and used as a fallback for extraction.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Origin URL <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <input
              type="url"
              value={originUrl}
              onChange={(e) => setOriginUrl(e.target.value)}
              placeholder="https://jobs.lever.co/... (real ATS URL behind an aggregator)"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              If set, the extraction engine prefers this over the aggregator URL.
            </p>
          </div>

          {job.promoted_extraction_id && (
            <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 text-[11px] text-blue-700">
              <ExternalLink className="inline mr-1 h-3 w-3" />
              This job is already promoted to the extraction pipeline. URL changes will be
              propagated to the linked extraction and valid-job rows. Click <strong>Rerun</strong>
              after saving to refresh the full description.
            </div>
          )}

          {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-slate-100 px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={handleSave}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
