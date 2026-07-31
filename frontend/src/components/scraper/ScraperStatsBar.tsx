import { memo, useEffect, useRef, useState } from 'react';
import {
  Rocket,
  Sparkles,
  Wifi,
  CirclePlay,
  CalendarDays,
  Briefcase,
  ClipboardCheck,
  Table2,
  MessageSquare,
  UserRound,
  Gauge,
  ThumbsUp,
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
  size = 168,
  stroke = 9,
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
    'stats-side-tile group relative flex min-h-[104px] flex-1 items-center gap-4 overflow-hidden rounded-2xl border px-4 py-4 text-left shadow-sm transition-all duration-300 sm:px-5',
    'border-slate-200/90 bg-white/95 dark:border-slate-700/80 dark:bg-[#141d31]/95',
    onClick
      ? 'cursor-pointer hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 dark:hover:border-slate-500'
      : '',
  ].join(' ');

  const body = (
    <>
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${accent} opacity-[0.08] transition-opacity duration-300 group-hover:opacity-[0.16]`} />
      <div className={`absolute inset-y-4 left-0 w-1 rounded-r-full bg-gradient-to-b ${accent}`} />
      <div className={`relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${iconWrap} text-white shadow-lg transition-transform duration-300 group-hover:scale-105`}>
        <Icon size={24} strokeWidth={2.35} />
      </div>
      <div className="relative min-w-0 flex-1">
        <AnimatedNumber
          value={value}
          className="block text-[2.15rem] font-black leading-none tracking-tight text-slate-900 tabular-nums dark:text-white"
        />
        <p className="mt-2 truncate text-[14px] font-bold leading-none text-slate-700 dark:text-slate-100">
          {label}
        </p>
        <p className="mt-1.5 truncate text-[12px] font-medium leading-snug text-slate-500 dark:text-slate-400">
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

interface StripStatProps {
  icon: LucideIcon;
  value: number;
  label: string;
  tone: string;
  title?: string;
  onClick?: () => void;
}

const StripStat = memo(function StripStat({
  icon: Icon,
  value,
  label,
  tone,
  title,
  onClick,
}: StripStatProps) {
  const className = [
    'stats-strip-stat group flex min-w-0 flex-1 items-center gap-3 rounded-xl border px-3.5 py-3 transition-all duration-300',
    'border-slate-200/80 bg-white/80 dark:border-slate-700/70 dark:bg-[#101827]/80',
    onClick
      ? 'cursor-pointer hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 dark:hover:border-slate-500'
      : '',
  ].join(' ');

  const body = (
    <>
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon size={18} strokeWidth={2.4} />
      </div>
      <div className="min-w-0">
        <AnimatedNumber
          value={value}
          className="block text-[1.35rem] font-black leading-none tracking-tight text-slate-900 tabular-nums dark:text-white"
        />
        <p className="mt-1 truncate text-[11.5px] font-semibold text-slate-500 dark:text-slate-400">
          {label}
        </p>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={className}>
        {body}
      </button>
    );
  }

  return (
    <div title={title} className={className}>
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
  onSelectRemote?: () => void;
  onSelectAvailable?: () => void;
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
  onSelectRemote,
  onSelectAvailable,
  onSelectMine,
  onSelectAll,
}: {
  view: ScraperStats;
  onSelectToday?: () => void;
  onSelectReady?: () => void;
  onSelectBest?: () => void;
  onSelectGood?: () => void;
  onSelectRemote?: () => void;
  onSelectAvailable?: () => void;
  onSelectMine?: () => void;
  onSelectAll?: () => void;
}) {
  const today = safe(view.today_scraped);
  const todayRemote = safe(view.today_remote);
  const ready = safe(view.ready_jobs);
  const best = safe(view.best_jobs ?? 0);
  const good = safe(view.good_jobs ?? 0);
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

  return (
    <div className="stats-board-shell relative w-full overflow-hidden rounded-[1.75rem] border border-slate-200/90 bg-gradient-to-br from-slate-50 via-white to-blue-50/50 p-4 shadow-sm dark:border-slate-700/80 dark:from-[#0f172a] dark:via-[#141d31] dark:to-[#172554]/45 sm:p-5">
      <div className="pointer-events-none absolute -left-20 top-0 h-48 w-48 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-500/10" />
      <div className="pointer-events-none absolute -right-12 bottom-0 h-44 w-44 rounded-full bg-emerald-400/10 blur-3xl dark:bg-emerald-500/10" />

      <div className="relative grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1.05fr_auto_1.05fr] lg:gap-5">
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
          />
        </div>

        <button
          type="button"
          onClick={onSelectToday}
          title="Show today's new jobs"
          className={[
            'stats-hero-tile group relative mx-auto flex w-full max-w-[260px] flex-col items-center justify-center rounded-[2rem] border px-5 py-4 text-center transition-all duration-300',
            'border-blue-200/80 bg-white/95 shadow-lg shadow-blue-500/10',
            'hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-xl hover:shadow-blue-500/15',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50',
            'dark:border-blue-500/30 dark:bg-[#152033]/95 dark:shadow-blue-900/25',
            todayBumped ? 'stats-hero-pulse' : '',
          ].join(' ')}
        >
          <div className="relative flex h-[168px] w-[168px] items-center justify-center">
            <div className="stats-hero-glow absolute inset-2 rounded-full bg-gradient-to-br from-blue-500/20 via-indigo-500/12 to-cyan-400/18 blur-md" />
            <ProgressRing
              progress={readyRatio}
              trackClass="stroke-slate-200 dark:stroke-slate-700"
              fillClass="stroke-blue-500 dark:stroke-blue-400"
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center px-3">
              <CalendarDays size={16} className="mb-1.5 text-blue-500 dark:text-blue-300" />
              <AnimatedNumber
                value={today}
                className="text-[3rem] font-black leading-none tracking-tight text-slate-900 tabular-nums dark:text-white"
              />
              <span className="mt-2 text-[12px] font-extrabold uppercase tracking-[0.16em] text-blue-600 dark:text-blue-300">
                Today&apos;s jobs
              </span>
            </div>
          </div>
          <div className="mt-2 space-y-1">
            <p className="text-[13px] font-semibold leading-snug text-slate-600 dark:text-slate-300">
              {todayRemote > 0
                ? `${fmt(todayRemote)} remote added today`
                : total > 0
                  ? `${Math.round(readyRatio * 100)}% of pool ready to apply`
                  : 'New jobs added to your board today'}
            </p>
            <p className="text-[12px] font-medium text-slate-400 dark:text-slate-500">
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

      <div className="relative mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-7">
        <StripStat
          icon={Briefcase}
          value={total}
          label="Total jobs"
          tone="bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
          title="All jobs in your active pool"
          onClick={onSelectAll}
        />
        <StripStat
          icon={ClipboardCheck}
          value={applied}
          label={appliedToday > 0 ? `Applied · ${fmt(appliedToday)} today` : 'Applied'}
          tone="bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300"
          title="Jobs you marked as applied"
        />
        <StripStat
          icon={ThumbsUp}
          value={good + best}
          label="Good+ matches"
          tone="bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
          title="Jobs scoring 50+ (Good and Strong)"
          onClick={onSelectGood}
        />
        <StripStat
          icon={Gauge}
          value={avgScore}
          label={scored > 0 ? `Avg match · ${fmt(scored)} scored` : 'Avg match'}
          tone="bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
          title="Average AI match score across analysed jobs"
        />
        <StripStat
          icon={Table2}
          value={sheetPosted}
          label="In Google Sheets"
          tone="bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
          title="Jobs posted to Google Sheets"
        />
        <StripStat
          icon={MessageSquare}
          value={pumblePosted}
          label="In Pumble"
          tone="bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
          title="Jobs posted to Pumble"
        />
        <StripStat
          icon={UserRound}
          value={myJobs}
          label="Posted by me"
          tone="bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300"
          title="Jobs you added by URL or attachment"
          onClick={onSelectMine}
        />
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
  onSelectRemote,
  onSelectAvailable,
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
      onSelectRemote={onSelectRemote}
      onSelectAvailable={onSelectAvailable}
      onSelectMine={onSelectMine}
      onSelectAll={onSelectAll}
    />
  );
});
