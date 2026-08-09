import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Rocket,
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
import type { AdminScraperStats, PlatformSyncStats, ScraperStats } from '../../types/scraper';
import { fetchSheetsConfig } from '../../api/googleSheetsApi';
import { fetchPumbleConfig } from '../../api/pumbleApi';
import { useScraperStore } from '../../stores/scraperStore';
import { TrendSparkline } from './TrendSparkline';
import { SyncControlBoard } from './SyncControlBoard';

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

interface PlatformRailItem {
  key: string;
  platform: PlatformSyncStats;
  delay: number;
  onClick?: () => void;
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
  // w-max + shrink-0: when placed beside sync hints, the count never collapses
  // under neighboring text (which looked like an overlap on platform tiles).
  return (
    <span
      className={[
        'inline-flex h-[1.05em] w-max max-w-none shrink-0 items-center overflow-hidden tabular-nums',
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
  failProgress = 0,
  /** When false, hide the traveling loading highlight — work is settled. Orbit dots keep moving. */
  showShimmer = true,
  size = 188,
}: {
  /** Share of the ring for successful / completed JD (blue). */
  progress: number;
  /** Share of the ring for extraction-failed jobs (red). */
  failProgress?: number;
  showShimmer?: boolean;
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

  // Clamp and normalize so blue + red never exceed a full turn.
  let success = Math.max(0, safe(progress));
  let fail = Math.max(0, safe(failProgress));
  const combined = success + fail;
  if (combined > 1) {
    success /= combined;
    fail /= combined;
  }

  const successLen = circumference * success;
  const failLen = circumference * fail;
  const hasFail = failLen > 0.5;
  const hasSuccess = successLen > 0.5;
  // Single-arc keeps rounded caps; multi-arc uses butt so segments don't bleed into each other.
  const cap = hasFail && hasSuccess ? 'butt' : 'round';
  const orbitR = radius + 14;

  return (
    <div className="stats-hero-orbit relative" style={{ width: full, height: full }}>
      <div className="stats-hero-aura absolute inset-5 rounded-full" />
      <div className="stats-hero-aura-core absolute inset-11 rounded-full" />
      {/* Decorative orbit dots — always animate, even when extraction is settled. */}
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
          <linearGradient id={`stats-ring-fail-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#fb7185" />
            <stop offset="55%" stopColor="#f43f5e" />
            <stop offset="100%" stopColor="#e11d48" />
          </linearGradient>
          <linearGradient id={`stats-ring-fail-glow-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#fda4af" stopOpacity="0.2" />
            <stop offset="50%" stopColor="#fb7185" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#e11d48" stopOpacity="0.25" />
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
          {/* Track = remaining pool (needs extraction / pending). */}
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            className="stroke-slate-200/90 dark:stroke-slate-700/90"
          />

          {/* Success (completed JD) — blue, starts at 12 o'clock. */}
          {hasSuccess && (
            <>
              <circle
                cx={cx}
                cy={cy}
                r={radius}
                fill="none"
                strokeWidth={stroke + 5}
                strokeLinecap={cap}
                strokeDasharray={`${successLen} ${Math.max(0, circumference - successLen)}`}
                strokeDashoffset={0}
                stroke={`url(#stats-ring-glow-${uid})`}
                className="stats-ring-progress opacity-45 transition-[stroke-dasharray] duration-700 ease-out"
              />
              <circle
                cx={cx}
                cy={cy}
                r={radius}
                fill="none"
                strokeWidth={stroke}
                strokeLinecap={cap}
                strokeDasharray={`${successLen} ${Math.max(0, circumference - successLen)}`}
                strokeDashoffset={0}
                stroke={`url(#stats-ring-grad-${uid})`}
                filter={`url(#stats-soft-glow-${uid})`}
                className="stats-ring-progress transition-[stroke-dasharray] duration-700 ease-out"
              />
            </>
          )}

          {/* Failed extractions — red, continues after the blue arc. */}
          {hasFail && (
            <>
              <circle
                cx={cx}
                cy={cy}
                r={radius}
                fill="none"
                strokeWidth={stroke + 5}
                strokeLinecap={cap}
                strokeDasharray={`${failLen} ${Math.max(0, circumference - failLen)}`}
                strokeDashoffset={-successLen}
                stroke={`url(#stats-ring-fail-glow-${uid})`}
                className="stats-ring-progress opacity-40 transition-[stroke-dasharray,stroke-dashoffset] duration-700 ease-out"
              />
              <circle
                cx={cx}
                cy={cy}
                r={radius}
                fill="none"
                strokeWidth={stroke}
                strokeLinecap={cap}
                strokeDasharray={`${failLen} ${Math.max(0, circumference - failLen)}`}
                strokeDashoffset={-successLen}
                stroke={`url(#stats-ring-fail-${uid})`}
                filter={`url(#stats-soft-glow-${uid})`}
                className="stats-ring-progress transition-[stroke-dasharray,stroke-dashoffset] duration-700 ease-out"
              />
            </>
          )}

          {/* Traveling highlight only while extraction backlog remains. */}
          {showShimmer && (
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
          )}
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
    // min-w-0 + overflow-hidden: tiles shrink inside fractional grid tracks instead of
    // overflowing neighboring columns (the source of the stats-board overlap).
    'stats-side-tile group relative flex min-h-[76px] w-full min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-2xl border px-3 py-2.5 text-left shadow-sm transition-[border-color,box-shadow,transform,background-color] duration-300 sm:min-h-[84px] sm:gap-3 sm:px-4 sm:py-3 2xl:min-h-[92px] 2xl:gap-4 2xl:px-5 2xl:py-3.5',
    'border-slate-200/90 bg-white/95 dark:border-slate-700/80 dark:bg-[#141d31]/95',
    onClick
      ? 'cursor-pointer hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 dark:hover:border-slate-500'
      : '',
  ].join(' ');

  const body = (
    <>
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${accent} opacity-[0.08] transition-opacity duration-300 group-hover:opacity-[0.16]`} />
      <div className={`absolute inset-y-4 left-0 w-1 rounded-r-full bg-gradient-to-b ${accent}`} />
      <div className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${iconWrap} text-white shadow-lg transition-transform duration-300 group-hover:scale-105 sm:h-10 sm:w-10 2xl:h-12 2xl:w-12`}>
        <Icon size={18} strokeWidth={2.35} />
      </div>
      <div className="relative min-w-0 flex-[1.05]">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 sm:gap-x-3">
          <AnimatedNumber
            value={value}
            className="text-[1.45rem] font-black leading-none tracking-tight text-slate-900 sm:text-[1.65rem] 2xl:text-[1.9rem]"
          />
          <p
            className="min-w-0 truncate text-[10.5px] font-medium leading-snug text-slate-500 sm:text-[11px] 2xl:text-[11.5px]"
            title={hint}
          >
            {hint}
          </p>
        </div>
        <p className="mt-1 truncate text-[12px] font-bold leading-none text-slate-700 sm:mt-1.5 sm:text-[13px] 2xl:text-[14px]">
          {label}
        </p>
      </div>
      {/* Sparklines need horizontal room — hide before 2xl so tiles don't crush neighbors. */}
      {Array.isArray(trend) && trend.length > 0 ? (
        <div className="relative hidden min-w-0 flex-1 self-stretch pl-0.5 2xl:block 2xl:pl-1">
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

/** Narrow metric for admin board — frees horizontal space for the sync control panel. */
const CompactMetricTile = memo(function CompactMetricTile({
  icon: Icon,
  value,
  label,
  hint,
  accent,
  iconWrap,
  delay,
  title,
}: {
  icon: LucideIcon;
  value: number;
  label: string;
  hint: string;
  accent: string;
  iconWrap: string;
  delay: number;
  title?: string;
}) {
  return (
    <div
      title={title}
      style={{ animationDelay: `${delay}ms` }}
      className="stats-side-tile group relative flex min-h-[88px] w-full flex-1 flex-col justify-center overflow-hidden rounded-2xl border border-slate-200/90 bg-white/95 px-3 py-2.5 shadow-sm dark:border-slate-700/80 dark:bg-[#141d31]/95"
    >
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${accent} opacity-[0.08]`} />
      <div className={`absolute inset-y-3 left-0 w-1 rounded-r-full bg-gradient-to-b ${accent}`} />
      <div className="relative flex min-w-0 items-center gap-2">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${iconWrap} text-white shadow-md`}
        >
          <Icon size={15} strokeWidth={2.4} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-bold leading-none text-slate-600 dark:text-[#cbd5e1]">
            {label}
          </p>
          <AnimatedNumber
            value={value}
            className="mt-1 block text-[1.35rem] font-black leading-none tracking-tight text-slate-900"
          />
          <p className="mt-1 truncate text-[10px] font-medium leading-snug text-slate-500" title={hint}>
            {hint}
          </p>
        </div>
      </div>
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
    'stats-rail-stat group flex min-h-[58px] w-full min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-2xl border px-2.5 py-2.5 text-left transition-[border-color,box-shadow,transform,background-color] duration-300 sm:min-h-[64px] sm:gap-3 sm:px-3 sm:py-3 2xl:min-h-[68px]',
    'border-slate-200/80 bg-white/85 dark:border-slate-700/70 dark:bg-[#101827]/85',
    onClick
      ? 'cursor-pointer hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 dark:hover:border-slate-500'
      : '',
  ].join(' ');

  const body = (
    <>
      <div
        className={[
          'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl shadow-sm transition-transform duration-300 group-hover:scale-105 sm:h-10 sm:w-10 2xl:h-11 2xl:w-11',
          tone,
          modern ? 'stats-total-icon' : '',
        ].join(' ')}
      >
        {modern ? (
          <>
            <span className="stats-total-icon-glow absolute inset-0 rounded-xl" />
            <Layers size={18} strokeWidth={2.2} className="relative" />
          </>
        ) : (
          <Icon size={16} strokeWidth={2.4} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <AnimatedNumber
          value={value}
          className="text-[1.25rem] font-black leading-none tracking-tight text-slate-900 sm:text-[1.35rem] 2xl:text-[1.45rem]"
        />
        <p className="mt-0.5 truncate text-[10.5px] font-semibold text-slate-500 sm:mt-1 sm:text-[11.5px]">
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
  /** Admin: filter the job list to one registered sync platform. */
  onSelectPlatform?: (source: string) => void;
}

function StatsBoardSkeleton({ label = 'Loading your job status…' }: { label?: string }) {
  return (
    <div className="stats-board-shell flex min-h-[220px] w-full items-center justify-center rounded-[1.75rem] border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-[#141d31]" style={{ contentVisibility: 'auto' }}>
      <div className="flex items-center gap-3 text-base font-medium text-slate-400">
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
  const todayReady = safe(view.today_ready_jobs ?? 0);
  const todayAvailable = safe(view.today_available_jobs ?? 0);
  const good = safe(view.good_jobs ?? 0);
  const qualified = safe(view.qualified_jobs ?? good);
  const scored = safe(view.scored_jobs ?? 0);
  const avgScore = safe(view.avg_match_score ?? 0);
  const remote = safe(view.total_remote);
  const total = safe(view.total_jobs);
  const myJobs = safe(view.my_jobs);
  const available = safe(view.available_jobs ?? 0);
  const applied = safe(view.applied_jobs ?? 0);
  const appliedToday = safe(view.applied_today ?? 0);
  const sheetPosted = safe(view.sheet_posted_jobs ?? 0);
  const pumblePosted = safe(view.pumble_posted_jobs ?? 0);
  // Hero ring is today's work only: today ready / today upcoming.
  const todayReadyRatio =
    todayAvailable > 0
      ? Math.min(1, todayReady / todayAvailable)
      : todayReady > 0
        ? 1
        : 0;
  const appliedRatio = total > 0 ? applied / total : 0;
  const remotePct = total > 0 ? Math.round((remote / total) * 100) : 0;
  const todayBumped = useBumpOnIncrease(today);
  const trends = view.trends;
  const trendDayLabels = trends?.labels ?? [];
  const readyTrend = trends?.ready ?? [];
  const remoteTrend = trends?.remote ?? [];
  const availableTrend = trends?.available ?? [];
  // One Y-domain for side sparklines so absolute daily peaks compare fairly.
  const trendMaxScale = Math.max(
    1,
    ...[...readyTrend, ...remoteTrend, ...availableTrend].map((n) =>
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
    <div className="stats-board-shell relative w-full min-w-0 overflow-hidden rounded-[1.75rem] border border-slate-200/90 bg-gradient-to-br from-slate-50 via-white to-blue-50/50 p-3 shadow-sm dark:border-slate-700/80 dark:from-[#0f172a] dark:via-[#141d31] dark:to-[#172554]/45 sm:p-4 2xl:p-5">
      <div className="pointer-events-none absolute -left-20 top-0 h-48 w-48 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-500/10" />
      <div className="pointer-events-none absolute -right-12 bottom-0 h-44 w-44 rounded-full bg-emerald-400/10 blur-3xl dark:bg-emerald-500/10" />

      {/*
        Progressive layout to avoid mid-width crush/overlap:
        - <2xl: hero + side tiles on top; rails wrap below as a grid
        - 2xl+: side rails flank the center (fluid minmax tracks, never fixed rem)
      */}
      <div className="relative grid min-w-0 grid-cols-1 items-stretch gap-3 2xl:grid-cols-[minmax(0,10.5rem)_minmax(0,1fr)_minmax(0,10.5rem)] 2xl:gap-3">
        <div
          className={[
            'order-2 grid min-w-0 gap-2.5 self-stretch 2xl:order-1 2xl:flex 2xl:h-full 2xl:min-h-0 2xl:flex-col',
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

        <div className="order-1 grid h-full min-h-0 min-w-0 grid-cols-1 items-stretch gap-3 self-stretch lg:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] lg:gap-3 2xl:order-2 2xl:gap-4">
          <div className="flex h-full min-h-0 min-w-0 flex-col gap-2.5 sm:gap-3 2xl:gap-3.5">
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
              icon={ClipboardCheck}
              value={applied}
              label="Applied jobs"
              hint={
                appliedToday > 0
                  ? `${fmt(appliedToday)} today · ${Math.round(appliedRatio * 100)}% of pool`
                  : total > 0
                    ? `${Math.round(appliedRatio * 100)}% of your pool`
                    : 'Jobs you marked as applied'
              }
              accent="from-sky-400 to-blue-500"
              iconWrap="from-sky-500 to-blue-600"
              delay={90}
              onClick={onSelectApplied}
              title="Jobs you marked as applied"
              trendLabel="Applied jobs"
              trendMaxScale={trendMaxScale}
            />
          </div>

          <button
            type="button"
            onClick={onSelectToday}
            title="Show today's new jobs"
            className={[
              'stats-hero-tile group relative mx-auto flex h-full min-h-[180px] w-full min-w-0 max-w-[220px] flex-col items-center justify-center self-stretch overflow-hidden rounded-[1.75rem] border px-3 py-2.5 text-center transition-[border-color,box-shadow,transform,background-color] duration-300 sm:min-h-[200px] sm:max-w-[240px] sm:rounded-[2rem] sm:px-4 sm:py-3 2xl:min-h-[220px] 2xl:max-w-[280px]',
              'border-blue-200/80 bg-white/95 shadow-lg shadow-blue-500/10',
              'hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-xl hover:shadow-blue-500/20',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50',
              'dark:border-blue-500/30 dark:bg-[#152033]/95 dark:shadow-blue-900/25',
              todayBumped ? 'stats-hero-pulse' : '',
            ].join(' ')}
          >
            <div className="relative mx-auto h-[175px] w-[175px] shrink-0 sm:h-[197px] sm:w-[197px] 2xl:h-[224px] 2xl:w-[224px]">
              <div className="absolute left-1/2 top-1/2 origin-center -translate-x-1/2 -translate-y-1/2 scale-[0.78] sm:scale-[0.88] 2xl:scale-100">
                <HeroOrbitRing
                  progress={todayReadyRatio}
                  showShimmer={todayAvailable > 0 && todayReadyRatio < 1}
                />
              </div>
              <div className="absolute inset-0 flex flex-col items-center justify-center px-4 pb-3 sm:px-5 sm:pb-4 2xl:px-8 2xl:pb-6">
                <CalendarDays size={15} className="mb-1 text-blue-500 dark:text-blue-300 stats-hero-icon-float" />
                <AnimatedNumber
                  value={today}
                  className="text-[2.35rem] font-black leading-none tracking-tight text-slate-900 sm:text-[2.7rem] 2xl:text-[3.1rem]"
                />
                <span className="mt-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-blue-600 dark:text-blue-300 sm:mt-1.5 sm:text-[11px] sm:tracking-[0.16em] 2xl:text-[12px]">
                  Today&apos;s jobs
                </span>
              </div>
            </div>
            <div className="mt-0.5 flex h-[40px] w-full min-w-0 flex-col justify-center space-y-0.5 sm:mt-1 sm:h-[44px]">
              <p className="truncate text-[11px] font-semibold leading-snug text-slate-600 sm:text-[12px] 2xl:text-[13px]">
                {today > 0
                  ? `${fmt(todayReady)} ready / ${fmt(todayAvailable)} upcoming`
                  : todayRemote > 0
                    ? `${fmt(todayRemote)} remote added today`
                    : 'No jobs added to your board today'}
              </p>
              <p className="truncate text-[10.5px] font-medium text-slate-500 sm:text-[11px] 2xl:text-[12px]">
                {today > 0
                  ? `${Math.round(todayReadyRatio * 100)}% ready vs upcoming today`
                  : appliedToday > 0
                    ? `${fmt(appliedToday)} applied today · ${fmt(applied)} total`
                    : `${fmt(applied)} applied · ${Math.round(appliedRatio * 100)}% of pool`}
              </p>
            </div>
          </button>

          <div className="flex h-full min-h-0 min-w-0 flex-col gap-2.5 sm:gap-3 2xl:gap-3.5">
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
              label="Upcoming jobs"
              hint="JD ready · run match / tailor / resume"
              accent="from-violet-400 to-indigo-500"
              iconWrap="from-violet-500 to-indigo-600"
              delay={90}
              onClick={onSelectAvailable}
              title="Jobs with an extracted job description that still need analyze / tailor / resume build"
              trend={availableTrend}
              trendLabels={trendDayLabels}
              trendColor="#a78bfa"
              trendLabel="Upcoming jobs"
              trendMaxScale={trendMaxScale}
            />
          </div>
        </div>

        <div
          className={[
            'order-3 grid min-w-0 gap-2.5 self-stretch 2xl:flex 2xl:h-full 2xl:min-h-0 2xl:flex-col',
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
  if (!iso) return 'Never synced';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return 'Never synced';
  }
}

function formatRelativeSync(iso: string | null | undefined): string {
  if (!iso) return 'Never synced';
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return 'Never synced';
    const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (diffSec < 60) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
    return formatLastSyncAt(iso);
  } catch {
    return 'Never synced';
  }
}

const PLATFORM_TONES = [
  'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
  'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300',
];

const PlatformSyncRail = memo(function PlatformSyncRail({
  platform,
  delay = 0,
  tone,
  onClick,
  compact = false,
}: {
  platform: PlatformSyncStats;
  delay?: number;
  tone: string;
  onClick?: () => void;
  /** Narrow column (~⅓ prior width): stack icon / label / count. */
  compact?: boolean;
}) {
  const jobs = safe(platform.job_count);
  const added = safe(platform.last_items_new);
  const scraped = safe(platform.last_items_scraped);
  const errors = safe(platform.last_errors);
  const status = (platform.last_status || '').toLowerCase();
  const relative = formatRelativeSync(platform.last_sync_at);
  const detailParts: string[] = [];
  if (platform.last_sync_at) {
    detailParts.push(relative);
    if (added > 0) detailParts.push(`+${fmt(added)} new`);
    else if (scraped > 0) detailParts.push(`${fmt(scraped)} scraped`);
    if (errors > 0) detailParts.push(`${fmt(errors)} err`);
  } else {
    detailParts.push('No sync yet');
  }
  const detail = detailParts.join(' · ');
  const statusDot =
    status === 'running'
      ? 'bg-sky-400'
      : status === 'failed' || errors > 0
        ? 'bg-rose-400'
        : platform.last_sync_at
          ? 'bg-emerald-400'
          : 'bg-slate-400';

  const className = [
    'stats-rail-stat group flex min-h-[58px] w-full min-w-0 flex-1 overflow-hidden rounded-2xl border text-left transition-[border-color,box-shadow,transform,background-color] duration-300',
    compact ? 'flex-col items-stretch gap-1.5 px-2 py-2' : 'items-center gap-3 px-3 py-2.5',
    'border-slate-200/80 bg-white/85 dark:border-slate-700/70 dark:bg-[#101827]/85',
    onClick
      ? 'cursor-pointer hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 dark:hover:border-slate-500'
      : '',
  ].join(' ');

  const body = compact ? (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <div
          className={[
            'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg shadow-sm',
            tone,
          ].join(' ')}
        >
          <Activity size={13} strokeWidth={2.4} />
          <span
            className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-white dark:ring-[#101827] ${statusDot}`}
          />
        </div>
        <p className="min-w-0 truncate text-[10px] font-bold leading-tight text-slate-800" title={platform.label}>
          {platform.label}
        </p>
      </div>
      <AnimatedNumber
        value={jobs}
        className="block text-[1.15rem] font-black leading-none tracking-tight text-slate-900"
      />
      <p
        className="min-w-0 truncate text-[9px] font-medium leading-none text-slate-500"
        title={formatLastSyncAt(platform.last_sync_at)}
      >
        {detail}
      </p>
    </>
  ) : (
    <>
      <div
        className={[
          'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm transition-transform duration-300 group-hover:scale-105',
          tone,
        ].join(' ')}
      >
        <Activity size={17} strokeWidth={2.4} />
        <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-[#101827] ${statusDot}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-bold leading-none text-slate-800">
          {platform.label}
        </p>
        <div className="mt-1.5 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3">
          <AnimatedNumber
            value={jobs}
            className="text-[1.25rem] font-black leading-none tracking-tight text-slate-900"
          />
          <p
            className="min-w-0 truncate text-[11px] font-medium leading-none text-slate-500"
            title={formatLastSyncAt(platform.last_sync_at)}
          >
            {detail}
          </p>
        </div>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`${platform.label}: ${fmt(jobs)} jobs in pool · last sync ${relative}`}
        style={{ animationDelay: `${delay}ms` }}
        className={className}
      >
        {body}
      </button>
    );
  }

  return (
    <div
      title={`${platform.label}: ${fmt(jobs)} jobs in pool · last sync ${relative}`}
      style={{ animationDelay: `${delay}ms` }}
      className={className}
    >
      {body}
    </div>
  );
});

const AdminStatsBoardContent = memo(function AdminStatsBoardContent({
  view,
  onSelectToday,
  onSelectNeedsExtraction,
  onSelectExtracted,
  onSelectExtractionFailed,
  onSelectManual,
  onSelectAll,
  onSelectPlatform,
}: {
  view: AdminScraperStats;
  onSelectToday?: () => void;
  onSelectNeedsExtraction?: () => void;
  onSelectExtracted?: () => void;
  onSelectExtractionFailed?: () => void;
  onSelectManual?: () => void;
  onSelectAll?: () => void;
  onSelectPlatform?: (source: string) => void;
}) {
  const today = safe(view.today_fetched ?? view.today_scraped);
  const total = safe(view.total_jobs);
  const extracted = safe(view.extracted_jobs);
  const needs = safe(view.needs_extraction_jobs);
  const failed = safe(view.extraction_failed_jobs);
  const pending = safe(view.extraction_pending_jobs);
  const manual = safe(view.manual_jobs);
  const lastNew = safe(view.last_sync_items_new);
  const lastScraped = safe(view.last_sync_items_scraped);
  const totalUsers = safe(view.total_users);
  const newUsersWeek = safe(view.new_users_week);
  const extractRatio = total > 0 ? extracted / total : 0;
  const failRatio = total > 0 ? failed / total : 0;
  const todayBumped = useBumpOnIncrease(today);
  const platforms = Array.isArray(view.platform_sync) ? view.platform_sync : [];
  const lastSyncLabel = formatLastSyncAt(view.last_sync_at);
  const lastSyncSpider = view.last_sync_spider ? String(view.last_sync_spider) : null;
  const syncing = useScraperStore((s) => s.syncing);
  const syncProgress = useScraperStore((s) => s.syncProgress);
  const lastCheckHint = syncing
    ? syncProgress?.total
      ? `Syncing ${syncProgress.current}/${syncProgress.total} · ${syncProgress.itemsNew} new`
      : syncProgress?.message || 'Sync in progress…'
    : lastScraped > 0
      ? `${lastSyncLabel} · ${fmt(lastScraped)} scraped`
      : lastSyncLabel;
  const lastCheckTitle = syncing
    ? syncProgress?.message || 'Job fetch in progress — same run as Job fetch panel'
    : lastSyncSpider
      ? `Last sync (${lastSyncSpider}): ${fmt(lastNew)} new · ${fmt(lastScraped)} scraped`
      : `Last sync: ${fmt(lastNew)} new job(s)`;
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

  const leftRail = useMemo(() => {
    const items: RailItem[] = [
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
    ];
    return items;
  }, [
    total,
    failed,
    pending,
    manual,
    onSelectAll,
    onSelectExtractionFailed,
    onSelectManual,
  ]);

  const platformRails: PlatformRailItem[] = useMemo(
    () =>
      platforms.map((platform, index) => ({
        key: platform.name,
        platform,
        delay: 30 + index * 40,
        onClick: onSelectPlatform
          ? () => onSelectPlatform(platform.name)
          : undefined,
      })),
    [platforms, onSelectPlatform],
  );

  return (
    <div className="flex w-full min-w-0 flex-col gap-3.5 2xl:flex-row 2xl:items-stretch">
      {/* ── Main statistics board (flex-2; shares row, leftover → Job fetch) */}
      <div
        className="stats-board-shell relative flex w-full min-w-0 flex-col overflow-hidden rounded-[1.75rem] border border-slate-200/90 bg-gradient-to-br from-slate-50 via-white to-blue-50/50 p-3 shadow-sm dark:border-slate-700/80 dark:from-[#0f172a] dark:via-[#141d31] dark:to-[#172554]/45 sm:p-4 2xl:flex-[5] 2xl:basis-0 2xl:p-5"
        style={{ contentVisibility: 'auto' }}
      >
        <div className="pointer-events-none absolute -left-20 top-0 h-48 w-48 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-500/10" />
        <div className="pointer-events-none absolute -right-12 bottom-0 h-44 w-44 rounded-full bg-emerald-400/10 blur-3xl dark:bg-emerald-500/10" />

        <div className="relative grid min-h-0 min-w-0 flex-1 grid-cols-1 items-stretch gap-3 2xl:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] 2xl:gap-3">
          <div
            className={[
              'order-2 grid min-w-0 gap-2.5 self-stretch 2xl:order-1 2xl:flex 2xl:h-full 2xl:min-h-0 2xl:flex-col',
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

          {/*
            Fractional tracks (minmax(0,fr)) + min-w-0 children: columns scale
            down instead of overflowing the overflow-hidden shell, so the
            platform rails can never be clipped. Backlog/JD get 1.5fr weight;
            Last check + platform rails share 1fr each.
          */}
          <div className="order-1 grid h-full min-h-0 min-w-0 grid-cols-1 items-stretch gap-3 self-stretch lg:grid-cols-[minmax(0,1.5fr)_minmax(0,auto)_minmax(0,1fr)_minmax(0,1fr)] lg:gap-2.5 2xl:order-2 2xl:gap-3">
            <div className="flex h-full min-h-0 min-w-0 flex-col gap-2.5 sm:gap-3 2xl:gap-3.5">
              <SideTile
                icon={FileSearch}
                value={needs}
                label="Extraction backlog"
                hint={
                  pending > 0
                    ? `${fmt(pending)} extracting now`
                    : 'Unfinished JD pool'
                }
                accent="from-amber-400 to-orange-500"
                iconWrap="from-amber-500 to-orange-500"
                delay={40}
                onClick={onSelectNeedsExtraction}
                title="Live unfinished JD pool — jobs still missing, pending, processing, or stuck mid-extract (not this sync's scrape total)."
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
                hint={total > 0 ? `${Math.round(extractRatio * 100)}% of pool` : 'Completed JDs'}
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
                'stats-hero-tile group relative mx-auto flex h-full min-h-[180px] w-full min-w-0 max-w-[200px] flex-col items-center justify-center self-stretch overflow-hidden rounded-[1.75rem] border px-3 py-2.5 text-center transition-[border-color,box-shadow,transform,background-color] duration-300 sm:min-h-[200px] sm:max-w-[220px] sm:rounded-[2rem] sm:px-4 sm:py-3 2xl:min-h-[220px] 2xl:max-w-[280px]',
                'border-blue-200/80 bg-white/95 shadow-lg shadow-blue-500/10',
                'hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-xl hover:shadow-blue-500/20',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50',
                'dark:border-blue-500/30 dark:bg-[#152033]/95 dark:shadow-blue-900/25',
                todayBumped ? 'stats-hero-pulse' : '',
              ].join(' ')}
            >
              <div className="relative mx-auto h-[161px] w-[161px] shrink-0 sm:h-[184px] sm:w-[184px] 2xl:h-[224px] 2xl:w-[224px]">
                <div className="absolute left-1/2 top-1/2 origin-center -translate-x-1/2 -translate-y-1/2 scale-[0.72] sm:scale-[0.82] 2xl:scale-100">
                  <HeroOrbitRing
                    progress={extractRatio}
                    failProgress={failRatio}
                    showShimmer={needs > 0 || pending > 0}
                  />
                </div>
                <div className="absolute inset-0 flex flex-col items-center justify-center px-3 pb-3 sm:px-4 sm:pb-4 2xl:px-8 2xl:pb-6">
                  <CalendarDays size={15} className="mb-1 text-blue-500 stats-hero-icon-float" />
                  <AnimatedNumber
                    value={today}
                    className="text-[2.2rem] font-black leading-none tracking-tight text-slate-900 sm:text-[2.55rem] 2xl:text-[3.1rem]"
                  />
                  <span className="mt-1 text-[10px] font-extrabold uppercase tracking-[0.12em] text-blue-600 sm:mt-1.5 sm:text-[11px] sm:tracking-[0.16em] 2xl:text-[12px]">
                    Today&apos;s fetched
                  </span>
                </div>
              </div>
              <div className="mt-0.5 flex h-[40px] w-full min-w-0 flex-col justify-center space-y-0.5 sm:mt-1 sm:h-[44px]">
                <p className="truncate text-[11px] font-semibold leading-snug text-slate-600 sm:text-[12px] 2xl:text-[13px]">
                  {lastNew > 0
                    ? `${fmt(lastNew)} new from last sync`
                    : platforms.length > 0
                      ? `${platforms.length} job sites registered`
                      : 'New jobs added to the platform today'}
                </p>
                <p
                  className="truncate text-[10.5px] font-medium text-slate-500 sm:text-[11px] 2xl:text-[12px]"
                  title={
                    failed > 0
                      ? `${fmt(extracted)} JD ready · ${fmt(failed)} extraction failed · ${fmt(needs)} still need extraction`
                      : `${fmt(extracted)} JD ready · ${Math.round(extractRatio * 100)}% coverage`
                  }
                >
                  {failed > 0
                    ? `${fmt(extracted)} ready · ${fmt(failed)} failed`
                    : `${fmt(extracted)} JD ready · ${Math.round(extractRatio * 100)}% coverage`}
                </p>
              </div>
            </button>

            <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-2.5">
              <CompactMetricTile
                icon={Clock3}
                value={syncing ? (syncProgress?.itemsNew ?? lastNew) : lastNew}
                label="Last check"
                hint={lastCheckHint}
                accent="from-sky-400 to-blue-500"
                iconWrap="from-sky-500 to-blue-600"
                delay={40}
                title={lastCheckTitle}
              />
              <CompactMetricTile
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

            <div
              className={[
                'grid min-w-0 gap-2.5 self-stretch 2xl:flex 2xl:h-full 2xl:min-h-0 2xl:w-full 2xl:flex-col',
                railGridClass(Math.max(platformRails.length, 1)),
              ].join(' ')}
            >
              {platformRails.length > 0 ? (
                platformRails.map((item, index) => (
                  <PlatformSyncRail
                    key={item.key}
                    platform={item.platform}
                    delay={item.delay}
                    tone={PLATFORM_TONES[index % PLATFORM_TONES.length]}
                    onClick={item.onClick}
                  />
                ))
              ) : (
                <div className="flex min-h-[72px] flex-1 items-center justify-center rounded-2xl border border-dashed border-slate-300 px-2 text-center text-[10px] font-medium text-slate-500 dark:border-slate-600">
                  No sites
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Job fetch: takes the remaining screen width ───────────────── */}
      <aside className="flex w-full min-w-0 flex-[2] basis-0 2xl:min-h-0 2xl:min-w-[16rem] 2xl:self-stretch">
        <div className="flex h-full min-h-[200px] w-full min-w-0 flex-1 2xl:min-h-[220px]">
          <SyncControlBoard />
        </div>
      </aside>
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
  onSelectPlatform,
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

  // Resolve optional Sheets/Pumble integrations for the applicant board only.
  useEffect(() => {
    if (isAdmin) return;
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
  }, [isAdmin, sheetsConfiguredProp, pumbleConfiguredProp]);

  const sheetsConfigured = sheetsConfiguredProp ?? sheetsConfiguredLocal;
  const pumbleConfigured = pumbleConfiguredProp ?? pumbleConfiguredLocal;

  if (isAdmin) {
    if (!adminView) {
      return <StatsBoardSkeleton label={loading ? 'Loading platform status…' : 'Loading platform status…'} />;
    }
    return (
      <AdminStatsBoardContent
        view={adminView}
        onSelectToday={onSelectToday}
        onSelectNeedsExtraction={onSelectNeedsExtraction}
        onSelectExtracted={onSelectExtracted}
        onSelectExtractionFailed={onSelectExtractionFailed}
        onSelectManual={onSelectManual}
        onSelectAll={onSelectAll}
        onSelectPlatform={onSelectPlatform}
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
