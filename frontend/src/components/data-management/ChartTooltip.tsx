import type { CSSProperties, ReactNode } from 'react';
import { useThemeStore } from '../../stores/themeStore';

/** High-contrast Recharts tooltip styles for light + dark themes. */
export function useChartTooltipStyles() {
  const theme = useThemeStore((s) => s.theme);
  const dark = theme === 'dark';

  return {
    dark,
    contentStyle: {
      borderRadius: 12,
      border: dark ? '1px solid #475569' : '1px solid #e2e8f0',
      background: dark ? '#0b1220' : '#ffffff',
      boxShadow: dark
        ? '0 12px 28px rgba(0, 0, 0, 0.55)'
        : '0 8px 20px rgba(15, 23, 42, 0.12)',
      padding: '10px 12px',
      fontSize: 12,
      color: dark ? '#f8fafc' : '#0f172a',
    } satisfies CSSProperties,
    labelStyle: {
      color: dark ? '#f8fafc' : '#0f172a',
      fontWeight: 700,
      marginBottom: 6,
      fontSize: 12,
    } satisfies CSSProperties,
    itemStyle: {
      color: dark ? '#e2e8f0' : '#334155',
      padding: '2px 0',
      fontSize: 12,
      fontWeight: 600,
    } satisfies CSSProperties,
    // Brighter series strokes on dark charts so lines + legend stay readable.
    gridStroke: dark ? '#334155' : '#e2e8f0',
    tickFill: dark ? '#94a3b8' : '#64748b',
    legendColor: dark ? '#e2e8f0' : '#334155',
  };
}

/** Brighten a hex color for dark-mode tooltip / legend readability. */
export function brightenForDark(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  // Mix toward white so dark brand colors stay vivid on a dark tooltip.
  const mix = (c: number) => Math.min(255, Math.round(c + (255 - c) * 0.35));
  const to = (c: number) => c.toString(16).padStart(2, '0');
  return `#${to(mix(r))}${to(mix(g))}${to(mix(b))}`;
}

type PayloadItem = {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
};

interface ChartTooltipContentProps {
  active?: boolean;
  label?: string | number;
  payload?: PayloadItem[];
  labelFormatter?: (label: string) => ReactNode;
}

/** Custom tooltip body — avoids Recharts defaults that clash with inverted dark tokens. */
export function ChartTooltipContent({
  active,
  label,
  payload,
  labelFormatter,
}: ChartTooltipContentProps) {
  const { dark, contentStyle } = useChartTooltipStyles();
  if (!active || !payload?.length) return null;

  const title =
    labelFormatter != null ? labelFormatter(String(label ?? '')) : String(label ?? '');

  return (
    <div style={{ ...contentStyle, position: 'relative', zIndex: 1000 }}>
      <div
        style={{
          color: dark ? '#ffffff' : '#0f172a',
          fontWeight: 700,
          marginBottom: 8,
          fontSize: 12,
          letterSpacing: '0.01em',
        }}
      >
        {title}
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {payload.map((entry, i) => {
          const color = entry.color
            ? dark
              ? brightenForDark(entry.color)
              : entry.color
            : dark
              ? '#e2e8f0'
              : '#334155';
          return (
            <li
              key={`${entry.dataKey ?? entry.name ?? i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '3px 0',
                color: dark ? '#f1f5f9' : '#1e293b',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: color,
                  boxShadow: dark ? `0 0 0 1px rgba(255,255,255,0.25)` : undefined,
                  flexShrink: 0,
                }}
              />
              <span style={{ color, flex: 1, minWidth: 0 }}>{entry.name}</span>
              <span
                style={{
                  color: dark ? '#ffffff' : '#0f172a',
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 700,
                }}
              >
                {entry.value ?? 0}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
