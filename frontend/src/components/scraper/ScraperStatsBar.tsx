import { memo, useEffect, useRef, useState } from 'react';
import {
  Layers,
  CalendarClock,
  Wifi,
  CheckCircle2,
  Sparkles,
  UserRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScraperStats } from '../../types/scraper';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Guard against NaN / Infinity that can come from division-by-zero ratios */
function safe(n: number): number {
  return isFinite(n) && !isNaN(n) ? n : 0;
}

/** Exact number with locale grouping (e.g. 2,700 - never abbreviated). */
function fmt(n: number): string {
  return safe(Math.round(n)).toLocaleString();
}

// ---------------------------------------------------------------------------
// Animated number
// ---------------------------------------------------------------------------

function useAnimatedNumber(target: number, duration = 700): number {
  const safeTarget = safe(target);
  const [value, setValue] = useState(0);
  // Mirror the current displayed value so each animation tweens FROM where we are
  // now (previous value) TO the new target - never resetting to 0. This means a
  // single stat changing only nudges that one number; unchanged numbers stay put.
  const valueRef = useRef(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const from = valueRef.current;
    if (from === safeTarget) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
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

function AnimatedNumber({ value }: { value: number }) {
  const d = useAnimatedNumber(value);
  return <>{fmt(d)}</>;
}

// ---------------------------------------------------------------------------
// Metric tile - uniform, modern card used for all six blocks
// ---------------------------------------------------------------------------

interface MetricTileProps {
  icon: LucideIcon;
  value: number;
  label: string;
  sub?: string;
  /** Gradient classes for the avatar + accents (e.g. "from-blue-500 to-indigo-600") */
  gradient: string;
  /** Text color for the value */
  textColor: string;
  delay?: number;
  title?: string;
}

const MetricTile = memo(function MetricTile({
  icon: Icon,
  value,
  label,
  sub,
  gradient,
  textColor,
  delay = 0,
  title,
}: MetricTileProps) {
  return (
    <div
      className="group relative flex items-center gap-3 overflow-hidden rounded-2xl border border-slate-200/70 bg-white px-4 py-3.5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md"
      style={{ animationDelay: `${delay}ms` }}
      title={title}
    >
      {/* Soft gradient wash that intensifies on hover */}
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${gradient} opacity-[0.06] transition-opacity duration-300 group-hover:opacity-[0.11]`} />
      {/* Top accent line */}
      <div className={`absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r ${gradient}`} />

      {/* Avatar */}
      <div className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${gradient} text-white shadow-md`}>
        <Icon size={20} strokeWidth={2.4} />
      </div>

      {/* Value + label */}
      <div className="relative min-w-0">
        <div className="flex items-baseline gap-1.5 leading-none">
          <span className={`text-2xl font-black tabular-nums tracking-tight ${textColor}`}>
            <AnimatedNumber value={value} />
          </span>
          {sub && (
            <span className={`text-[11px] font-bold tabular-nums ${textColor} opacity-60`}>{sub}</span>
          )}
        </div>
        <p className="mt-1.5 truncate text-[11.5px] font-semibold leading-none text-slate-500">{label}</p>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function SkeletonTile() {
  return <div className="h-[72px] animate-pulse rounded-2xl bg-gradient-to-r from-slate-100 to-slate-50" />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ScraperStatsBarProps {
  stats: ScraperStats | null;
  loading: boolean;
}

const GRID_CLASS = 'grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6';

export const ScraperStatsBar = memo(function ScraperStatsBar({ stats, loading }: ScraperStatsBarProps) {
  if (loading || !stats) {
    return (
      <div className="w-full rounded-2xl border border-slate-100/80 bg-gradient-to-r from-slate-50/80 via-blue-50/30 to-slate-50/80 p-3 backdrop-blur-sm">
        <div className={GRID_CLASS}>
          {Array.from({ length: 6 }).map((_, i) => <SkeletonTile key={i} />)}
        </div>
      </div>
    );
  }

  const totalJobs   = safe(stats.total_jobs);
  const remoteRatio = totalJobs > 0 ? safe(Math.round((stats.total_remote / totalJobs) * 100)) : 0;
  const todayRemote = safe(stats.today_remote);

  return (
    <div className="w-full rounded-2xl border border-slate-100/80 bg-gradient-to-r from-slate-50/80 via-blue-50/30 to-slate-50/80 p-3 backdrop-blur-sm">
      <div className={GRID_CLASS}>
        <MetricTile
          icon={Layers}
          value={totalJobs}
          label="Total Jobs"
          gradient="from-blue-500 to-indigo-600"
          textColor="text-blue-700"
          delay={0}
          title="All jobs currently in your dashboard"
        />
        <MetricTile
          icon={CalendarClock}
          value={safe(stats.today_scraped)}
          label="Added Today"
          sub={todayRemote > 0 ? `${todayRemote} remote` : undefined}
          gradient="from-amber-400 to-orange-500"
          textColor="text-amber-700"
          delay={50}
          title="Jobs added to your dashboard today"
        />
        <MetricTile
          icon={UserRound}
          value={safe(stats.my_jobs)}
          label="Posted by me"
          gradient="from-violet-500 to-purple-600"
          textColor="text-violet-700"
          delay={100}
          title="Jobs you added via submission or attachment"
        />
        <MetricTile
          icon={Wifi}
          value={safe(stats.total_remote)}
          label="Remote"
          sub={remoteRatio > 0 ? `${remoteRatio}%` : undefined}
          gradient="from-cyan-500 to-blue-600"
          textColor="text-cyan-700"
          delay={150}
          title="Remote-friendly jobs"
        />
        <MetricTile
          icon={CheckCircle2}
          value={safe(stats.extracted_jobs)}
          label="Extracted"
          gradient="from-indigo-500 to-blue-600"
          textColor="text-indigo-700"
          delay={200}
          title="Jobs fully extracted and structured"
        />
        <MetricTile
          icon={Sparkles}
          value={safe(stats.ready_jobs)}
          label="Ready to Apply"
          sub={totalJobs > 0 ? `of ${fmt(totalJobs)}` : undefined}
          gradient="from-emerald-500 to-teal-500"
          textColor="text-emerald-700"
          delay={250}
          title="Jobs with a tailored resume ready"
        />
      </div>
    </div>
  );
});
