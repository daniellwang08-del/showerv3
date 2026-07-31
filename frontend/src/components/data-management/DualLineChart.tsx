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

interface DualLineChartProps {
  data: Array<Record<string, unknown>>;
  xKey: string;
  lineAKey: string;
  lineBKey: string;
  lineAName: string;
  lineBName: string;
  lineAColor: string;
  lineBColor: string;
  height?: number;
}

function formatDayLabel(value: string): string {
  // value is YYYY-MM-DD
  const parts = value.split('-');
  if (parts.length !== 3) return value;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

export function DualLineChart({
  data,
  xKey,
  lineAKey,
  lineBKey,
  lineAName,
  lineBName,
  lineAColor,
  lineBColor,
  height = 280,
}: DualLineChartProps) {
  const { dark, gridStroke, tickFill, legendColor } = useChartTooltipStyles();
  const aColor = dark ? brightenForDark(lineAColor) : lineAColor;
  const bColor = dark ? brightenForDark(lineBColor) : lineBColor;

  return (
    <div className="relative z-10 overflow-hidden" style={{ width: '100%', height }}>
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
            allowEscapeViewBox={{ x: false, y: false }}
            wrapperStyle={{ zIndex: 50, outline: 'none', pointerEvents: 'none' }}
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
          <Line
            type="monotone"
            dataKey={lineAKey}
            name={lineAName}
            stroke={aColor}
            strokeWidth={2.25}
            dot={false}
            activeDot={{ r: 4, stroke: dark ? '#0b1220' : '#fff', strokeWidth: 2 }}
          />
          <Line
            type="monotone"
            dataKey={lineBKey}
            name={lineBName}
            stroke={bColor}
            strokeWidth={2.25}
            dot={false}
            activeDot={{ r: 4, stroke: dark ? '#0b1220' : '#fff', strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
