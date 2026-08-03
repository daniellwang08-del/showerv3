import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
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
  FileSearch,
  FileCheck2,
  CircleAlert,
  Upload,
  Activity,
  Users,
  Clock3,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AdminScraperStats, ScraperStats } from '../../types/scraper';
import { fetchSheetsConfig } from '../../api/googleSheetsApi';
import { fetchPumbleConfig } from '../../api/pumbleApi';
import { TrendSparkline } from './TrendSparkline';

interface RailItem {
  key: string;
  icon: LucideIcon;
  value: number;
  label: string;
  tone: string;
  title: string;
  onClick?: () => void;
  delay: number;
  modern?: boolean;
}

/** Split rail metrics left/right with a slight left bias on odd counts (5 → 3|2). */
function balanceRailColumns(leftSeed: RailItem[], rightSeed: RailItem[]): {
  left: RailItem[];
  right: RailItem[];
} {
  const left = [...leftSeed];
  const right = [...rightSeed];
  const targetLeft = Math.ceil((left.length + right.length) / 2);
  while (left.length > targetLeft) {
    const moved = left.pop();
    if (moved) right.unshift(moved);
  }
  return { left, right };
}

function railGridClass(count: number): string {
  if (count <= 1) return 'grid-cols-1';
  if (count === 2) return 'grid-cols-2';
  if (count === 3) return 'grid-cols-2 sm:grid-cols-3';
  return 'grid-cols-2 sm:grid-cols-4';
}

