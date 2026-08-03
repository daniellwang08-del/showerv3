import { useEffect, useRef, useState } from 'react';
import {
  LayoutGrid,
  CalendarClock,
  UserRound,
  Sparkles,
  ChevronDown,
  Check,
  ClipboardCheck,
  CirclePlay,
  Rocket,
  Table2,
  MessageSquare,
  FileSearch,
  FileCheck2,
  CircleAlert,
  Upload,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DashboardView, DashboardCounts } from '../../api/scraperApi';
import type { AdminScraperStats } from '../../types/scraper';

interface ViewMeta {
  id: DashboardView;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Tailwind classes for the icon chip (active state). */
  accent: string;
  /** Tailwind ring/text color used on the active trigger + selected row. */
  active: string;
}

/** Primary tabs shown in the dropdown (applicant). */
export const DASHBOARD_VIEWS: ViewMeta[] = [
  {
    id: 'today',
    label: "Today's new jobs",
    description: 'Jobs added to the system today',
    icon: CalendarClock,
    accent: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    active: 'text-emerald-700 dark:text-emerald-300',
  },
  {
    id: 'mine',
    label: 'Jobs from me',
    description: 'Everything you added by URL or attachment',
    icon: UserRound,
    accent: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
    active: 'text-violet-700 dark:text-violet-300',
  },
  {
    id: 'all',
    label: 'All jobs in system',
    description: 'Scraped, shared, and your own jobs',
    icon: LayoutGrid,
    accent: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300',
    active: 'text-blue-700 dark:text-blue-300',
  },
  {
    id: 'suggested',
    label: 'Suggested jobs',
    description: 'Analysed matches at or above your minimum score',
    icon: Sparkles,
    accent: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    active: 'text-amber-700 dark:text-amber-300',
  },
];

/** Primary tabs for admin ops. */
export const ADMIN_DASHBOARD_VIEWS: ViewMeta[] = [
  {
    id: 'today',
    label: "Today's fetched",
    description: 'Jobs added to the platform today',
    icon: CalendarClock,
    accent: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    active: 'text-emerald-700 dark:text-emerald-300',
  },
  {
    id: 'all',
    label: 'All jobs',
    description: 'Full non-blocked job pool',
    icon: LayoutGrid,
    accent: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300',
    active: 'text-blue-700 dark:text-blue-300',
  },
  {
    id: 'needs_extraction',
    label: 'Needs extraction',
    description: 'Missing or in-progress JD extraction',
    icon: FileSearch,
    accent: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    active: 'text-amber-700 dark:text-amber-300',
  },
  {
    id: 'extracted',
    label: 'Extracted',
    description: 'Jobs with a completed job description',
    icon: FileCheck2,
    accent: 'bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300',
    active: 'text-teal-700 dark:text-teal-300',
  },
  {
    id: 'extraction_failed',
    label: 'Extraction failed',
    description: 'Jobs whose extraction failed',
    icon: CircleAlert,
    accent: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
    active: 'text-rose-700 dark:text-rose-300',
  },
  {
    id: 'manual',
    label: 'Manual submissions',
    description: 'Jobs added by URL or attachment',
    icon: Upload,
    accent: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300',
    active: 'text-indigo-700 dark:text-indigo-300',
  },
  {
    id: 'sheet_posted',
    label: 'In Google Sheets',
    description: 'Jobs posted to Google Sheets',
    icon: Table2,
    accent: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    active: 'text-emerald-700 dark:text-emerald-300',
  },
  {
    id: 'pumble_posted',
    label: 'In Pumble',
    description: 'Jobs posted to Pumble',
    icon: MessageSquare,
    accent: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
    active: 'text-violet-700 dark:text-violet-300',
  },
];

/** Board-driven views — shown in the trigger when active, not always in the dropdown. */
const BOARD_VIEWS: ViewMeta[] = [
  {
    id: 'applied',
    label: 'Applied jobs',
    description: 'Jobs you marked as applied',
    icon: ClipboardCheck,
    accent: 'bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    active: 'text-sky-700 dark:text-sky-300',
  },
  {
    id: 'applied_today',
    label: 'Applied today',
    description: 'Jobs marked applied today',
    icon: ClipboardCheck,
    accent: 'bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    active: 'text-sky-700 dark:text-sky-300',
  },
  {
    id: 'available',
    label: 'Available to start',
    description: 'Jobs not marked applied yet',
    icon: CirclePlay,
    accent: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
    active: 'text-violet-700 dark:text-violet-300',
  },
  {
    id: 'ready',
    label: 'Ready to apply',
    description: 'Jobs with a tailored resume ready',
    icon: Rocket,
    accent: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    active: 'text-emerald-700 dark:text-emerald-300',
  },
  {
    id: 'sheet_posted',
    label: 'In Google Sheets',
    description: 'Jobs posted to Google Sheets',
    icon: Table2,
    accent: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    active: 'text-emerald-700 dark:text-emerald-300',
  },
  {
    id: 'pumble_posted',
    label: 'In Pumble',
    description: 'Jobs posted to Pumble',
    icon: MessageSquare,
    accent: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
    active: 'text-violet-700 dark:text-violet-300',
  },
  {
    id: 'needs_extraction',
    label: 'Needs extraction',
    description: 'Missing or in-progress JD extraction',
    icon: FileSearch,
    accent: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    active: 'text-amber-700 dark:text-amber-300',
  },
  {
    id: 'extracted',
    label: 'Extracted',
    description: 'Jobs with a completed job description',
    icon: FileCheck2,
    accent: 'bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300',
    active: 'text-teal-700 dark:text-teal-300',
  },
  {
    id: 'extraction_failed',
    label: 'Extraction failed',
    description: 'Jobs whose extraction failed',
    icon: CircleAlert,
    accent: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
    active: 'text-rose-700 dark:text-rose-300',
  },
  {
    id: 'manual',
    label: 'Manual submissions',
    description: 'Jobs added by URL or attachment',
    icon: Upload,
    accent: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300',
    active: 'text-indigo-700 dark:text-indigo-300',
  },
];

