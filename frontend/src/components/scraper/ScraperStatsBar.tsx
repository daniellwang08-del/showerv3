import { useEffect, useRef, useState } from 'react';
import {
  Layers,
  Sun,
  Wifi,
  CheckCircle2,
  Sparkles,
  FileText,
} from 'lucide-react';
import type { ScraperStats } from '../../types/scraper';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Guard against NaN / Infinity that can come from division-by-zero ratios */
function safe(n: number): number {
  return isFinite(n) && !isNaN(n) ? n : 0;
}

function fmt(n: number): string {
  const v = safe(Math.round(n));
  if (v >= 10000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000)  return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

// ---------------------------------------------------------------------------
// Animated number
// ---------------------------------------------------------------------------

function useAnimatedNumber(target: number, duration = 700): number {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number>(0);
  const safeTarget = safe(target);

  useEffect(() => {
    if (safeTarget === 0) { setValue(0); return; }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(safe(Math.round(eased * safeTarget)));
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
// Platform metadata
// ---------------------------------------------------------------------------

const PLATFORM_META: Record<string, { abbr: string; gradient: string; dot: string; label: string }> = {
  adzuna:             { abbr: 'AZ', gradient: 'from-cyan-500 to-blue-600',     dot: 'bg-cyan-500',    label: 'Adzuna'     },
  remoterocketship:   { abbr: 'RR', gradient: 'from-purple-500 to-violet-600', dot: 'bg-purple-500',  label: 'Rocket'     },
  jobright:           { abbr: 'JR', gradient: 'from-indigo-500 to-blue-600',   dot: 'bg-indigo-500',  label: 'JobRight'   },
  welcometothejungle: { abbr: 'WJ', gradient: 'from-emerald-500 to-green-600', dot: 'bg-emerald-500', label: 'Jungle'     },
  ziprecruiter:       { abbr: 'ZR', gradient: 'from-amber-500 to-orange-500',  dot: 'bg-amber-500',   label: 'ZipRecruit' },
  indeed:             { abbr: 'IN', gradient: 'from-blue-500 to-blue-700',     dot: 'bg-blue-500',    label: 'Indeed'     },
  glassdoor:          { abbr: 'GD', gradient: 'from-green-500 to-teal-600',    dot: 'bg-green-500',   label: 'Glassdoor'  },
};

function getPlatformMeta(source: string) {
  return PLATFORM_META[source.toLowerCase()] ?? {
    abbr: source.slice(0, 2).toUpperCase(),
    gradient: 'from-slate-400 to-slate-500',
    dot: 'bg-slate-400',
    label: source.length > 9 ? source.slice(0, 9) + '…' : source,
  };
}

function relativeShort(dateStr: string | null): string {
  if (!dateStr) return '';
  const mins = safe(Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// ---------------------------------------------------------------------------
// Unified tile — identical layout/size for BOTH platform and metric tiles
// ---------------------------------------------------------------------------
//
//  ┌──────────────────────────────────┐
//  │ [avatar]  NUMBER  optional-sub   │
//  │           label                  │
//  └──────────────────────────────────┘
//
//  avatar = gradient square with either abbreviated text (platform)
//           or a Lucide icon (metric)

interface UnifiedTileProps {
  /** Gradient classes for the avatar square + top accent line */
  gradient: string;
  /** Content rendered inside the avatar square */
  avatar: React.ReactNode;
  /** Main numeric value */
  value: number;
  /** Short label below the number */
  label: string;
  /** Optional subscript next to the number (e.g. "42%", "12 remote") */
  sub?: string;
  /** Text color for value + sub */
  textColor: string;
  /** Optional live-pulse dot (platform tiles only) */
  liveDot?: string; // bg-* color class
  delay?: number;
  title?: string;
}

function UnifiedTile({
  gradient,
  avatar,
  value,
  label,
  sub,
  textColor,
  liveDot,
  delay = 0,
  title,
}: UnifiedTileProps) {
  return (
    <div
      className="relative flex items-center gap-3 overflow-hidden rounded-xl border border-white/60 bg-white/80 px-4 py-3 shadow-sm backdrop-blur-sm"
      style={{ animationDelay: `${delay}ms`, minWidth: '110px' }}
      title={title}
    >
      {/* Left accent bar */}
      <div className={`absolute left-0 top-0 h-full w-[3px] rounded-l-xl bg-gradient-to-b ${gradient}`} />

      {/* Avatar square */}
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${gradient} text-white shadow-sm`}>
        {avatar}
      </div>

      {/* Value + label */}
      <div className="min-w-0">
        <div className="flex items-baseline gap-1 leading-none">
          <span className={`text-lg font-extrabold tabular-nums ${textColor}`}>
            <AnimatedNumber value={value} />
          </span>
          {sub && (
            <span className={`text-[11px] font-semibold tabular-nums ${textColor} opacity-60`}>{sub}</span>
          )}
        </div>
        <p className="mt-1 text-[11px] font-medium leading-none text-slate-500">{label}</p>
      </div>

      {/* Live pulse dot */}
      {liveDot && (
        <span className={`absolute right-2 top-2 h-2 w-2 rounded-full ${liveDot} animate-pulse`} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero tile — center column, visibly larger
// ---------------------------------------------------------------------------

interface HeroTileProps {
  icon: React.ReactNode;
  value: number;
  label: string;
  sub?: string;
  gradient: string;
  textColor: string;
  delay?: number;
}

function HeroTile({ icon, value, label, sub, gradient, textColor, delay = 0 }: HeroTileProps) {
  return (
    <div
      className="relative flex h-[132px] w-36 flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-white/70 bg-white/90 px-4 shadow-md backdrop-blur-sm"
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* Subtle gradient wash */}
      <div className={`absolute inset-0 bg-gradient-to-br ${gradient} opacity-[0.07]`} />
      {/* Top accent line */}
      <div className={`absolute top-0 left-5 right-5 h-0.5 rounded-full bg-gradient-to-r ${gradient}`} />

      <div className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${gradient} text-white shadow-md`}>
        {icon}
      </div>
      <span className={`text-2xl font-black tabular-nums leading-none ${textColor}`}>
        <AnimatedNumber value={value} />
      </span>
      <p className="text-[11px] font-semibold leading-none text-slate-600 text-center">{label}</p>
      {sub && (
        <p className={`text-[10px] font-medium leading-none ${textColor} opacity-60`}>{sub}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

function VDivider() {
  return <div className="mx-1 h-10 w-px shrink-0 self-center rounded-full bg-slate-200/80" />;
}

// ---------------------------------------------------------------------------
// Loading skeletons
// ---------------------------------------------------------------------------

function SkeletonTile() {
  return <div className="h-[64px] w-[114px] shrink-0 animate-pulse rounded-xl bg-gradient-to-r from-slate-100 to-slate-50" />;
}
function SkeletonHero() {
  return <div className="h-[132px] w-36 shrink-0 animate-pulse rounded-2xl bg-gradient-to-r from-slate-100 to-slate-50" />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ScraperStatsBarProps {
  stats: ScraperStats | null;
  loading: boolean;
}

export function ScraperStatsBar({ stats, loading }: ScraperStatsBarProps) {

  if (loading || !stats) {
    return (
      <div className="flex w-full items-center gap-3 rounded-2xl border border-slate-100 bg-slate-50/60 px-4 py-3 backdrop-blur-sm">
        <div className="flex flex-1 flex-wrap gap-2">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonTile key={i} />)}
        </div>
        <VDivider />
        <div className="flex shrink-0 gap-3">
          <SkeletonHero /><SkeletonHero />
        </div>
        <VDivider />
        <div className="flex flex-1 flex-wrap justify-end gap-2">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonTile key={i} />)}
        </div>
      </div>
    );
  }

  const totalJobs   = safe(stats.total_jobs);
  const remoteRatio = totalJobs > 0 ? safe(Math.round((stats.total_remote / totalJobs) * 100)) : 0;

  return (
    <div className="flex w-full items-center gap-3 rounded-2xl border border-slate-100/80 bg-gradient-to-r from-slate-50/80 via-blue-50/30 to-slate-50/80 px-4 py-3 backdrop-blur-sm">

      {/* ── LEFT: Per-platform counts ─────────────────────────────────── */}
      <div className="flex flex-1 flex-wrap items-center gap-3">
        {stats.sources.length === 0 ? (
          <span className="text-xs italic text-slate-400">No sources yet</span>
        ) : stats.sources.map((src, i) => {
          const meta  = getPlatformMeta(src.source);
          const since = relativeShort(src.latest_scraped);
          const isLive = !!since && since.endsWith('m') && safe(parseInt(since)) < 60;
          return (
            <UnifiedTile
              key={src.source}
              gradient={meta.gradient}
              avatar={<span className="text-[11px] font-black">{meta.abbr}</span>}
              value={src.count}
              label={meta.label}
              textColor="text-slate-700"
              liveDot={isLive ? meta.dot : undefined}
              delay={i * 40}
              title={`${src.source}: ${src.count} jobs${since ? ` · last scraped ${since} ago` : ''}`}
            />
          );
        })}
      </div>

      <VDivider />

      {/* ── CENTER: Hero tiles ────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-8">
        <HeroTile
          icon={<Sun size={21} strokeWidth={2.5} />}
          value={safe(stats.today_scraped)}
          label="Today's Jobs"
          sub={stats.today_remote > 0 ? `${safe(stats.today_remote)} remote` : undefined}
          gradient="from-amber-400 to-orange-500"
          textColor="text-amber-700"
          delay={0}
        />
        <HeroTile
          icon={<Sparkles size={21} strokeWidth={2.5} />}
          value={safe(stats.ready_jobs)}
          label="Ready to Apply"
          sub={totalJobs > 0 ? `of ${fmt(totalJobs)}` : undefined}
          gradient="from-emerald-500 to-teal-500"
          textColor="text-emerald-700"
          delay={60}
        />
      </div>

      <VDivider />

      {/* ── RIGHT: Aggregate metrics ──────────────────────────────────── */}
      <div className="flex flex-1 flex-wrap items-center justify-end gap-3">
        <UnifiedTile
          gradient="from-blue-500 to-indigo-600"
          avatar={<Layers size={17} strokeWidth={2.5} />}
          value={totalJobs}
          label="Total Jobs"
          textColor="text-blue-700"
          delay={0}
        />
        <UnifiedTile
          gradient="from-violet-500 to-purple-600"
          avatar={<Wifi size={17} strokeWidth={2.5} />}
          value={safe(stats.total_remote)}
          label="Remote"
          sub={remoteRatio > 0 ? `${remoteRatio}%` : undefined}
          textColor="text-violet-700"
          delay={40}
        />
        <UnifiedTile
          gradient="from-indigo-500 to-blue-600"
          avatar={<CheckCircle2 size={17} strokeWidth={2.5} />}
          value={safe(stats.extracted_jobs)}
          label="Extracted"
          textColor="text-indigo-700"
          delay={120}
        />
        <UnifiedTile
          gradient="from-emerald-400 to-green-500"
          avatar={<FileText size={17} strokeWidth={2.5} />}
          value={safe(stats.ready_jobs)}
          label="With Resume"
          textColor="text-emerald-700"
          delay={200}
        />
      </div>

    </div>
  );
}
