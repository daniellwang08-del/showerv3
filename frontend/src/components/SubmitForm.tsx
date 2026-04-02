import type { FormEvent } from 'react';
import { Loader2, Send } from 'lucide-react';

type Props = {
  url: string;
  onUrlChange: (next: string) => void;
  loading: boolean;
  onSubmit: (e: FormEvent) => void;
  submitNotice: string;
  submitNoticeKind: 'success' | 'warning';
  submitError: string;
};

export function SubmitForm({
  url,
  onUrlChange,
  loading,
  onSubmit,
  submitNotice,
  submitNoticeKind,
  submitError,
}: Props) {
  return (
    <div className="glass-card min-w-0 rounded-2xl border border-blue-200/60 bg-gradient-to-br from-white/90 to-blue-50/50 p-5 shadow-sm">
      <form onSubmit={onSubmit} className="min-w-0">
        <div className="flex min-w-0 flex-col gap-0 sm:flex-row sm:items-stretch">
          <div className="relative min-w-0 flex-1">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-slate-400">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.828 10.172a4 4 0 010 5.656l-1.414 1.414a4 4 0 01-5.656 0 4 4 0 010-5.656l1.414-1.414"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.172 13.828a4 4 0 010-5.656l1.414-1.414a4 4 0 015.656 0 4 4 0 010 5.656l-1.414 1.414"
                />
              </svg>
            </div>
            <input
              type="url"
              id="url"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              className="blue-outline-input block min-h-11 min-w-0 w-full rounded-l-lg py-2.5 pl-12 pr-3 text-sm text-slate-900 placeholder:text-slate-500 outline-none sm:rounded-l-lg sm:rounded-r-none"
              placeholder="https://boards.greenhouse.io/..."
              required
              autoComplete="off"
              inputMode="url"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            aria-busy={loading}
            aria-label={loading ? 'Submitting job URL' : 'Submit job URL'}
            title={loading ? 'Submitting…' : 'Submit'}
            className="btn-blue-neon btn-submit-icon inline-flex h-11 w-full shrink-0 items-center justify-center rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-70 sm:w-11 sm:min-w-[2.75rem] sm:max-w-[2.75rem] sm:rounded-l-none sm:rounded-r-lg sm:rounded-t-none"
          >
            {loading ? (
              <Loader2 className="h-5 w-5 shrink-0 animate-spin" strokeWidth={2.25} aria-hidden />
            ) : (
              <Send className="h-5 w-5 shrink-0" strokeWidth={2.25} aria-hidden />
            )}
          </button>
        </div>

        {submitNotice && submitNoticeKind === 'warning' && (
          <div className="mt-3 text-sm font-medium text-amber-700">
            ⚠ {submitNotice}
          </div>
        )}

        {submitError && <div className="mt-3 text-sm font-medium text-red-700">✕ {submitError}</div>}
      </form>
    </div>
  );
}
