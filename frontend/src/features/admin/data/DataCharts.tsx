import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  formatDayLabel,
  formatDayTick,
  formatUsd,
  type ChartRow,
  type ChartSeries,
  type ChartValueFormat,
} from './dataUtils';

const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const compactNumber = (v: number) => compactFormat.format(v);
const usdTick = (v: number) => `$${v >= 100 ? compactFormat.format(v) : Number(v.toFixed(2))}`;

const formatChartValue = (value: number, format: ChartValueFormat) =>
  format === 'usd' ? formatUsd(value) : value.toLocaleString();

/** Above this many series the tooltip lists only non-zero values. */
const DENSE_TOOLTIP = 10;

type TooltipEntry = { dataKey?: unknown; value?: unknown };

function Swatch({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg width="14" height="8" aria-hidden className="shrink-0">
      <line x1="0" y1="4" x2="14" y2="4" stroke={color} strokeWidth="2.5" strokeDasharray={dash} />
    </svg>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
  format,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: unknown;
  series: ChartSeries[];
  format: ChartValueFormat;
}) {
  if (!active || !payload?.length) return null;
  const rows = series.map((s) => ({ ...s, value: Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0) }));
  const dense = rows.length > DENSE_TOOLTIP;
  const shown = dense ? rows.filter((r) => r.value !== 0) : rows;
  const hidden = rows.length - shown.length;
  return (
    <div className="max-w-xs rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">{formatDayLabel(label)}</p>
      <ul className="space-y-0.5">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-4">
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <Swatch color={s.color} dash={s.dash} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="font-medium tabular-nums">{formatChartValue(s.value, format)}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? <p className="mt-1 text-muted-foreground">{hidden} more at 0</p> : null}
    </div>
  );
}

export default function LineSeriesChart({
  data,
  series,
  height = 260,
  format = 'number',
}: {
  data: ChartRow[];
  series: ChartSeries[];
  height?: number;
  format?: ChartValueFormat;
}) {
  return (
    <div className="min-w-0">
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        {series.map((s) => (
          <li key={s.key} className="flex min-w-0 items-center gap-1.5">
            <Swatch color={s.color} dash={s.dash} />
            <span className="truncate">{s.label}</span>
          </li>
        ))}
      </ul>
      <div style={{ height }} className="w-full tabular-nums">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickFormatter={formatDayTick}
              interval="preserveStartEnd"
              minTickGap={24}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
            />
            <YAxis
              allowDecimals={format === 'usd'}
              tickLine={false}
              axisLine={false}
              width={format === 'usd' ? 52 : 40}
              tickFormatter={format === 'usd' ? usdTick : compactNumber}
              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border)' }}
              allowEscapeViewBox={{ x: false, y: false }}
              wrapperStyle={{ outline: 'none', pointerEvents: 'none', zIndex: 20 }}
              content={({ active, payload, label }) => (
                <ChartTooltip
                  active={active}
                  payload={payload as readonly TooltipEntry[]}
                  label={label}
                  series={series}
                  format={format}
                />
              )}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeDasharray={s.dash}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3.5, strokeWidth: 0 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
