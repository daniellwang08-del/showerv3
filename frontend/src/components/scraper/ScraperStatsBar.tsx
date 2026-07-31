import { memo, useEffect, useRef, useState } from 'react';
import {
  Rocket,
  Sparkles,
  Wifi,
  CirclePlay,
  CalendarDays,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScraperStats } from '../../types/scraper';

function safe(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function fmt(n: number): string {
  return safe(Math.round(n)).toLocaleString();
}

function useAnimatedNumber(target: number, duration = 780): number {
  const safeTarget = safe(target);
  const [value, setValue] = useState(0);
  const valueRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    const from = valueRef.current;
    if (from === safeTarget) return;

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - (1 - t) ** 3;
      const next = safe(Math.round(from + (safeTarget - from) * eased));
      valueRef.current = next;
      setValue(next);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [safeTarget, duration]);

  return value;
}

function useBumpOnIncrease(value: number): boolean {
  const prevRef = useRef(value);
  const [bumped, setBumped] = useState(false);

  useEffect(() => {
    if (value > prevRef.current) {
      setBumped(true);
      const timer = window.setTimeout(() => setBumped(false), 700);
      prevRef.current = value;
      return () => window.clearTimeout(timer);
    }
    prevRef.current = value;
  }, [value]);

  return bumped;
}

function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const displayed = useAnimatedNumber(value);
  const bumped = useBumpOnIncrease(value);
  return (
    <span className={`${className ?? ''} ${bumped ? 'stats-num-bump' : ''}`.trim()}>
      {fmt(displayed)}
    </span>
  );
}

function ProgressRing({
  progress,
  size = 132,
  stroke = 7,
  trackClass,
  fillClass,
}: {
  progress: number;
  size?: number;
  stroke?: number;
  trackClass: string;
  fillClass: string;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, safe(progress)));
  const offset = circumference * (1 - clamped);

  return (
    <svg width={size} height={size} className="-rotate-90" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className={trackClass}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className={`${fillClass} transition-[stroke-dashoffset] duration-700 ease-out`}
      />
    </svg>
  );
}

interface SideTileProps {
  icon: LucideIcon;
  value: number;
  label: string;
  hint: string;
  accent: string;
  iconWrap: string;
  delay: number;
  onClick?: () => void;
  title?: string;
}

const SideTile = memo(function SideTile({
  icon: Icon,
  value,
  label,
  hint,
  accent,
  iconWrap,
  delay,
  onClick,
  title,
}: SideTileProps) {
  const className = [
    'stats-side-tile group relative flex min-h-[72px] flex-1 items-center gap-3 overflow-hidden rounded-2xl border px-3.5 py-3 text-left shadow-sm transition-all duration-300',
    'border-slate-200/90 bg-white/90 dark:border-slate-700/80 dark:bg-[#141d31]/90',
    onClick
      ? 'cursor-pointer hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 dark:hover:border-slate-500'
      : '',
  ].join(' ');

  const body = (
    <>
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${accent} opacity-[0.07] transition-opacity duration-300 group-hover:opacity-[0.14]`} />
      <div className={`absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-gradient-to-b ${accent}`} />
      <div className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${iconWrap} text-white shadow-md transition-transform duration-300 group-hover:scale-105`}>
        <Icon size={18} strokeWidth={2.4} />
      </div>
      <div className="relative min-w-0 flex-1">
        <AnimatedNumber
          value={value}
          className="block text-[1.65rem] font-black leading-none tracking-tight text-slate-800 tabular-nums dark:text-slate-50"
        />
        <p className="mt-1 truncate text-[12px] font-bold leading-none text-slate-700 dark:text-slate-200">
          {label}
        </p>
        <p className="mt-1 truncate text-[10.5px] font-medium leading-none text-slate-400 dark:text-slate-500">
          {hint}
        </p>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        style={{ animationDelay: `${delay}ms` }}
        className={className}
      >
        {body}
      </button>
    );
  }

  return (
    <div title={title} style={{ animationDelay: `${delay}ms` }} className={className}>
      {body}
    </div>
  );
});

interface ScraperStatsBarProps {
  stats: ScraperStats | null;
  loading: boolean;
  onSelectToday?: () => void;
  onSelectReady?: () => void;
  onSelectBest?: () => void;
  onSelectRemote?: () => void;
  onSelectAvailable?: () => void;
}

function StatsBoardSkeleton() {
  return (
    <div className="stats-board-shell flex min-h-[168px] w-full items-center justify-center rounded-[1.6rem] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-[#141d31]">
      <div className="flex items-center gap-3 text-sm font-medium text-slate-400">
        <span className="stats-board-pulse inline-block h-2.5 w-2.5 rounded-full bg-blue-500" />
        Loading your job status…
      </div>
    </div>
  );
}

