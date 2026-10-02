import { useEffect, useState } from 'react';
import {
  Briefcase,
  CheckCircle2,
  FileText,
  LayoutTemplate,
  Puzzle,
  Search,
  Sparkles,
  UserCircle,
  UserCog,
  Wand2,
} from 'lucide-react';
import { TOASTS } from './landingMedia';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

/**
 * Compact product window for the hero (about half the first viewport).
 * Sidebar + jobs board stay in chrome; pipeline/autofill float as overlays.
 */

const TILES = [
  { label: 'Ready to apply', value: 12, accent: 'text-emerald-300', glow: 'from-emerald-400/25' },
  { label: 'Matched today', value: 34, accent: 'text-sky-300', glow: 'from-sky-400/25' },
  { label: 'Applied', value: 9, accent: 'text-violet-300', glow: 'from-violet-400/25' },
];

const ROWS = [
  {
    title: 'Senior Backend Engineer',
    company: 'Northwind Labs',
    mode: 'Remote · US',
    score: 94,
    stages: ['Résumé built', 'Cover letter'],
    ready: true,
  },
  {
    title: 'Platform Engineer, Data',
    company: 'Vertex Systems',
    mode: 'Hybrid · Berlin',
    score: 88,
    stages: ['Tailoring'],
    ready: false,
  },
  {
    title: 'Staff Software Engineer',
    company: 'Lumen Health',
    mode: 'Remote · EU',
    score: 81,
    stages: ['Scored'],
    ready: false,
  },
  {
    title: 'Product Engineer',
    company: 'Harbor Cloud',
    mode: 'Remote · UK',
    score: 77,
    stages: ['Extracted'],
    ready: false,
  },
  {
    title: 'ML Platform Engineer',
    company: 'Atlas Robotics',
    mode: 'Hybrid · SF',
    score: 72,
    stages: ['Queued'],
    ready: false,
  },
];

const AUTOFILL_STATUS = [
  { label: 'Reading Workday form…', progress: 28, note: '4 of 28 fields' },
  { label: 'Answering screening…', progress: 54, note: '2 of 4 questions' },
  { label: 'Attaching résumé…', progress: 76, note: 'Tailored PDF' },
  { label: 'Ready for your review', progress: 100, note: 'You keep the click' },
];

const SIDE_NAV = [
  { label: 'Jobs', icon: Briefcase, active: true },
  { label: 'Profile', icon: UserCircle, active: false },
  { label: 'Preferences', icon: UserCog, active: false },
  { label: 'Resume', icon: LayoutTemplate, active: false },
  { label: 'Integrations', icon: Puzzle, active: false },
];

const VIEWS = ['Today', 'Ready', 'Working'] as const;

function ScoreRing({ score, id }: { score: number; id: string }) {
  const circumference = 2 * Math.PI * 16;
  const dash = (score / 100) * circumference;
  const gradId = `mock-score-${id}`;

  return (
    <div className="relative h-11 w-11 shrink-0">
      <svg viewBox="0 0 40 40" className="h-full w-full -rotate-90">
        <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="3.25" />
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth="3.25"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          className="landing-score-arc"
        />
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#818cf8" />
          </linearGradient>
        </defs>
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[12px] font-black tabular-nums text-white">
        {score}
      </span>
    </div>
  );
}

function AutofillCard({
  fill,
}: {
  fill: (typeof AUTOFILL_STATUS)[number];
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-lg shadow-indigo-900/50">
          <Wand2 size={14} strokeWidth={2.5} />
        </span>
        <div className="min-w-0">
          <p className="text-[12px] font-black text-white">Autofill · Workday</p>
          <p className="text-[10px] font-semibold text-white/45">{fill.note}</p>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
        <span
          className="block h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-500 transition-[width] duration-700"
          style={{ width: `${fill.progress}%` }}
        />
      </div>
      <p className="mt-2 text-[10px] font-semibold text-emerald-300">{fill.label}</p>
    </div>
  );
}

