import { useEffect, useState } from 'react';
import { CheckCircle2, FileText, Sparkles, Wand2 } from 'lucide-react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

/**
 * Stylised representation of the jobs board and the autofill side panel.
 * Illustrative only — it mirrors the real pipeline stages (extracted → scored →
 * tailored → ready) so the hero shows what the product actually produces.
 */

const TILES = [
  { label: 'Ready to apply', value: 12, accent: 'text-emerald-300' },
  { label: 'Matched today', value: 34, accent: 'text-sky-300' },
  { label: 'Applied', value: 9, accent: 'text-violet-300' },
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
];

const AUTOFILL_STATUS = [
  { label: 'Reading Workday form…', progress: 28, note: '4 of 28 fields' },
  { label: 'Answering screening…', progress: 54, note: '2 of 4 questions' },
  { label: 'Attaching résumé…', progress: 76, note: 'Tailored PDF' },
  { label: 'Ready for your review', progress: 100, note: 'You keep the click' },
];

function ScoreRing({ score }: { score: number }) {
  const circumference = 2 * Math.PI * 18;
  const dash = (score / 100) * circumference;

  return (
    <div className="relative h-12 w-12 shrink-0">
      <svg viewBox="0 0 44 44" className="h-full w-full -rotate-90">
        <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="3.5" />
        <circle
          cx="22"
          cy="22"
          r="18"
          fill="none"
          stroke="url(#mock-score)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          className="landing-score-arc"
        />
        <defs>
          <linearGradient id="mock-score" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#818cf8" />
          </linearGradient>
        </defs>
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[13px] font-black tabular-nums text-white">
        {score}
      </span>
    </div>
  );
}

export function ProductMock() {
  const reduced = usePrefersReducedMotion();
  const [activeRow, setActiveRow] = useState(1);
  const [fillStep, setFillStep] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const rows = window.setInterval(() => {
      setActiveRow((current) => (current + 1) % ROWS.length);
    }, 2800);
    const fill = window.setInterval(() => {
      setFillStep((current) => (current + 1) % AUTOFILL_STATUS.length);
    }, 2200);
    return () => {
      window.clearInterval(rows);
      window.clearInterval(fill);
    };
  }, [reduced]);

  const fill = AUTOFILL_STATUS[fillStep];

  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="landing-glow-pulse pointer-events-none absolute -inset-6 rounded-[40px] bg-gradient-to-br from-sky-500/30 via-indigo-500/20 to-fuchsia-500/25 opacity-80 blur-3xl"
      />

      <div className="landing-float relative overflow-hidden rounded-3xl border border-white/12 bg-[#080d1c]/90 shadow-[0_40px_120px_-40px_rgba(2,6,23,0.95)] ring-1 ring-inset ring-white/10 backdrop-blur-2xl">
        <span aria-hidden="true" className="landing-scanline pointer-events-none absolute inset-0" />
        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
          <span className="ml-3 text-[12px] font-bold tracking-tight text-white/50">
            Atomspace · Jobs
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-300/25 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-300">
            <span className="landing-pulse-dot h-1.5 w-1.5 rounded-full bg-emerald-300" />
            Live
          </span>
        </div>

        <div className="grid grid-cols-3 gap-3 px-5 pt-5">
          {TILES.map((tile) => (
            <div key={tile.label} className="rounded-2xl border border-white/10 bg-white/5 px-3.5 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/45">
                {tile.label}
              </p>
              <p className={`mt-1 text-2xl font-black tabular-nums ${tile.accent}`}>{tile.value}</p>
            </div>
          ))}
        </div>

        <div className="space-y-2.5 p-5">
          {ROWS.map((row, index) => (
            <div
              key={row.title}
              className={`flex items-center gap-4 rounded-2xl border px-4 py-3.5 transition duration-500 ${
                activeRow === index
                  ? 'border-sky-300/40 bg-sky-400/[0.1] shadow-[0_0_24px_-8px_rgba(56,189,248,0.55)]'
                  : 'border-white/10 bg-white/[0.04] hover:border-sky-300/30 hover:bg-sky-400/[0.06]'
              }`}
            >
              <ScoreRing score={row.score} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-white">{row.title}</p>
                <p className="mt-0.5 truncate text-xs font-semibold text-white/45">
                  {row.company} · {row.mode}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {row.stages.map((stage) => (
                    <span
                      key={stage}
                      className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-white/60"
                    >
                      <FileText size={9} strokeWidth={3} />
                      {stage}
                    </span>
                  ))}
                </div>
              </div>
              {row.ready ? (
                <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-3 py-1.5 text-[11px] font-bold text-emerald-300 sm:inline-flex">
                  <CheckCircle2 size={13} strokeWidth={2.75} />
                  Ready
                </span>
              ) : (
                <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-sky-300/25 bg-sky-400/10 px-3 py-1.5 text-[11px] font-bold text-sky-300 sm:inline-flex">
                  <Sparkles size={13} strokeWidth={2.75} className="landing-spin-slow" />
                  Working
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="landing-float-slow absolute -bottom-8 -left-4 hidden w-64 rounded-2xl border border-white/12 bg-[#0a1122]/95 p-4 shadow-[0_30px_80px_-30px_rgba(2,6,23,0.95)] backdrop-blur-xl lg:block">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-lg shadow-indigo-900/50">
            <Wand2 size={15} strokeWidth={2.5} />
          </span>
          <div>
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
    </div>
  );
}