function safe(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
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
  // Fixed line box + tabular nums so digit/count-up changes never alter tile height.
  return (
    <span
      className={[
        'inline-flex h-[1.05em] max-w-full items-center overflow-hidden tabular-nums',
        className ?? '',
        bumped ? 'stats-num-bump' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
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
          {/* Loading highlight: pathLength=1 so CSS can loop a full revolution
              (dashoffset -1). Previously offset was hard-coded to -120px ≈ 20% of
              the ring, so the white bar only traveled top → left-middle. */}
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke="white"
            strokeWidth={stroke - 4}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray="0.1 0.9"
            className="stats-ring-shimmer mix-blend-screen"
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
  trendLabels?: string[];
  trendColor?: string;
  trendLabel?: string;
  /** Shared Y max for all board sparklines (comparable peak heights). */
  trendMaxScale?: number;
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
  trendLabels,
  trendColor = '#34d399',
  trendLabel,
  trendMaxScale,
}: SideTileProps) {
  const className = [
    // flex-1 + min-h only — fixed h/max-h left empty gaps under the main panels
    // while side rails stretched to the taller hero column.
    'stats-side-tile group relative flex min-h-[126px] w-full flex-1 items-center gap-3 overflow-hidden rounded-2xl border px-3.5 py-3.5 text-left shadow-sm transition-[border-color,box-shadow,transform,background-color] duration-300 sm:gap-4 sm:px-5 sm:py-4',
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
          className="text-[2rem] font-black leading-none tracking-tight text-slate-900 dark:text-slate-50 sm:text-[2.15rem]"
        />
        <p className="mt-2 truncate text-[13px] font-bold leading-none text-slate-700 dark:text-slate-200 sm:text-[14px]">
          {label}
        </p>
        <p className="mt-1.5 truncate text-[11.5px] font-medium leading-snug text-slate-500 dark:text-slate-400 sm:text-[12px]">
          {hint}
        </p>
      </div>
      {Array.isArray(trend) && trend.length > 0 ? (
        <div className="relative min-w-0 flex-1 self-stretch pl-0.5 sm:pl-1">
          <TrendSparkline
            values={trend}
            labels={trendLabels}
            color={trendColor}
            delayMs={delay + 180}
            label={trendLabel ?? label}
            maxScale={trendMaxScale}
          />
        </div>
      ) : null}
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
    // flex-1 fills the rail column so left/right rails match the main board height.
    'stats-rail-stat group flex min-h-[68px] w-full min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-2xl border px-3 py-3 text-left transition-[border-color,box-shadow,transform,background-color] duration-300',
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
          className="text-[1.45rem] font-black leading-none tracking-tight text-slate-900"
        />
        <p className="mt-1 truncate text-[11.5px] font-semibold text-slate-500 dark:text-slate-400">
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
  adminStats?: AdminScraperStats | null;
  loading: boolean;
  variant?: 'applicant' | 'admin';
  /** When true, show the Google Sheets rail tile (user has Sheets connected). */
  sheetsConfigured?: boolean;
  /** When true, show the Pumble rail tile (user has Pumble connected). */
  pumbleConfigured?: boolean;
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
  onSelectNeedsExtraction?: () => void;
  onSelectExtracted?: () => void;
  onSelectExtractionFailed?: () => void;
  onSelectManual?: () => void;
  onSelectTeamAppliedToday?: () => void;
}

function StatsBoardSkeleton({ label = 'Loading your job status…' }: { label?: string }) {
  return (
    <div className="stats-board-shell flex min-h-[280px] w-full items-center justify-center rounded-[1.75rem] border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-[#141d31]" style={{ contentVisibility: 'auto' }}>
      <div className="flex items-center gap-3 text-base font-medium text-slate-400 dark:text-slate-300">
        <span className="stats-board-pulse inline-block h-3 w-3 rounded-full bg-blue-500" />
        {label}
      </div>
    </div>
  );
}

const StatsBoardContent = memo(function StatsBoardContent({
  view,
  sheetsConfigured = false,
  pumbleConfigured = false,
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
  sheetsConfigured?: boolean;
  pumbleConfigured?: boolean;
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
  const trendDayLabels = trends?.labels ?? [];
  const readyTrend = trends?.ready ?? [];
  const bestTrend = trends?.best ?? [];
  const remoteTrend = trends?.remote ?? [];
  const availableTrend = trends?.available ?? [];
  // One Y-domain for all four side sparklines so absolute daily peaks compare
  // (836 best must draw shorter than 1131 ready — not both maxed out).
  const trendMaxScale = Math.max(
    1,
    ...[...readyTrend, ...bestTrend, ...remoteTrend, ...availableTrend].map((n) =>
      Number.isFinite(n) ? Math.max(0, n) : 0,
    ),
  );

  // Core rails always show; Sheets/Pumble only when the user connected them.
  const { left: leftRail, right: rightRail } = useMemo(() => {
    const leftSeed: RailItem[] = [
      {
        key: 'total',
        icon: Layers,
        value: total,
        label: 'Total jobs',
        tone: 'bg-gradient-to-br from-slate-700 via-slate-800 to-indigo-900 text-white',
        title: 'All jobs in your active pool',
        onClick: onSelectAll,
        delay: 30,
        modern: true,
      },
      {
        key: 'applied',
        icon: ClipboardCheck,
        value: applied,
        label: appliedToday > 0 ? `Applied · ${fmt(appliedToday)} today` : 'Applied',
        tone: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
        title: 'Jobs you marked as applied',
        onClick: onSelectApplied,
        delay: 70,
      },
      {
        key: 'good',
        icon: ThumbsUp,
        value: qualified,
        label: 'Good+ matches',
        tone: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
        title: 'Jobs at or above your preference minimum match score',
        onClick: onSelectGood,
        delay: 110,
      },
      {
        key: 'avg',
        icon: Gauge,
        value: avgScore,
        label: scored > 0 ? `Avg match · ${fmt(scored)} scored` : 'Avg match',
        tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
        title: 'Average AI match score — click to show qualified matches',
        onClick: onSelectAvg,
        delay: 150,
      },
    ];
    const rightSeed: RailItem[] = [
      ...(sheetsConfigured
        ? [
            {
              key: 'sheets',
              icon: Table2,
              value: sheetPosted,
              label: 'In Google Sheets',
              tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200',
              title: 'Jobs posted to Google Sheets',
              onClick: onSelectSheet,
              delay: 30,
            } satisfies RailItem,
          ]
        : []),
      ...(pumbleConfigured
        ? [
            {
              key: 'pumble',
              icon: MessageSquare,
              value: pumblePosted,
              label: 'In Pumble',
              tone: 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300',
              title: 'Jobs posted to Pumble',
              onClick: onSelectPumble,
              delay: 70,
            } satisfies RailItem,
          ]
        : []),
      {
        key: 'mine',
        icon: UserRound,
        value: myJobs,
        label: 'Posted by me',
        tone: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300',
        title: 'Jobs you added by URL or attachment',
        onClick: onSelectMine,
        delay: 110,
      },
    ];
    return balanceRailColumns(leftSeed, rightSeed);
  }, [
    total,
    applied,
    appliedToday,
    qualified,
    avgScore,
    scored,
    sheetPosted,
    pumblePosted,
    myJobs,
    sheetsConfigured,
    pumbleConfigured,
    onSelectAll,
    onSelectApplied,
    onSelectGood,
    onSelectAvg,
    onSelectSheet,
    onSelectPumble,
    onSelectMine,
  ]);

  return (
    <div className="stats-board-shell relative w-full overflow-hidden rounded-[1.75rem] border border-slate-200/90 bg-gradient-to-br from-slate-50 via-white to-blue-50/50 p-4 shadow-sm dark:border-slate-700/80 dark:from-[#0f172a] dark:via-[#141d31] dark:to-[#172554]/45 sm:p-5">
      <div className="pointer-events-none absolute -left-20 top-0 h-48 w-48 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-500/10" />
      <div className="pointer-events-none absolute -right-12 bottom-0 h-44 w-44 rounded-full bg-emerald-400/10 blur-3xl dark:bg-emerald-500/10" />

      <div className="relative grid grid-cols-1 items-stretch gap-4 xl:grid-cols-[13.5rem_minmax(0,1fr)_13.5rem] xl:gap-4">
        <div
          className={[
            'order-2 grid gap-2.5 self-stretch xl:order-1 xl:flex xl:h-full xl:min-h-0 xl:flex-col',
            railGridClass(leftRail.length),
          ].join(' ')}
        >
          {leftRail.map((item) => (
            <RailStat
              key={item.key}
              icon={item.icon}
              value={item.value}
              label={item.label}
              tone={item.tone}
              title={item.title}
              onClick={item.onClick}
              delay={item.delay}
              modern={item.modern}
            />
          ))}
        </div>

        <div className="order-1 grid h-full min-h-0 grid-cols-1 items-stretch gap-3.5 self-stretch lg:grid-cols-[1fr_auto_1fr] lg:gap-4 xl:order-2">
          <div className="flex h-full min-h-0 flex-col gap-3.5">
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
              trendLabels={trendDayLabels}
              trendColor="#34d399"
              trendLabel="Ready to apply"
              trendMaxScale={trendMaxScale}
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
              trendLabels={trendDayLabels}
              trendColor="#fbbf24"
              trendLabel="Best jobs"
              trendMaxScale={trendMaxScale}
            />
          </div>

          <button
            type="button"
            onClick={onSelectToday}
            title="Show today's new jobs"
            className={[
              'stats-hero-tile group relative mx-auto flex h-full min-h-[280px] w-full max-w-[280px] flex-col items-center justify-center self-stretch rounded-[2rem] border px-4 py-4 text-center transition-[border-color,box-shadow,transform,background-color] duration-300',
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
                  className="text-[3.1rem] font-black leading-none tracking-tight text-slate-900"
                />
                <span className="mt-1.5 text-[12px] font-extrabold uppercase tracking-[0.16em] text-blue-600 dark:text-blue-300">
                  Today&apos;s jobs
                </span>
              </div>
            </div>
            <div className="mt-1 flex h-[52px] flex-col justify-center space-y-1">
              <p className="truncate text-[13px] font-semibold leading-snug text-slate-600 dark:text-slate-300">
                {todayRemote > 0
                  ? `${fmt(todayRemote)} remote added today`
                  : total > 0
                    ? `${Math.round(readyRatio * 100)}% of pool ready to apply`
                    : 'New jobs added to your board today'}
              </p>
              <p className="truncate text-[12px] font-medium text-slate-500 dark:text-slate-400">
                {fmt(applied)} applied · {Math.round(appliedRatio * 100)}% of pool
              </p>
            </div>
          </button>

          <div className="flex h-full min-h-0 flex-col gap-3.5">
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
              trendLabels={trendDayLabels}
              trendColor="#38bdf8"
              trendLabel="Remote jobs"
              trendMaxScale={trendMaxScale}
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
              trendLabels={trendDayLabels}
              trendColor="#a78bfa"
              trendLabel="Available to start"
              trendMaxScale={trendMaxScale}
            />
          </div>
        </div>

        <div
          className={[
            'order-3 grid gap-2.5 self-stretch xl:flex xl:h-full xl:min-h-0 xl:flex-col',
            railGridClass(rightRail.length),
          ].join(' ')}
        >
          {rightRail.map((item) => (
            <RailStat
              key={item.key}
              icon={item.icon}
              value={item.value}
              label={item.label}
              tone={item.tone}
              title={item.title}
              onClick={item.onClick}
              delay={item.delay}
              modern={item.modern}
            />
          ))}
        </div>
      </div>
    </div>
  );
});


function formatLastSyncAt(iso: string | null | undefined): string {
  if (!iso) return 'No sync recorded yet';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return 'No sync recorded yet';
  }
}

const AdminStatsBoardContent = memo(function AdminStatsBoardContent({
  view,
  sheetsConfigured = false,
  pumbleConfigured = false,
  onSelectToday,
  onSelectNeedsExtraction,
  onSelectExtracted,
  onSelectSheet,
  onSelectPumble,
  onSelectExtractionFailed,
  onSelectManual,
  onSelectTeamAppliedToday,
  onSelectAll,
  onSelectRemote,
}: {
  view: AdminScraperStats;
  sheetsConfigured?: boolean;
  pumbleConfigured?: boolean;
  onSelectToday?: () => void;
  onSelectNeedsExtraction?: () => void;
  onSelectExtracted?: () => void;
  onSelectSheet?: () => void;
  onSelectPumble?: () => void;
  onSelectExtractionFailed?: () => void;
  onSelectManual?: () => void;
  onSelectTeamAppliedToday?: () => void;
  onSelectAll?: () => void;
  onSelectRemote?: () => void;
}) {
  const today = safe(view.today_fetched ?? view.today_scraped);
  const todayRemote = safe(view.today_remote);
  const total = safe(view.total_jobs);
  const remote = safe(view.total_remote);
  const extracted = safe(view.extracted_jobs);
  const needs = safe(view.needs_extraction_jobs);
  const failed = safe(view.extraction_failed_jobs);
  const pending = safe(view.extraction_pending_jobs);
  const sheetPosted = safe(view.sheet_posted_jobs);
  const pumblePosted = safe(view.pumble_posted_jobs);
  const manual = safe(view.manual_jobs);
  const teamAppliedToday = safe(view.team_applied_today);
  const lastNew = safe(view.last_sync_items_new);
  const lastScraped = safe(view.last_sync_items_scraped);
  const lastErrors = safe(view.last_sync_errors);
  const totalUsers = safe(view.total_users);
  const newUsersWeek = safe(view.new_users_week);
  const extractRatio = total > 0 ? extracted / total : 0;
  const remotePct = total > 0 ? Math.round((remote / total) * 100) : 0;
  const todayBumped = useBumpOnIncrease(today);
  const sourceCount =
    typeof view.active_sources === 'number' && view.active_sources > 0
      ? view.active_sources
      : Array.isArray(view.sources)
        ? view.sources.length
        : 0;
  const lastSyncLabel = formatLastSyncAt(view.last_sync_at);
  const lastSyncSpider = view.last_sync_spider ? String(view.last_sync_spider) : null;
  const trends = view.trends;
  const trendDayLabels = trends?.labels ?? [];
  const fetchedTrend = trends?.fetched ?? [];
  const extractedTrend = trends?.extracted ?? [];
  const trendMaxScale = Math.max(
    1,
    ...[...fetchedTrend, ...extractedTrend].map((n) =>
      Number.isFinite(n) ? Math.max(0, n) : 0,
    ),
  );

  const { left: leftRail, right: rightRail } = useMemo(() => {
    const leftSeed: RailItem[] = [
      {
        key: 'total',
        icon: Layers,
        value: total,
        label: 'Total jobs',
        tone: 'bg-gradient-to-br from-slate-700 via-slate-800 to-indigo-900 text-white',
        title: 'All non-blocked jobs in the platform pool',
        onClick: onSelectAll,
        delay: 30,
        modern: true,
      },
      {
        key: 'failed',
        icon: CircleAlert,
        value: failed,
        label:
          pending > 0
            ? `Failed · ${fmt(pending)} pending`
            : failed > 0
              ? 'Extraction failed'
              : 'Failed / stuck',
        tone: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
        title:
          pending > 0
            ? `${fmt(failed)} failed · ${fmt(pending)} still pending/processing`
            : 'Jobs whose JD extraction failed',
        onClick: onSelectExtractionFailed,
        delay: 70,
      },
      {
        key: 'manual',
        icon: Upload,
        value: manual,
        label: 'Manual intake',
        tone: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300',
        title: 'Jobs submitted by URL or attachment',
        onClick: onSelectManual,
        delay: 110,
      },
      {
        key: 'team_applied',
        icon: ClipboardCheck,
        value: teamAppliedToday,
        label: 'Apps marked today',
        tone: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
        title: 'Applications marked by any user today',
        onClick: onSelectTeamAppliedToday,
        delay: 150,
      },
    ];
    const rightSeed: RailItem[] = [
      {
        key: 'sources',
        icon: Activity,
        value: sourceCount,
        label: lastErrors > 0 ? `Sources · ${fmt(lastErrors)} errs` : 'Active sources',
        tone: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
        title: 'Configured sync platforms in System Settings',
        delay: 30,
      },
      {
        key: 'remote',
        icon: Wifi,
        value: remote,
        label: remotePct > 0 ? `Remote · ${remotePct}%` : 'Remote jobs',
        tone: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300',
        title: 'Remote-friendly jobs in the pool',
        delay: 70,
      },
    ];
    if (sheetsConfigured) {
      rightSeed.push({
        key: 'sheets',
        icon: Table2,
        value: sheetPosted,
        label: 'Sheets posted',
        tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
        title: 'Jobs posted to Google Sheets',
        onClick: onSelectSheet,
        delay: 110,
      });
    }
    if (pumbleConfigured) {
      rightSeed.push({
        key: 'pumble',
        icon: MessageSquare,
        value: pumblePosted,
        label: 'Pumble posted',
        tone: 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300',
        title: 'Jobs posted to Pumble',
        onClick: onSelectPumble,
        delay: 150,
      });
    }
    return balanceRailColumns(leftSeed, rightSeed);
  }, [
    total,
    failed,
    pending,
    manual,
    teamAppliedToday,
    sourceCount,
    lastErrors,
    remote,
    remotePct,
    sheetPosted,
    pumblePosted,
    sheetsConfigured,
    pumbleConfigured,
    onSelectAll,
    onSelectExtractionFailed,
    onSelectManual,
    onSelectTeamAppliedToday,
    onSelectSheet,
    onSelectPumble,
  ]);

  return (
    <div
      className="stats-board-shell relative w-full overflow-hidden rounded-[1.75rem] border border-slate-200/90 bg-gradient-to-br from-slate-50 via-white to-blue-50/50 p-4 shadow-sm dark:border-slate-700/80 dark:from-[#0f172a] dark:via-[#141d31] dark:to-[#172554]/45 sm:p-5"
      style={{ contentVisibility: 'auto' }}
    >
      <div className="pointer-events-none absolute -left-20 top-0 h-48 w-48 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-500/10" />
      <div className="pointer-events-none absolute -right-12 bottom-0 h-44 w-44 rounded-full bg-emerald-400/10 blur-3xl dark:bg-emerald-500/10" />

      <div className="relative grid grid-cols-1 items-stretch gap-4 xl:grid-cols-[13.5rem_minmax(0,1fr)_13.5rem] xl:gap-4">
        <div
          className={[
            'order-2 grid gap-2.5 self-stretch xl:order-1 xl:flex xl:h-full xl:min-h-0 xl:flex-col',
            railGridClass(leftRail.length),
          ].join(' ')}
        >
          {leftRail.map((item) => (
            <RailStat
              key={item.key}
              icon={item.icon}
              value={item.value}
              label={item.label}
              tone={item.tone}
              title={item.title}
              onClick={item.onClick}
              delay={item.delay}
              modern={item.modern}
            />
          ))}
        </div>

        <div className="order-1 grid h-full min-h-0 grid-cols-1 items-stretch gap-3.5 self-stretch lg:grid-cols-[1fr_auto_1fr] lg:gap-4 xl:order-2">
          <div className="flex h-full min-h-0 flex-col gap-3.5">
            <SideTile
              icon={FileSearch}
              value={needs}
              label="Extraction backlog"
              hint={
                pending > 0
                  ? `${fmt(pending)} in progress now · live unfinished pool`
                  : 'Live unfinished JD pool (not this sync\'s scrape total)'
              }
              accent="from-amber-400 to-orange-500"
              iconWrap="from-amber-500 to-orange-500"
              delay={40}
              onClick={onSelectNeedsExtraction}
              title="Jobs whose job description is still missing, pending, processing, or stuck mid-extract. Successful syncs auto-queue extraction; completed jobs leave this backlog."
              trend={fetchedTrend}
              trendLabels={trendDayLabels}
              trendColor="#fbbf24"
              trendLabel="Fetched / day"
              trendMaxScale={trendMaxScale}
            />
            <SideTile
              icon={FileCheck2}
              value={extracted}
              label="JD ready"
              hint={total > 0 ? `${Math.round(extractRatio * 100)}% of pool with completed JD` : 'Completed job descriptions'}
              accent="from-emerald-400 to-teal-500"
              iconWrap="from-emerald-500 to-teal-500"
              delay={90}
              onClick={onSelectExtracted}
              title="Jobs with a completed job description ready for applicants"
              trend={extractedTrend}
              trendLabels={trendDayLabels}
              trendColor="#34d399"
              trendLabel="JD ready / day"
              trendMaxScale={trendMaxScale}
            />
          </div>

          <button
            type="button"
            onClick={onSelectToday}
            title="Show today's fetched jobs"
            className={[
              'stats-hero-tile group relative mx-auto flex h-full min-h-[280px] w-full max-w-[280px] flex-col items-center justify-center self-stretch rounded-[2rem] border px-4 py-4 text-center transition-[border-color,box-shadow,transform,background-color] duration-300',
              'border-blue-200/80 bg-white/95 shadow-lg shadow-blue-500/10',
              'hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-xl hover:shadow-blue-500/20',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50',
              'dark:border-blue-500/30 dark:bg-[#152033]/95 dark:shadow-blue-900/25',
              todayBumped ? 'stats-hero-pulse' : '',
            ].join(' ')}
          >
            <div className="relative flex items-center justify-center">
              <HeroOrbitRing progress={extractRatio} />
              <div className="absolute inset-0 flex flex-col items-center justify-center px-8 pb-6">
                <CalendarDays size={15} className="mb-1 text-blue-500 dark:text-blue-300 stats-hero-icon-float" />
                <AnimatedNumber
                  value={today}
                  className="text-[3.1rem] font-black leading-none tracking-tight text-slate-900 dark:text-slate-50"
                />
                <span className="mt-1.5 text-[12px] font-extrabold uppercase tracking-[0.16em] text-blue-600 dark:text-blue-300">
                  Today&apos;s fetched
                </span>
              </div>
            </div>
            <div className="mt-1 flex h-[52px] flex-col justify-center space-y-1">
              <p className="truncate text-[13px] font-semibold leading-snug text-slate-600 dark:text-slate-300">
                {todayRemote > 0
                  ? `${fmt(todayRemote)} remote fetched today`
                  : lastNew > 0
                    ? `${fmt(lastNew)} new from last sync`
                    : 'New jobs added to the platform today'}
              </p>
              <p className="truncate text-[12px] font-medium text-slate-500 dark:text-slate-400">
                {fmt(extracted)} extracted · {Math.round(extractRatio * 100)}% coverage
              </p>
            </div>
          </button>

          <div className="flex h-full min-h-0 flex-col gap-3.5">
            <SideTile
              icon={Clock3}
              value={lastNew}
              label="Last check"
              hint={
                lastScraped > 0
                  ? `${lastSyncLabel} · ${fmt(lastScraped)} scraped`
                  : lastSyncLabel
              }
              accent="from-sky-400 to-blue-500"
              iconWrap="from-sky-500 to-blue-600"
              delay={40}
              title={
                lastSyncSpider
                  ? `Last sync (${lastSyncSpider}): ${fmt(lastNew)} new · ${fmt(lastScraped)} scraped`
                  : `Last sync: ${fmt(lastNew)} new job(s)`
              }
            />
            <SideTile
              icon={Users}
              value={totalUsers}
              label="Total users"
              hint={
                newUsersWeek > 0
                  ? `${fmt(newUsersWeek)} new this week`
                  : 'No new signups this week'
              }
              accent="from-indigo-400 to-blue-500"
              iconWrap="from-indigo-500 to-blue-600"
              delay={90}
              title={`${fmt(totalUsers)} accounts · ${fmt(newUsersWeek)} created in the last 7 days`}
            />
          </div>
        </div>

        <div
          className={[
            'order-3 grid gap-2.5 self-stretch xl:flex xl:h-full xl:min-h-0 xl:flex-col',
            railGridClass(rightRail.length),
          ].join(' ')}
        >
          {rightRail.map((item) => (
            <RailStat
              key={item.key}
              icon={item.icon}
              value={item.value}
              label={item.label}
              tone={item.tone}
              title={item.title}
              onClick={item.onClick}
              delay={item.delay}
              modern={item.modern}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

export const ScraperStatsBar = memo(function ScraperStatsBar({
  stats,
  adminStats,
  loading,
  variant = 'applicant',
  sheetsConfigured: sheetsConfiguredProp,
  pumbleConfigured: pumbleConfiguredProp,
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
  onSelectNeedsExtraction,
  onSelectExtracted,
  onSelectExtractionFailed,
  onSelectManual,
  onSelectTeamAppliedToday,
}: ScraperStatsBarProps) {
  const isAdmin = variant === 'admin';
  const cachedApplicantRef = useRef<ScraperStats | null>(null);
  const cachedAdminRef = useRef<AdminScraperStats | null>(null);
  if (stats) cachedApplicantRef.current = stats;
  if (adminStats) cachedAdminRef.current = adminStats;
  const applicantView = stats ?? cachedApplicantRef.current;
  const adminView = adminStats ?? cachedAdminRef.current;

  const [sheetsConfiguredLocal, setSheetsConfiguredLocal] = useState(false);
  const [pumbleConfiguredLocal, setPumbleConfiguredLocal] = useState(false);

  // Resolve optional integrations for both applicant and admin boards.
  useEffect(() => {
    if (sheetsConfiguredProp !== undefined && pumbleConfiguredProp !== undefined) return;
    let cancelled = false;
    void fetchSheetsConfig()
      .then((config) => {
        if (!cancelled) setSheetsConfiguredLocal(Boolean(config.configured));
      })
      .catch(() => {
        if (!cancelled) setSheetsConfiguredLocal(false);
      });
    void fetchPumbleConfig()
      .then((config) => {
        if (cancelled) return;
        const integrations = (config.integrations ?? []).filter((i) => i.is_enabled !== false);
        setPumbleConfiguredLocal(integrations.length > 0 || Boolean(config.configured));
      })
      .catch(() => {
        if (!cancelled) setPumbleConfiguredLocal(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sheetsConfiguredProp, pumbleConfiguredProp]);

  const sheetsConfigured = sheetsConfiguredProp ?? sheetsConfiguredLocal;
  const pumbleConfigured = pumbleConfiguredProp ?? pumbleConfiguredLocal;

  if (isAdmin) {
    if (!adminView) {
      return <StatsBoardSkeleton label={loading ? 'Loading platform status…' : 'Loading platform status…'} />;
    }
    return (
      <AdminStatsBoardContent
        view={adminView}
        sheetsConfigured={sheetsConfigured}
        pumbleConfigured={pumbleConfigured}
        onSelectToday={onSelectToday}
        onSelectNeedsExtraction={onSelectNeedsExtraction}
        onSelectExtracted={onSelectExtracted}
        onSelectSheet={onSelectSheet}
        onSelectPumble={onSelectPumble}
        onSelectExtractionFailed={onSelectExtractionFailed}
        onSelectManual={onSelectManual}
        onSelectTeamAppliedToday={onSelectTeamAppliedToday}
        onSelectAll={onSelectAll}
        onSelectRemote={onSelectRemote}
      />
    );
  }

  if (!applicantView) {
    return <StatsBoardSkeleton />;
  }

  return (
    <StatsBoardContent
      view={applicantView}
      sheetsConfigured={sheetsConfigured}
      pumbleConfigured={pumbleConfigured}
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