export function ProductMock() {
  const reduced = usePrefersReducedMotion();
  const [activeRow, setActiveRow] = useState(0);
  const [fillStep, setFillStep] = useState(0);
  const [view, setView] = useState<(typeof VIEWS)[number]>('Today');
  const [toastIndex, setToastIndex] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const rows = window.setInterval(() => {
      setActiveRow((current) => (current + 1) % ROWS.length);
    }, 2800);
    const fill = window.setInterval(() => {
      setFillStep((current) => (current + 1) % AUTOFILL_STATUS.length);
    }, 2200);
    const toasts = window.setInterval(() => {
      setToastIndex((current) => (current + 1) % TOASTS.length);
    }, 3200);
    return () => {
      window.clearInterval(rows);
      window.clearInterval(fill);
      window.clearInterval(toasts);
    };
  }, [reduced]);

  const fill = AUTOFILL_STATUS[fillStep];
  const visibleRows =
    view === 'Ready' ? ROWS.filter((row) => row.ready) : view === 'Working' ? ROWS.filter((row) => !row.ready) : ROWS;
  const highlight = visibleRows.length ? activeRow % visibleRows.length : 0;

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <span
        aria-hidden="true"
        className="landing-glow-pulse pointer-events-none absolute -inset-8 rounded-[40px] bg-gradient-to-br from-sky-500/35 via-blue-500/25 to-indigo-500/30 opacity-90 blur-3xl"
      />

      <div className="landing-dash relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-white/12 bg-[#080d1c]/92 shadow-[0_40px_120px_-40px_rgba(2,6,23,0.95)] ring-1 ring-inset ring-white/10 backdrop-blur-2xl sm:rounded-[28px]">
        <span aria-hidden="true" className="landing-scanline pointer-events-none absolute inset-0" />

        <div className="relative z-10 flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-2.5 sm:px-5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
          <span className="ml-2 truncate text-[12px] font-bold tracking-tight text-white/50 sm:ml-3">
            NAO · Jobs
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-300/25 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-300">
            <span className="landing-pulse-dot h-1.5 w-1.5 rounded-full bg-emerald-300" />
            Live
          </span>
        </div>

        <div className="relative z-10 grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[4.25rem_minmax(0,1fr)] xl:grid-cols-[9.5rem_minmax(0,1fr)]">
          <aside className="hidden flex-col border-r border-white/8 bg-white/[0.02] px-2 py-3 lg:flex xl:px-3 xl:py-4">
            <div className="mb-3 flex items-center justify-center gap-2 px-1 xl:justify-start xl:px-2">
              <img src="/nao-logo.png" alt="" className="h-6 w-auto object-contain" />
              <span className="hidden text-[12px] font-bold tracking-tight text-white xl:inline">
                NAO
              </span>
            </div>
            <p className="hidden px-2 text-[10px] font-black uppercase tracking-[0.18em] text-white/30 xl:block">
              Workspace
            </p>
            <nav className="mt-2 space-y-1 xl:mt-3" aria-hidden="true">
              {SIDE_NAV.map((item) => {
                const Icon = item.icon;
                return (
                  <span
                    key={item.label}
                    title={item.label}
                    className={`flex items-center justify-center gap-2.5 rounded-xl px-2 py-2 text-[12px] font-bold xl:justify-start xl:px-2.5 ${
                      item.active
                        ? 'bg-sky-400/15 text-white shadow-[inset_0_0_0_1px_rgba(125,211,252,0.25)]'
                        : 'text-white/40'
                    }`}
                  >
                    <Icon size={14} strokeWidth={2.4} />
                    <span className="hidden xl:inline">{item.label}</span>
                  </span>
                );
              })}
            </nav>
            <div className="mt-auto hidden rounded-xl border border-white/8 bg-white/[0.04] px-2.5 py-2.5 xl:block">
              <p className="text-[11px] font-black text-white">Alex Rivera</p>
              <p className="text-[10px] font-semibold text-white/40">Profile synced</p>
            </div>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="grid shrink-0 grid-cols-3 gap-2 px-3 pt-3 sm:gap-3 sm:px-4 sm:pt-4">
              {TILES.map((tile) => (
                <div
                  key={tile.label}
                  className="relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.05] px-2.5 py-2.5 sm:rounded-2xl sm:px-3.5 sm:py-3"
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute -right-6 -top-8 h-16 w-16 rounded-full bg-gradient-to-br ${tile.glow} to-transparent blur-xl`}
                  />
                  <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-white/45 sm:text-[10px]">
                    {tile.label}
                  </p>
                  <p className={`mt-0.5 text-xl font-black tabular-nums sm:text-2xl ${tile.accent}`}>
                    {tile.value}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-3 flex shrink-0 items-center gap-2 px-3 sm:px-4">
              <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1">
                {VIEWS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setView(item)}
                    aria-pressed={view === item}
                    className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] transition ${
                      view === item
                        ? 'bg-white/12 text-white'
                        : 'text-white/40 hover:text-white/70'
                    }`}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <div className="ml-auto hidden items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-white/35 sm:inline-flex">
                <Search size={12} strokeWidth={2.5} />
                <span className="text-[11px] font-semibold">Search roles</span>
              </div>
            </div>

            <div className="relative mt-2 min-h-0 flex-1 space-y-2 overflow-hidden px-3 pb-3 sm:px-4 sm:pb-4">
              {visibleRows.map((row, index) => (
                <div
                  key={row.title}
                  className={`flex items-center gap-3 rounded-2xl border px-3 py-2.5 transition duration-500 sm:gap-4 sm:px-4 sm:py-3 ${
                    highlight === index
                      ? 'landing-dash-row border-sky-300/40 bg-sky-400/[0.1] shadow-[0_0_24px_-8px_rgba(56,189,248,0.55)]'
                      : 'border-white/10 bg-white/[0.04]'
                  }`}
                >
                  <ScoreRing score={row.score} id={row.company.replace(/\s+/g, '-')} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-bold text-white sm:text-sm">{row.title}</p>
                    <p className="mt-0.5 truncate text-[11px] font-semibold text-white/45">
                      {row.company} · {row.mode}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {row.stages.map((stage) => (
                        <span
                          key={stage}
                          className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-white/60 sm:text-[10px]"
                        >
                          <FileText size={9} strokeWidth={3} />
                          {stage}
                        </span>
                      ))}
                    </div>
                  </div>
                  {row.ready ? (
                    <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-2.5 py-1.5 text-[11px] font-bold text-emerald-300 sm:inline-flex">
                      <CheckCircle2 size={13} strokeWidth={2.75} />
                      Ready
                    </span>
                  ) : (
                    <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-sky-300/25 bg-sky-400/10 px-2.5 py-1.5 text-[11px] font-bold text-sky-300 sm:inline-flex">
                      <Sparkles size={13} strokeWidth={2.75} className="landing-spin-slow" />
                      Working
                    </span>
                  )}
                </div>
              ))}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-3 bottom-0 h-12 bg-gradient-to-t from-[#080d1c] to-transparent sm:inset-x-4"
              />
            </div>
          </div>

        </div>

        <div className="pointer-events-none absolute bottom-3 right-3 z-20 w-[min(100%-1.5rem,15rem)] sm:bottom-4 sm:right-4">
          <div className="pointer-events-auto shadow-[0_18px_40px_-20px_rgba(2,6,23,0.9)]">
            <AutofillCard fill={fill} />
          </div>
        </div>

        <div className="pointer-events-none absolute left-3 top-[4.25rem] z-20 hidden w-44 sm:block lg:left-auto lg:right-3 lg:top-14">
          <div className="pointer-events-none space-y-1.5 rounded-xl border border-white/10 bg-[#080d1c]/88 p-2 backdrop-blur-md">
            <p className="mb-1 flex items-center gap-1.5 px-1 text-[9px] font-black uppercase tracking-[0.14em] text-emerald-300">
              <span className="landing-pulse-dot h-1.5 w-1.5 rounded-full bg-emerald-300" />
              Live pipeline
            </p>
            {TOASTS.slice(0, 2).map((toast, index) => (
              <div
                key={toast.title}
                className={`rounded-lg border px-2 py-1.5 transition duration-500 ${
                  toastIndex === index
                    ? 'border-emerald-300/30 bg-emerald-400/10'
                    : 'border-white/8 bg-white/[0.03] opacity-55'
                }`}
              >
                <p className="truncate text-[11px] font-black text-white">{toast.title}</p>
                <p className="truncate text-[9px] font-semibold text-white/50">{toast.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
