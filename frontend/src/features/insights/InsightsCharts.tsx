import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TrendRow } from './insightsData';

export type TrendSeries = { key: keyof Omit<TrendRow, 'day'>; label: string; color: string };

const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const compactNumber = (v: number) => compactFormat.format(v);

type TooltipEntry = { dataKey?: unknown; value?: unknown; color?: string; name?: unknown };

function ChartTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: unknown;
  series: TrendSeries[];
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">{String(label ?? '')}</p>
      <ul className="space-y-0.5">
        {series.map((s) => {
          const entry = payload.find((p) => p.dataKey === s.key);
          return (
            <li key={s.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="font-medium tabular-nums">{Number(entry?.value ?? 0).toLocaleString()}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function TrendChart({
  data,
  series,
  height = 220,
}: {
  data: TrendRow[];
  series: TrendSeries[];
  height?: number;
}) {
  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
      <div style={{ height }} className="w-full tabular-nums">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={36}
              tickFormatter={compactNumber}
              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border)' }}
              content={({ active, payload, label }) => (
                <ChartTooltip active={active} payload={payload as readonly TooltipEntry[]} label={label} series={series} />
              )}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3.5, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