const VIEW_BY_ID: Record<string, ViewMeta> = [
  ...DASHBOARD_VIEWS,
  ...ADMIN_DASHBOARD_VIEWS,
  ...BOARD_VIEWS,
].reduce(
  (acc, v) => ({ ...acc, [v.id]: v }),
  {} as Record<string, ViewMeta>,
);

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function adminViewCount(view: DashboardView, adminStats: AdminScraperStats | null, counts: DashboardCounts): number {
  if (!adminStats) {
    if (view === 'all') return counts.all ?? 0;
    if (view === 'today') return counts.today ?? 0;
    return 0;
  }
  switch (view) {
    case 'all':
      return adminStats.total_jobs;
    case 'today':
      return adminStats.today_fetched ?? adminStats.today_scraped;
    case 'needs_extraction':
      return adminStats.needs_extraction_jobs;
    case 'extracted':
      return adminStats.extracted_jobs;
    case 'extraction_failed':
      return adminStats.extraction_failed_jobs;
    case 'manual':
      return adminStats.manual_jobs;
    case 'sheet_posted':
      return adminStats.sheet_posted_jobs;
    case 'pumble_posted':
      return adminStats.pumble_posted_jobs;
    case 'applied_today':
      return adminStats.team_applied_today;
    default:
      return 0;
  }
}

interface DashboardViewSwitcherProps {
  view: DashboardView;
  counts: DashboardCounts;
  onChange: (view: DashboardView) => void;
  /** Optional override for the badge when viewing a board-driven filter. */
  activeCount?: number;
  isAdmin?: boolean;
  adminStats?: AdminScraperStats | null;
}

export function DashboardViewSwitcher({
  view,
  counts,
  onChange,
  activeCount,
  isAdmin = false,
  adminStats = null,
}: DashboardViewSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuViews = isAdmin ? ADMIN_DASHBOARD_VIEWS : DASHBOARD_VIEWS;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const current = VIEW_BY_ID[view] ?? VIEW_BY_ID.all;
  const CurrentIcon = current.icon;
  const tabCountKeys: Array<keyof DashboardCounts> = ['all', 'today', 'mine', 'suggested', 'applied_today'];
  const countFromTabs = tabCountKeys.includes(view as keyof DashboardCounts)
    ? counts[view as keyof DashboardCounts]
    : undefined;
  const currentCount =
    typeof activeCount === 'number'
      ? activeCount
      : isAdmin
        ? adminViewCount(view, adminStats, counts)
        : typeof countFromTabs === 'number'
          ? countFromTabs
          : 0;

  const handleSelect = (next: DashboardView) => {
    setOpen(false);
    onChange(next);
  };

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={[
          'group inline-flex items-center gap-2.5 rounded-xl border bg-white py-2 pl-2.5 pr-3 text-sm font-semibold shadow-sm transition-all dark:border-slate-700 dark:bg-[#141d31]',
          open
            ? 'border-slate-300 ring-2 ring-slate-900/5 dark:border-slate-500'
            : 'border-slate-200 hover:border-slate-300 hover:shadow dark:hover:border-slate-500',
        ].join(' ')}
      >
        <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${current.accent}`}>
          <CurrentIcon size={16} />
        </span>
        <span className="flex flex-col items-start leading-tight">
          <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
            Viewing
          </span>
          <span className={current.active}>{current.label}</span>
        </span>
        <span className="ml-1 inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-bold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">
          {formatCount(currentCount)}
        </span>
        <ChevronDown
          size={16}
          className={`text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <>
          <div
            role="listbox"
            className="absolute left-0 top-full z-20 mt-2 w-[19rem] origin-top-left overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl ring-1 ring-black/5 dark:border-slate-700 dark:bg-[#141d31] dark:ring-white/5"
          >
            {menuViews.map((v) => {
              const Icon = v.icon;
              const isActive = v.id === view;
              const count = isAdmin
                ? adminViewCount(v.id, adminStats, counts)
                : counts[v.id as keyof DashboardCounts] ?? 0;
              return (
                <button
                  key={v.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => handleSelect(v.id)}
                  className={[
                    'flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors',
                    isActive
                      ? 'bg-slate-100 dark:bg-slate-800'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/70',
                  ].join(' ')}
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${v.accent}`}
                  >
                    <Icon size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span
                        className={`truncate text-sm font-semibold ${
                          isActive ? v.active : 'text-slate-800'
                        }`}
                      >
                        {v.label}
                      </span>
                      {isActive && <Check size={14} className="shrink-0 text-slate-500" />}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      {v.description}
                    </span>
                  </span>
                  <span
                    className={[
                      'inline-flex min-w-[1.75rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums',
                      isActive
                        ? 'bg-white text-slate-800 shadow-sm ring-1 ring-slate-300 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-600'
                        : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
                    ].join(' ')}
                  >
                    {formatCount(count)}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
