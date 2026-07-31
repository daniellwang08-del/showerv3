import { useEffect, useState, type KeyboardEvent } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';

interface PaginationProps {
  page: number;
  pages: number;
  total: number;
  perPage: number;
  onPageChange: (page: number) => void;
  onPerPageChange: (perPage: number) => void;
}

function clampPage(value: number, pages: number): number {
  if (!Number.isFinite(value) || pages < 1) return 1;
  return Math.min(Math.max(1, Math.trunc(value)), pages);
}

export function Pagination({
  page,
  pages,
  total,
  perPage,
  onPageChange,
  onPerPageChange,
}: PaginationProps) {
  const safePages = Math.max(pages, 1);
  const safePage = clampPage(page, safePages);
  const start = total === 0 ? 0 : (safePage - 1) * perPage + 1;
  const end = Math.min(safePage * perPage, total);
  const atStart = safePage <= 1;
  const atEnd = safePage >= safePages;

  const [draft, setDraft] = useState(String(safePage));

  useEffect(() => {
    setDraft(String(safePage));
  }, [safePage]);

  const commitDraft = () => {
    const parsed = Number.parseInt(draft.replace(/[^\d]/g, ''), 10);
    if (Number.isNaN(parsed)) {
      setDraft(String(safePage));
      return;
    }
    const next = clampPage(parsed, safePages);
    setDraft(String(next));
    if (next !== safePage) onPageChange(next);
  };

  const onDraftKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
      commitDraft();
    } else if (e.key === 'Escape') {
      setDraft(String(safePage));
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!atEnd) onPageChange(safePage + 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!atStart) onPageChange(safePage - 1);
    }
  };

  const navBtn =
    'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition ' +
    'hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 ' +
    'disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-slate-200 disabled:hover:bg-white disabled:hover:text-slate-600 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40';

  return (
    <div className="flex flex-col gap-3 border-t border-slate-200/80 bg-gradient-to-b from-slate-50/80 to-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-slate-600">
        <p className="tabular-nums">
          <span className="text-slate-500">Showing </span>
          <span className="font-semibold text-slate-800">{start.toLocaleString()}</span>
          <span className="text-slate-400">–</span>
          <span className="font-semibold text-slate-800">{end.toLocaleString()}</span>
          <span className="text-slate-500"> of </span>
          <span className="font-semibold text-slate-800">{total.toLocaleString()}</span>
        </p>
        <label className="inline-flex items-center gap-2 text-slate-500">
          <span className="sr-only sm:not-sr-only sm:inline">Rows</span>
          <select
            value={perPage}
            onChange={(e) => onPerPageChange(Number(e.target.value))}
            className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          >
            {[20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
        </label>
      </div>

      <nav
        className="flex flex-wrap items-center gap-1.5"
        aria-label="Pagination"
      >
        <button
          type="button"
          disabled={atStart}
          onClick={() => onPageChange(1)}
          className={navBtn}
          aria-label="First page"
          title="First page"
        >
          <ChevronsLeft size={15} strokeWidth={2.25} />
        </button>
        <button
          type="button"
          disabled={atStart}
          onClick={() => onPageChange(safePage - 1)}
          className={navBtn}
          aria-label="Previous page"
          title="Previous page"
        >
          <ChevronLeft size={15} strokeWidth={2.25} />
        </button>

        <div className="mx-1 inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-1 shadow-sm">
          <label htmlFor="pagination-page-input" className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Page
          </label>
          <input
            id="pagination-page-input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
            onBlur={commitDraft}
            onKeyDown={onDraftKeyDown}
            className="h-7 w-12 rounded-md border border-slate-200 bg-slate-50 text-center text-sm font-semibold tabular-nums text-slate-800 transition focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            aria-label={`Page number, ${safePage} of ${safePages}`}
          />
          <span className="text-sm tabular-nums text-slate-500">
            of <span className="font-semibold text-slate-700">{safePages.toLocaleString()}</span>
          </span>
        </div>

        <button
          type="button"
          disabled={atEnd}
          onClick={() => onPageChange(safePage + 1)}
          className={navBtn}
          aria-label="Next page"
          title="Next page"
        >
          <ChevronRight size={15} strokeWidth={2.25} />
        </button>
        <button
          type="button"
          disabled={atEnd}
          onClick={() => onPageChange(safePages)}
          className={navBtn}
          aria-label="Last page"
          title="Last page"
        >
          <ChevronsRight size={15} strokeWidth={2.25} />
        </button>
      </nav>
    </div>
  );
}
