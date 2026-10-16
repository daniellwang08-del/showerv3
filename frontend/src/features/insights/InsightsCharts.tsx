import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ActivityRow, MatchSlice, TrendRow } from './insightsData';

export type ChartSeries<K extends string> = {
  key: K;
  label: string;
  color: string;
  kind: 'bar' | 'area' | 'line';
};
export type TrendSeries = ChartSeries<keyof Omit<TrendRow, 'day'>>;
export type ActivitySeries = ChartSeries<keyof Omit<ActivityRow, 'day' | 'date'>>;

const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const compactNumber = (v: number) => compactFormat.format(v);
const axisTick = { fill: 'var(--muted-foreground)', fontSize: 11 };

type TooltipEntry = { dataKey?: unknown; value?: unknown };

function ChartTooltip<K extends string>({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: unknown;
  series: ChartSeries<K>[];
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-40 rounded-xl border bg-popover/95 px-3 py-2.5 text-xs text-popover-foreground shadow-lg backdrop-blur">
      <p className="mb-1.5 font-semibold">{String(label ?? '')}</p>
      <ul className="space-y-1">
        {series.map((s) => {
          const entry = payload.find((p) => p.dataKey === s.key);
          return (
            <li key={s.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="font-semibold tabular-nums">{Number(entry?.value ?? 0).toLocaleString()}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SeriesChart<Row extends { day: string }, K extends string>({
  id,
  data,
  series,
  height,
}: {
  id: string;
  data: Row[];
  series: ChartSeries<K>[];
  height: number;
}) {
  const dense = data.length > 14;
  return (
    <div style={{ height }} className="w-full tabular-nums">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barGap={2}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={s.kind === 'bar' ? 0.95 : 0.35} />
                <stop offset="100%" stopColor={s.color} stopOpacity={s.kind === 'bar' ? 0.55 : 0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            interval={dense ? 'preserveStartEnd' : 0}
            minTickGap={dense ? 18 : 4}
            tick={axisTick}
          />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} tickFormatter={compactNumber} tick={axisTick} />
          <Tooltip
            cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
            content={({ active, payload, label }) => (
              <ChartTooltip active={active} payload={payload as readonly TooltipEntry[]} label={label} series={series} />
            )}
          />
          {series.map((s) =>
            s.kind === 'bar' ? (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={`url(#${id}-${s.key})`}
                radius={[5, 5, 1, 1]}
                maxBarSize={dense ? 14 : 26}
                isAnimationActive={false}
              />
            ) : s.kind === 'area' ? (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                fill={`url(#${id}-${s.key})`}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
                isAnimationActive={false}
              />
            ) : (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2.25}
                strokeDasharray="5 4"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
                isAnimationActive={false}
              />
            ),
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ActivityChart({ data, series, height = 260 }: { data: ActivityRow[]; series: ActivitySeries[]; height?: number }) {
  return <SeriesChart id="activity" data={data} series={series} height={height} />;
}

export function TrendChart({ data, series, height = 200 }: { data: TrendRow[]; series: TrendSeries[]; height?: number }) {
  return <SeriesChart id={`trend-${series.map((s) => s.key).join('-')}`} data={data} series={series} height={height} />;
}

export const MATCH_COLORS: Record<MatchSlice['key'], string> = {
  strong: 'var(--status-ready)',
  good: 'var(--chart-1)',
  low: 'var(--muted-foreground)',
};

export function MatchDonut({ slices, avg, size = 168 }: { slices: MatchSlice[]; avg: number; size?: number }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const data = total > 0 ? slices : [{ key: 'empty', label: 'No scores', value: 1 }];
  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius="72%"
            outerRadius="100%"
            paddingAngle={total > 0 ? 2 : 0}
            cornerRadius={4}
            stroke="none"
            startAngle={90}
            endAngle={-270}
            isAnimationActive={false}
          >
            {data.map((d) => (
              <Cell
                key={d.key}
                fill={d.key === 'empty' ? 'var(--muted)' : MATCH_COLORS[d.key as MatchSlice['key']]}
                fillOpacity={d.key === 'low' ? 0.35 : 1}
              />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-semibold tabular-nums">{total > 0 ? avg : '-'}</span>
        <span className="text-[11px] font-medium text-muted-foreground">avg score</span>
      </div>
    </div>
  );
}
