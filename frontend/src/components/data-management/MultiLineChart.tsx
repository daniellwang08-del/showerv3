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
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
          <XAxis
            dataKey={xKey}
            tickFormatter={formatDayLabel}
            tick={{ fontSize: 11, fill: tickFill }}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: tickFill }} width={36} />
          <Tooltip
            cursor={{ stroke: dark ? '#64748b' : '#94a3b8', strokeWidth: 1 }}
            content={<ChartTooltipContent />}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, color: legendColor }}
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
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={dark ? brightenForDark(s.color) : s.color}
              strokeWidth={2.25}
              dot={false}
              activeDot={{ r: 4, stroke: dark ? '#0b1220' : '#fff', strokeWidth: 2 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