const StatsBoardContent = memo(function StatsBoardContent({
  view,
  onSelectToday,
  onSelectReady,
  onSelectBest,
  onSelectRemote,
  onSelectAvailable,
}: {
  view: ScraperStats;
  onSelectToday?: () => void;
  onSelectReady?: () => void;
  onSelectBest?: () => void;
  onSelectRemote?: () => void;
  onSelectAvailable?: () => void;
}) {
  const today = safe(view.today_scraped);
  const todayRemote = safe(view.today_remote);
  const ready = safe(view.ready_jobs);
  const best = safe(view.best_jobs ?? 0);
  const remote = safe(view.total_remote);
  const total = safe(view.total_jobs);
  const available = safe(
    view.available_jobs ?? Math.max(0, total - safe(view.applied_jobs ?? 0)),
  );
  const applied = safe(view.applied_jobs ?? Math.max(0, total - available));
  const readyRatio = total > 0 ? ready / total : 0;
  const remotePct = total > 0 ? Math.round((remote / total) * 100) : 0;
  const todayBumped = useBumpOnIncrease(today);

  return (
    <div className="stats-board-shell relative w-full overflow-hidden rounded-[1.6rem] border border-slate-200/90 bg-gradient-to-br from-slate-50 via-white to-blue-50/40 p-3 shadow-sm dark:border-slate-700/80 dark:from-[#0f172a] dark:via-[#141d31] dark:to-[#172554]/40 sm:p-4">
      <div className="pointer-events-none absolute -left-16 top-0 h-40 w-40 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-500/10" />
      <div className="pointer-events-none absolute -right-10 bottom-0 h-36 w-36 rounded-full bg-emerald-400/10 blur-3xl dark:bg-emerald-500/10" />

      <div className="relative grid min-h-[152px] grid-cols-1 items-stretch gap-3 lg:grid-cols-[1fr_auto_1fr] lg:gap-4">
        <div className="flex flex-col gap-3">
          <SideTile
            icon={Rocket}
            value={ready}
            label="Ready to apply"
            hint={total > 0 ? `${fmt(ready)} of ${fmt(total)} with docs ready` : 'Tailored resume ready'}
            accent="from-emerald-400 to-teal-500"
            iconWrap="from-emerald-500 to-teal-500"
            delay={40}
            onClick={onSelectReady}
            title="Jobs with a tailored resume ready to send"
          />
          <SideTile
            icon={Sparkles}
            value={best}
            label="Best jobs"
            hint="Strong matches · score 75+"
            accent="from-amber-400 to-orange-500"
            iconWrap="from-amber-500 to-orange-500"
            delay={90}
            onClick={onSelectBest}
            title="Jobs with a strong match score (75+)"
          />
        </div>

        <button
          type="button"
          onClick={onSelectToday}
          title="Show today's new jobs"
          className={[
            'stats-hero-tile group relative mx-auto flex w-full max-w-[220px] flex-col items-center justify-center rounded-[1.75rem] border px-4 py-3 text-center transition-all duration-300',
            'border-blue-200/80 bg-white/95 shadow-md shadow-blue-500/10',
            'hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg hover:shadow-blue-500/15',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50',
            'dark:border-blue-500/30 dark:bg-[#152033]/95 dark:shadow-blue-900/20',
            todayBumped ? 'stats-hero-pulse' : '',
          ].join(' ')}
        >
          <div className="relative flex h-[132px] w-[132px] items-center justify-center">
            <div className="stats-hero-glow absolute inset-3 rounded-full bg-gradient-to-br from-blue-500/15 via-indigo-500/10 to-cyan-400/15 blur-md" />
            <ProgressRing
              progress={readyRatio}
              trackClass="stroke-slate-200 dark:stroke-slate-700"
              fillClass="stroke-blue-500 dark:stroke-blue-400"
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <CalendarDays size={14} className="mb-1 text-blue-500/80 dark:text-blue-300/80" />
              <AnimatedNumber
                value={today}
                className="text-[2.35rem] font-black leading-none tracking-tight text-slate-900 tabular-nums dark:text-white"
              />
              <span className="mt-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-blue-600/90 dark:text-blue-300/90">
                Today&apos;s jobs
              </span>
            </div>
          </div>
          <p className="mt-1 max-w-[11rem] text-[11px] font-medium leading-snug text-slate-500 dark:text-slate-400">
            {todayRemote > 0
              ? `${fmt(todayRemote)} remote today · ${fmt(applied)} applied overall`
              : total > 0
                ? `${Math.round(readyRatio * 100)}% of pool ready · ${fmt(applied)} applied`
                : 'New jobs added to your board today'}
          </p>
        </button>

        <div className="flex flex-col gap-3">
          <SideTile
            icon={Wifi}
            value={remote}
            label="Remote jobs"
            hint={remotePct > 0 ? `${remotePct}% of your pool` : 'Remote-friendly roles'}
            accent="from-cyan-400 to-blue-500"
            iconWrap="from-cyan-500 to-blue-600"
            delay={40}
            onClick={onSelectRemote}
            title="Show remote-friendly jobs"
          />
          <SideTile
            icon={CirclePlay}
            value={available}
            label="Available to start"
            hint="Still open · not applied yet"
            accent="from-violet-400 to-indigo-500"
            iconWrap="from-violet-500 to-indigo-600"
            delay={90}
            onClick={onSelectAvailable}
            title="Jobs you have not marked as applied"
          />
        </div>
      </div>
    </div>
  );
});

export const ScraperStatsBar = memo(function ScraperStatsBar({
  stats,
  loading,
  onSelectToday,
  onSelectReady,
  onSelectBest,
  onSelectRemote,
  onSelectAvailable,
}: ScraperStatsBarProps) {
  const cachedRef = useRef<ScraperStats | null>(null);
  if (stats) cachedRef.current = stats;
  const view = stats ?? cachedRef.current;

  if (!view) {
    return <StatsBoardSkeleton />;
  }

  return (
    <StatsBoardContent
      view={view}
      onSelectToday={onSelectToday}
      onSelectReady={onSelectReady}
      onSelectBest={onSelectBest}
      onSelectRemote={onSelectRemote}
      onSelectAvailable={onSelectAvailable}
    />
  );
});
