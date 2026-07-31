import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartTooltipContent, brightenForDark, useChartTooltipStyles } from './ChartTooltip';

export interface MultiLineSeriesDef {
  key: string;
  label: string;
  color: string;
}

interface MultiLineChartProps {
  data: Array<Record<string, unknown>>;
  xKey: string;
  series: MultiLineSeriesDef[];
  height?: number;
  /** Optional X tick formatter. Defaults to M/D for ISO dates. */
  formatXTick?: (value: string) => string;
  /** Y-axis unit suffix shown in empty state only; axis stays numeric. */
  yAllowDecimals?: boolean;
}

const PALETTE = [
  '#2563eb',
  '#0f766e',
  '#7c3aed',
  '#c2410c',
  '#be123c',
  '#0369a1',
  '#4d7c0f',
  '#a16207',
  '#6d28d9',
  '#0e7490',
  '#b45309',
  '#9f1239',
];

export function seriesColorAt(index: number): string {
  return PALETTE[index % PALETTE.length];
}

function formatDayLabel(value: string): string {
  const parts = value.split('-');
  if (parts.length !== 3) return value;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

export function MultiLineChart({
  data,
  xKey,
  series,
  height = 300,
  formatXTick = formatDayLabel,
  yAllowDecimals = false,
}: MultiLineChartProps) {
  const { dark, gridStroke, tickFill, legendColor } = useChartTooltipStyles();

  if (series.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-slate-400"
        style={{ height }}
      >
        Select at least one series to display
      </div>
    );
  }

  return (
    <div className="relative z-10 overflow-hidden" style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
          <XAxis
            dataKey={xKey}
            tickFormatter={formatXTick}
            tick={{ fontSize: 11, fill: tickFill }}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            allowDecimals={yAllowDecimals}
            tick={{ fontSize: 11, fill: tickFill }}
            width={48}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, color: legendColor, position: 'relative', zIndex: 1 }}
            formatter={(value, entry) => {
              const color =
                typeof entry.color === 'string'
                  ? dark
                    ? brightenForDark(entry.color)
                    : entry.color
                  : legendColor;
              return <span style={{ color, fontWeight: 600 }}>{value}</span>;
            }}
          />
          <Tooltip
            cursor={{ stroke: dark ? '#64748b' : '#94a3b8', strokeWidth: 1 }}
            content={<ChartTooltipContent />}
            // Keep tooltip inside the chart layer (no document.body portal).
            // Portaling to body was expanding the page and showing a native scrollbar
            // on top of the custom .page-scroll-y bar.
            allowEscapeViewBox={{ x: false, y: false }}
            wrapperStyle={{ zIndex: 50, outline: 'none', pointerEvents: 'none' }}
          />
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={dark ? brightenForDark(s.color) : s.color}
              strokeWidth={2.25}
              dot={{ r: 3 }}
              activeDot={{ r: 4, stroke: dark ? '#0b1220' : '#fff', strokeWidth: 2 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
