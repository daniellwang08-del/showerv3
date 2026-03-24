import type { FormEvent } from 'react';

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
    <div className="min-w-0 rounded-lg border border-blue-200/50 bg-gradient-to-br from-white to-blue-50/30 p-5 shadow-sm">
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
              className="block min-w-0 w-full border border-blue-300 bg-white py-2.5 pl-12 pr-3 text-sm text-slate-900 placeholder:text-slate-500 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-200 rounded-l-lg sm:rounded-l-lg sm:rounded-r-none"
              placeholder="https://boards.greenhouse.io/..."
              required
              autoComplete="off"
              inputMode="url"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="group relative inline-flex w-full sm:w-[8.5rem] sm:min-w-[8.5rem] sm:max-w-[8.5rem] shrink-0 items-center justify-center gap-2 bg-gradient-to-r from-blue-500 to-purple-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md transition hover:from-blue-600 hover:to-purple-600 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-70 rounded-r-lg sm:rounded-r-lg sm:rounded-l-none"
          >
            {loading ? (
              <svg className="h-4 w-4 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle className="opacity-30" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            ) : null}
            <span>{loading ? 'Submitting…' : 'Submit'}</span>
          </button>
        </div>

        {submitNotice && (
          <div className={`mt-3 text-sm font-medium ${
            submitNoticeKind === 'warning' ? 'text-amber-700' : 'text-emerald-700'
          }`}>
            {submitNoticeKind === 'warning' && '⚠ '}{submitNotice}
          </div>
        )}

        {submitError && <div className="mt-3 text-sm font-medium text-red-700">✕ {submitError}</div>}
      </form>
    </div>
  );
}
