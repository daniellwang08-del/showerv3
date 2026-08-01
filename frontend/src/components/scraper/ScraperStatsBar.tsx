import { memo, useEffect, useId, useRef, useState } from 'react';
import {
  Rocket,
  Sparkles,
  Wifi,
  CirclePlay,
  CalendarDays,
  Layers,
  ClipboardCheck,
  Table2,
  MessageSquare,
  UserRound,
  Gauge,
  ThumbsUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScraperStats } from '../../types/scraper';
import { TrendSparkline } from './TrendSparkline';

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

function HeroOrbitRing({
  progress,
  size = 188,
}: {
  progress: number;
  size?: number;
}) {
  const uid = useId().replace(/:/g, '');
  const stroke = 10;
  const pad = 18;
  const full = size + pad * 2;
  const cx = full / 2;
  const cy = full / 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, safe(progress)));
  const offset = circumference * (1 - clamped);
  const orbitR = radius + 14;

  return (
    <div className="stats-hero-orbit relative" style={{ width: full, height: full }}>
      <div className="stats-hero-aura absolute inset-5 rounded-full" />
      <div className="stats-hero-aura-core absolute inset-11 rounded-full" />
      <div className="stats-orbit-spin absolute inset-0">
        <span
          className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.85)]"
          style={{ transform: `translate(-50%, -50%) rotate(0deg) translateY(-${orbitR}px)` }}
        />
        <span
          className="absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.8)]"
          style={{ transform: `translate(-50%, -50%) rotate(145deg) translateY(-${orbitR}px)` }}
        />
      </div>

      <svg width={full} height={full} viewBox={`0 0 ${full} ${full}`} className="absolute inset-0" aria-hidden>
        <defs>
          <linearGradient id={`stats-ring-grad-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="45%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
          <linearGradient id={`stats-ring-glow-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#67e8f9" stopOpacity="0.15" />
            <stop offset="50%" stopColor="#60a5fa" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.2" />
          </linearGradient>
          <filter id={`stats-soft-glow-${uid}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <circle
          cx={cx}
          cy={cy}
          r={orbitR}
          fill="none"
          strokeWidth="1.25"
          strokeDasharray="2.5 9"
          className="stats-orbit-dashes stroke-blue-400/30 dark:stroke-blue-300/20"
        />

        <g transform={`rotate(-90 ${cx} ${cy})`}>
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            className="stroke-slate-200/90 dark:stroke-slate-700/90"
          />
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            strokeWidth={stroke + 5}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            stroke={`url(#stats-ring-glow-${uid})`}
            className="stats-ring-progress opacity-45"
          />
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            stroke={`url(#stats-ring-grad-${uid})`}
            filter={`url(#stats-soft-glow-${uid})`}
            className="stats-ring-progress transition-[stroke-dashoffset] duration-700 ease-out"
          />
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke="white"
            strokeWidth={stroke - 4}
            strokeLinecap="round"
            strokeDasharray={`${Math.max(16, circumference * 0.07)} ${circumference}`}
            strokeDashoffset={offset}
            className="stats-ring-shimmer opacity-45 mix-blend-screen"
          />
        </g>
      </svg>
    </div>
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
  trend?: number[];
  trendColor?: string;
  trendLabel?: string;
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
  trend,
  trendColor = '#34d399',
  trendLabel,
}: SideTileProps) {
  const className = [
    'stats-side-tile group relative flex min-h-[118px] flex-1 items-center gap-3 overflow-hidden rounded-2xl border px-3.5 py-3.5 text-left shadow-sm transition-all duration-300 sm:gap-4 sm:px-5 sm:py-4',
    'border-slate-200/90 bg-white/95 dark:border-slate-700/80 dark:bg-[#141d31]/95',
    onClick
      ? 'cursor-pointer hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 dark:hover:border-slate-500'
      : '',
  ].join(' ');

  const body = (
    <>
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${accent} opacity-[0.08] transition-opacity duration-300 group-hover:opacity-[0.16]`} />
      <div className={`absolute inset-y-4 left-0 w-1 rounded-r-full bg-gradient-to-b ${accent}`} />
      <div className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${iconWrap} text-white shadow-lg transition-transform duration-300 group-hover:scale-105 sm:h-14 sm:w-14`}>
        <Icon size={22} strokeWidth={2.35} />
      </div>
      <div className="relative min-w-0 flex-[1.05]">
        <AnimatedNumber
          value={value}
          className="block text-[2rem] font-black leading-none tracking-tight text-slate-900 tabular-nums sm:text-[2.15rem]"
        />
        <p className="mt-2 truncate text-[13px] font-bold leading-none text-slate-700 sm:text-[14px]">
          {label}
        </p>
        <p className="mt-1.5 truncate text-[11.5px] font-medium leading-snug text-slate-500 sm:text-[12px]">
          {hint}
        </p>
      </div>
      <div className="relative min-w-0 flex-1 self-stretch pl-0.5 sm:pl-1">
        <TrendSparkline
          values={trend ?? []}
          color={trendColor}
          delayMs={delay + 180}
          label={trendLabel ?? label}
        />
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

interface RailStatProps {
  icon: LucideIcon;
  value: number;
  label: string;
  tone: string;
  title?: string;
  onClick?: () => void;
  delay?: number;
  modern?: boolean;
}

const RailStat = memo(function RailStat({
  icon: Icon,
  value,
  label,
  tone,
  title,
  onClick,
  delay = 0,
  modern = false,
}: RailStatProps) {
  const className = [
    'stats-rail-stat group flex w-full min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-2xl border px-3 py-3 text-left transition-all duration-300',
    'border-slate-200/80 bg-white/85 dark:border-slate-700/70 dark:bg-[#101827]/85',
    onClick
      ? 'cursor-pointer hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 dark:hover:border-slate-500'
      : '',
  ].join(' ');

  const body = (
    <>
      <div
        className={[
          'relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl shadow-sm transition-transform duration-300 group-hover:scale-105',
          tone,
          modern ? 'stats-total-icon' : '',
        ].join(' ')}
      >
        {modern ? (
          <>
            <span className="stats-total-icon-glow absolute inset-0 rounded-xl" />
            <Layers size={20} strokeWidth={2.2} className="relative" />
          </>
        ) : (
          <Icon size={18} strokeWidth={2.4} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <AnimatedNumber
          value={value}
          className="block text-[1.45rem] font-black leading-none tracking-tight text-slate-900 tabular-nums"
        />
        <p className="mt-1 truncate text-[11.5px] font-semibold text-slate-500">
          {label}
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
  onSelectGood?: () => void;
  onSelectAvg?: () => void;
  onSelectRemote?: () => void;
  onSelectAvailable?: () => void;
  onSelectApplied?: () => void;
  onSelectSheet?: () => void;
  onSelectPumble?: () => void;
  onSelectMine?: () => void;
  onSelectAll?: () => void;
}

function StatsBoardSkeleton() {
  return (
    <div className="stats-board-shell flex min-h-[280px] w-full items-center justify-center rounded-[1.75rem] border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-[#141d31]">
      <div className="flex items-center gap-3 text-base font-medium text-slate-400">
        <span className="stats-board-pulse inline-block h-3 w-3 rounded-full bg-blue-500" />
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
  onSelectGood,
  onSelectAvg,
  onSelectRemote,
  onSelectAvailable,
  onSelectApplied,
  onSelectSheet,
  onSelectPumble,
  onSelectMine,
  onSelectAll,
}: {
  view: ScraperStats;
  onSelectToday?: () => void;
  onSelectReady?: () => void;
  onSelectBest?: () => void;
  onSelectGood?: () => void;
  onSelectAvg?: () => void;
  onSelectRemote?: () => void;
  onSelectAvailable?: () => void;
  onSelectApplied?: () => void;
  onSelectSheet?: () => void;
  onSelectPumble?: () => void;
  onSelectMine?: () => void;
  onSelectAll?: () => void;
}) {
  const today = safe(view.today_scraped);
  const todayRemote = safe(view.today_remote);
  const ready = safe(view.ready_jobs);
  const best = safe(view.best_jobs ?? 0);
  const good = safe(view.good_jobs ?? 0);
  const qualified = safe(view.qualified_jobs ?? good + best);
  const scored = safe(view.scored_jobs ?? 0);
  const avgScore = safe(view.avg_match_score ?? 0);
  const remote = safe(view.total_remote);
  const total = safe(view.total_jobs);
  const myJobs = safe(view.my_jobs);
  const available = safe(
    view.available_jobs ?? Math.max(0, total - safe(view.applied_jobs ?? 0)),
  );
  const applied = safe(view.applied_jobs ?? Math.max(0, total - available));
  const appliedToday = safe(view.applied_today ?? 0);
  const sheetPosted = safe(view.sheet_posted_jobs ?? 0);
  const pumblePosted = safe(view.pumble_posted_jobs ?? 0);
  const readyRatio = total > 0 ? ready / total : 0;
  const appliedRatio = total > 0 ? applied / total : 0;
  const remotePct = total > 0 ? Math.round((remote / total) * 100) : 0;
  const todayBumped = useBumpOnIncrease(today);
  const trends = view.trends;
  const readyTrend = trends?.ready ?? [];
  const bestTrend = trends?.best ?? [];
  const remoteTrend = trends?.remote ?? [];
  const availableTrend = trends?.available ?? [];

  return (
    <div className="stats-board-shell relative w-full overflow-hidden rounded-[1.75rem] border border-slate-200/90 bg-gradient-to-br from-slate-50 via-white to-blue-50/50 p-4 shadow-sm dark:border-slate-700/80 dark:from-[#0f172a] dark:via-[#141d31] dark:to-[#172554]/45 sm:p-5">
      <div className="pointer-events-none absolute -left-20 top-0 h-48 w-48 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-500/10" />
      <div className="pointer-events-none absolute -right-12 bottom-0 h-44 w-44 rounded-full bg-emerald-400/10 blur-3xl dark:bg-emerald-500/10" />

      <div className="relative grid grid-cols-1 items-stretch gap-4 xl:grid-cols-[13.5rem_minmax(0,1fr)_13.5rem] xl:gap-4">
        <div className="order-2 grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:order-1 xl:flex xl:h-full xl:flex-col">
          <RailStat
            icon={Layers}
            value={total}
            label="Total jobs"
            tone="bg-gradient-to-br from-slate-700 via-slate-800 to-indigo-900 text-white"
            title="All jobs in your active pool"
            onClick={onSelectAll}
            delay={30}
            modern
          />
          <RailStat
            icon={ClipboardCheck}
            value={applied}
            label={appliedToday > 0 ? `Applied · ${fmt(appliedToday)} today` : 'Applied'}
            tone="bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300"
            title="Jobs you marked as applied"
            onClick={onSelectApplied}
            delay={70}
          />
          <RailStat
            icon={ThumbsUp}
            value={qualified}
            label="Good+ matches"
            tone="bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
            title="Jobs at or above your preference minimum match score"
            onClick={onSelectGood}
            delay={110}
          />
          <RailStat
            icon={Gauge}
            value={avgScore}
            label={scored > 0 ? `Avg match · ${fmt(scored)} scored` : 'Avg match'}
            tone="bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
            title="Average AI match score — click to show qualified matches"
            onClick={onSelectAvg}
            delay={150}
          />
        </div>

        <div className="order-1 grid grid-cols-1 items-stretch gap-3.5 lg:grid-cols-[1fr_auto_1fr] lg:gap-4 xl:order-2">
          <div className="flex flex-col gap-3.5">
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
              trend={readyTrend}
              trendColor="#34d399"
              trendLabel="Ready to apply"
            />
            <SideTile
              icon={Sparkles}
              value={best}
              label="Best jobs"
              hint={`Strong matches · score 75+${good > 0 ? ` · ${fmt(good)} good` : ''}`}
              accent="from-amber-400 to-orange-500"
              iconWrap="from-amber-500 to-orange-500"
              delay={90}
              onClick={onSelectBest}
              title="Jobs with a strong match score (75+)"
              trend={bestTrend}
              trendColor="#fbbf24"
              trendLabel="Best jobs"
            />
          </div>

          <button
            type="button"
            onClick={onSelectToday}
            title="Show today's new jobs"
            className={[
              'stats-hero-tile group relative mx-auto flex w-full max-w-[280px] flex-col items-center justify-center rounded-[2rem] border px-4 py-4 text-center transition-all duration-300',
              'border-blue-200/80 bg-white/95 shadow-lg shadow-blue-500/10',
              'hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-xl hover:shadow-blue-500/20',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50',
              'dark:border-blue-500/30 dark:bg-[#152033]/95 dark:shadow-blue-900/25',
              todayBumped ? 'stats-hero-pulse' : '',
            ].join(' ')}
          >
            <div className="relative flex items-center justify-center">
              <HeroOrbitRing progress={readyRatio} />
              <div className="absolute inset-0 flex flex-col items-center justify-center px-8 pb-6">
                <CalendarDays size={15} className="mb-1 text-blue-500 dark:text-blue-300 stats-hero-icon-float" />
                <AnimatedNumber
                  value={today}
                  className="text-[3.1rem] font-black leading-none tracking-tight text-slate-900 tabular-nums"
                />
                <span className="mt-1.5 text-[12px] font-extrabold uppercase tracking-[0.16em] text-blue-600 dark:text-blue-300">
                  Today&apos;s jobs
                </span>
              </div>
            </div>
            <div className="mt-1 space-y-1">
              <p className="text-[13px] font-semibold leading-snug text-slate-600">
                {todayRemote > 0
                  ? `${fmt(todayRemote)} remote added today`
                  : total > 0
                    ? `${Math.round(readyRatio * 100)}% of pool ready to apply`
                    : 'New jobs added to your board today'}
              </p>
              <p className="text-[12px] font-medium text-slate-500">
                {fmt(applied)} applied · {Math.round(appliedRatio * 100)}% of pool
              </p>
            </div>
          </button>

          <div className="flex flex-col gap-3.5">
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
              trend={remoteTrend}
              trendColor="#38bdf8"
              trendLabel="Remote jobs"
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
              trend={availableTrend}
              trendColor="#a78bfa"
              trendLabel="Available to start"
            />
          </div>
        </div>

        <div className="order-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:flex xl:h-full xl:flex-col">
          <RailStat
            icon={Table2}
            value={sheetPosted}
            label="In Google Sheets"
            tone="bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
            title="Jobs posted to Google Sheets"
            onClick={onSelectSheet}
            delay={30}
          />
          <RailStat
            icon={MessageSquare}
            value={pumblePosted}
            label="In Pumble"
            tone="bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
            title="Jobs posted to Pumble"
            onClick={onSelectPumble}
            delay={70}
          />
          <RailStat
            icon={UserRound}
            value={myJobs}
            label="Posted by me"
            tone="bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300"
            title="Jobs you added by URL or attachment"
            onClick={onSelectMine}
            delay={110}
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
  onSelectGood,
  onSelectAvg,
  onSelectRemote,
  onSelectAvailable,
  onSelectApplied,
  onSelectSheet,
  onSelectPumble,
  onSelectMine,
  onSelectAll,
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
      onSelectGood={onSelectGood}
      onSelectAvg={onSelectAvg}
      onSelectRemote={onSelectRemote}
      onSelectAvailable={onSelectAvailable}
      onSelectApplied={onSelectApplied}
      onSelectSheet={onSelectSheet}
      onSelectPumble={onSelectPumble}
      onSelectMine={onSelectMine}
      onSelectAll={onSelectAll}
    />
  );
});
