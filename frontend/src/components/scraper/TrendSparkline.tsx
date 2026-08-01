import { memo, useId, useMemo } from 'react';

export interface TrendSparklineProps {
  values: number[];
  /** Stroke / glow color (CSS color). */
  color: string;
  /** Soft fill under the line. */
  fillColor?: string;
  className?: string;
  /** Stagger draw animation. */
  delayMs?: number;
  /** Accessible label for the series. */
  label?: string;
}

function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x} ${p.y}`;
  }

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function weekDelta(values: number[]): number {
  if (values.length < 2) return 0;
  const mid = Math.floor(values.length / 2);
  const early = values.slice(0, mid).reduce((a, b) => a + b, 0);
  const late = values.slice(mid).reduce((a, b) => a + b, 0);
  return late - early;
}

export const TrendSparkline = memo(function TrendSparkline({
  values,
  color,
  fillColor,
  className,
  delayMs = 0,
  label = '7-day trend',
}: TrendSparklineProps) {
  const uid = useId().replace(/:/g, '');
  const series = useMemo(() => {
    const raw = values.length > 0 ? values.map((n) => (Number.isFinite(n) ? Math.max(0, n) : 0)) : [0, 0, 0, 0, 0, 0, 0];
    while (raw.length < 2) raw.push(0);
    return raw;
  }, [values]);

  const width = 140;
  const height = 56;
  const padX = 4;
  const padY = 8;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const { linePath, areaPath, end, maxVal } = useMemo(() => {
    const max = Math.max(...series, 1);
    const min = 0;
    const span = Math.max(max - min, 1);
    const pts = series.map((v, i) => ({
      x: padX + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW),
      y: padY + plotH - ((v - min) / span) * plotH * 0.88,
    }));
    const line = buildSmoothPath(pts);
    const last = pts[pts.length - 1];
    const first = pts[0];
    const area = `${line} L ${last.x} ${height - 2} L ${first.x} ${height - 2} Z`;
    return { linePath: line, areaPath: area, end: last, maxVal: max };
  }, [series, plotW, plotH]);

  const delta = weekDelta(series);
  const total = series.reduce((a, b) => a + b, 0);
  const empty = total === 0;
  const fill = fillColor ?? color;

  return (
    <div
      className={['stats-sparkline relative flex h-full min-h-[56px] w-full min-w-[96px] flex-col justify-center', className ?? ''].join(' ')}
      style={{ animationDelay: `${delayMs}ms` }}
      title={`${label} · last 7 days`}
      aria-label={`${label}: ${series.join(', ')} over the last 7 days`}
    >
      <div className="mb-0.5 flex items-center justify-end gap-1.5 pr-0.5">
        <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">
          7d
        </span>
        {!empty && (
          <span
            className={[
              'text-[10px] font-extrabold tabular-nums',
              delta > 0 ? 'text-emerald-600 dark:text-emerald-300' : '',
              delta < 0 ? 'text-rose-600 dark:text-rose-300' : '',
              delta === 0 ? 'text-slate-500' : '',
            ].join(' ')}
          >
            {delta > 0 ? `+${delta}` : delta}
          </span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="stats-sparkline-svg h-[52px] w-full overflow-visible"
        preserveAspectRatio="none"
        role="img"
      >
        <defs>
          <linearGradient id={`spark-fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={fill} stopOpacity={empty ? 0.12 : 0.38} />
            <stop offset="100%" stopColor={fill} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`spark-stroke-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="45%" stopColor={color} stopOpacity="1" />
            <stop offset="100%" stopColor={color} stopOpacity="0.85" />
          </linearGradient>
          <filter id={`spark-glow-${uid}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Soft baseline guide — no chart frame */}
        <line
          x1={padX}
          y1={height - 3}
          x2={width - padX}
          y2={height - 3}
          stroke={color}
          strokeOpacity={0.12}
          strokeWidth="1"
          strokeDasharray="2 4"
        />

        <path
          d={areaPath}
          fill={`url(#spark-fill-${uid})`}
          className="stats-spark-area"
          style={{ animationDelay: `${delayMs + 120}ms` }}
        />

        <path
          d={linePath}
          fill="none"
          stroke={`url(#spark-stroke-${uid})`}
          strokeWidth={empty ? 1.5 : 2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={empty ? undefined : `url(#spark-glow-${uid})`}
          className="stats-spark-line"
          style={{ animationDelay: `${delayMs}ms` }}
          pathLength={1}
        />

        {/* Traveling pulse along the drawn line */}
        {!empty && (
          <circle r="3.2" fill={color} className="stats-spark-runner" filter={`url(#spark-glow-${uid})`}>
            <animateMotion
              dur="2.8s"
              begin={`${Math.max(0.2, delayMs / 1000) + 0.9}s`}
              repeatCount="indefinite"
              path={linePath}
              keyPoints="0;1"
              keyTimes="0;1"
              calcMode="linear"
            />
          </circle>
        )}

        <circle
          cx={end.x}
          cy={end.y}
          r={empty ? 2.2 : 3.6}
          fill={color}
          className="stats-spark-dot"
          style={{ animationDelay: `${delayMs + 700}ms` }}
        />
        {!empty && maxVal > 0 && (
          <circle
            cx={end.x}
            cy={end.y}
            r="7"
            fill={color}
            fillOpacity="0.22"
            className="stats-spark-halo"
            style={{ animationDelay: `${delayMs + 700}ms` }}
          />
        )}
      </svg>
    </div>
  );
});
