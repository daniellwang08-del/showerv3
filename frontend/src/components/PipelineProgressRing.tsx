import { useId, type MouseEvent } from 'react';
import type { PipelineRingPhase } from '../utils/jobPipelineVisual';

type RingProps = {
  /** Number of 90° segments filled, clockwise from 12 o'clock */
  filled: 1 | 2 | 3;
  phase: PipelineRingPhase;
  /**
   * Live pipeline: orbiting dot + gentle breathe on fills until match score replaces the ring.
   * Set false for static previews (e.g. dashboard legend).
   * @default true
   */
  showActivity?: boolean;
  className?: string;
  'aria-hidden'?: boolean;
};

const PHASE_STROKE: Record<PipelineRingPhase, string> = {
  queue: '#f59e0b',
  extracted: '#2563eb',
  analyzing: '#f59e0b',
};

/** Orbiting dot — phase-colored for queue/analyzing (amber) vs extracted (blue) */
const PHASE_DOT: Record<PipelineRingPhase, string> = {
  queue: 'bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.95),0_0_3px_rgba(245,158,11,0.6)]',
  extracted: 'bg-sky-400 shadow-[0_0_10px_rgba(96,165,250,0.92),0_0_3px_rgba(37,99,235,0.55)]',
  analyzing: 'bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.95),0_0_3px_rgba(245,158,11,0.6)]',
};

const TRACK = '#e2e8f0';
const TRACK_INNER = '#f1f5f9';

const PATH_TRANSITION =
  'opacity 0.55s cubic-bezier(0.33, 1, 0.68, 1), stroke 0.6s cubic-bezier(0.4, 0, 0.2, 1)';

/** Single 90° arc on the circle, starting at startAngleDeg (0 = +X), sweep clockwise */
function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const rad = Math.PI / 180;
  const x1 = cx + r * Math.cos(startDeg * rad);
  const y1 = cy + r * Math.sin(startDeg * rad);
  const x2 = cx + r * Math.cos(endDeg * rad);
  const y2 = cy + r * Math.sin(endDeg * rad);
  return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${r} ${r} 0 0 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
}

/**
 * Four-quarter ring (3 usable states before match score replaces the control).
 * Segments drawn from top (-90°) clockwise. Fills use opacity so progress changes feel smooth.
 */
export function PipelineQuarterRing({ filled, phase, showActivity = true, className = '', ...rest }: RingProps) {
  const trackGradId = useId().replace(/:/g, '');
  const stroke = PHASE_STROKE[phase];
  const dotClass = PHASE_DOT[phase];
  const cx = 18;
  const cy = 18;
  const r = 12.5;
  const sw = 3.25;

  const q1 = arcPath(cx, cy, r, -90, 0);
  const q2 = arcPath(cx, cy, r, 0, 90);
  const q3 = arcPath(cx, cy, r, 90, 180);
  const q4 = arcPath(cx, cy, r, 180, 270);

  const segs = [q1, q2, q3, q4];

  return (
    <span className={`relative inline-flex h-9 w-9 shrink-0 items-center justify-center ${className}`} {...rest}>
      <svg
        width={36}
        height={36}
        viewBox="0 0 36 36"
        className="absolute inset-0 shrink-0 drop-shadow-[0_1px_2px_rgb(15_23_42/0.06)]"
        aria-hidden
      >
        <defs>
          <linearGradient id={trackGradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={TRACK_INNER} />
            <stop offset="100%" stopColor={TRACK} />
          </linearGradient>
        </defs>
        {segs.map((d, i) => (
          <path
            key={`track-${i}`}
            d={d}
            fill="none"
            stroke={`url(#${trackGradId})`}
            strokeWidth={sw}
            strokeLinecap="round"
          />
        ))}
        <g
          className={showActivity ? 'animate-pipeline-ring-breathe' : undefined}
          style={{ transformOrigin: '18px 18px' }}
        >
          {segs.map((d, i) => (
            <path
              key={`fill-${i}`}
              d={d}
              fill="none"
              stroke={stroke}
              strokeWidth={sw}
              strokeLinecap="round"
              opacity={i < filled ? 1 : 0}
              style={{ transition: PATH_TRANSITION }}
            />
          ))}
        </g>
      </svg>
      {showActivity ? (
        <span className="pointer-events-none absolute inset-0 animate-pipeline-orbit" aria-hidden>
          <span
            className={`absolute left-1/2 top-1/2 h-[5px] w-[5px] rounded-full ${dotClass}`}
            style={{ transform: 'translate(-50%, calc(-50% - 12.5px))' }}
          />
        </span>
      ) : null}
    </span>
  );
}

type ScoreChipProps = {
  score: number;
  className?: string;
  title?: string;
  onClick?: (e: MouseEvent) => void;
};

/** Saved match score — same footprint as before (h-8 · min-w-[2rem] · px-2 · text-xs) */
export function MatchScoreChip({ score, className = '', title, onClick }: ScoreChipProps) {
  const band =
    score >= 75
      ? 'border border-white/30 bg-gradient-to-br from-emerald-400 via-emerald-600 to-green-900 shadow-lg shadow-emerald-950/28 ring-1 ring-white/15'
      : score >= 45
        ? 'border border-white/30 bg-gradient-to-br from-sky-400 via-blue-600 to-indigo-800 shadow-lg shadow-blue-950/26 ring-1 ring-white/15'
        : 'border border-white/30 bg-gradient-to-br from-amber-400 via-orange-500 to-amber-900 shadow-lg shadow-orange-950/22 ring-1 ring-white/15';

  const interactiveChip =
    'transition-[box-shadow,filter] duration-200 ease-out group-hover:shadow-[0_10px_26px_-8px_rgb(15_23_42/0.35)] group-hover:ring-2 group-hover:ring-white/45 group-hover:brightness-[1.06] group-active:shadow-[inset_0_3px_12px_rgb(0_0_0/0.22)] group-active:brightness-95 group-active:ring-white/25';

  const content = (
    <span
      className={`relative isolate flex h-8 min-w-[2rem] items-center justify-center overflow-hidden rounded-full px-2 text-xs font-bold tabular-nums tracking-tight text-white ${band} ${onClick ? interactiveChip : ''} ${className}`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.22] via-transparent to-black/[0.12] group-active:opacity-90"
      />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/35 transition-opacity group-hover:bg-white/50" />
      <span className="relative z-[1] [text-shadow:0_1px_1px_rgb(0_0_0/0.22)]">{score}</span>
    </span>
  );

  if (onClick) {
    return (
      <button
        type="button"
        title={title}
        onClick={onClick}
        className="group origin-center shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent] transition-transform duration-200 ease-out hover:scale-105 active:scale-[0.96] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/90 focus-visible:ring-offset-2"
      >
        {content}
      </button>
    );
  }

  return (
    <span title={title} className="shrink-0">
      {content}
    </span>
  );
}
