import { useEffect, useRef, useState } from 'react';
import { Link2, Unlink2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function ControlCard({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-2xl border bg-card p-3.5 text-card-foreground shadow-sm sm:p-4">
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <Icon size={16} className="shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef({ value, min, max, step, onChange });
  stateRef.current = { value, min, max, step, onChange };

  // Native non-passive wheel listener so scrolling over the slider adjusts its value
  // (and does not scroll the page). React's synthetic onWheel is passive and cannot
  // preventDefault, so we attach the listener directly.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = stateRef.current;
      const dir = e.deltaY < 0 ? 1 : -1;
      const raw = s.value + dir * s.step;
      const clamped = Math.min(s.max, Math.max(s.min, Number(raw.toFixed(4))));
      if (clamped !== s.value) s.onChange(clamped);
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between text-xs font-medium text-foreground/80">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{format ? format(value) : `${value}${suffix ?? ''}`}</span>
      </div>
      <input
        ref={inputRef}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-brand sm:h-1.5"
      />
    </label>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-5 sm:w-9 ${
          checked ? 'bg-brand' : 'bg-input'
        }`}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none inline-block h-[1.125rem] w-[1.125rem] transform rounded-full bg-brand-foreground shadow transition-transform duration-200 sm:h-4 sm:w-4 ${
            checked ? 'translate-x-[22px] sm:translate-x-[18px]' : 'translate-x-[3px] sm:translate-x-[2px]'
          }`}
        />
      </button>
    </div>
  );
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  compact = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  /** Short glyph options (bullets) share one row instead of wrapping. */
  compact?: boolean;
}) {
  // Root cause of prior overflow: `inline-flex` + default `min-width: auto` on
  // buttons made 4–5 option rows refuse to shrink below label width, so the
  // last chip ("Card", "Pipe") clipped past the card edge in the narrow Style
  // sidebar. Wrap + min-w-0 + flexible basis keeps every option usable.
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-foreground/80">{label}</div>
      <div
        role="group"
        aria-label={label}
        className="flex w-full min-w-0 flex-wrap gap-0.5 rounded-lg border bg-muted p-0.5"
      >
        {options.map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.title ?? opt.label}
            aria-label={opt.title}
            aria-pressed={value === opt.value}
            className={`min-w-0 flex-1 rounded-md px-1.5 py-1.5 text-center text-[11px] font-medium leading-tight transition sm:px-2 sm:text-xs ${
              compact ? 'basis-0' : 'basis-[3.75rem] sm:basis-[4.25rem]'
            } ${
              value === opt.value
                ? 'bg-card text-brand shadow-sm ring-1 ring-border'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <span className="block truncate">{opt.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type Side = 'top' | 'right' | 'bottom' | 'left';

/** Four independent numeric inputs (top / right / bottom / left) with an optional
 * "link" toggle that drives all four sides together. Used for page margin and the
 * header band padding. */
export function BoxSidesField({
  label,
  values,
  min,
  max,
  step,
  suffix,
  onChangeSide,
  onChangeAll,
}: {
  label: string;
  values: Record<Side, number>;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChangeSide: (side: Side, v: number) => void;
  onChangeAll: (v: number) => void;
}) {
  // Default to independent editing so each side is controllable on its own; the
  // toggle lets the user opt into driving all four sides together.
  const [linked, setLinked] = useState(false);

  const commit = (side: Side, raw: number) => {
    if (Number.isNaN(raw)) return;
    const v = Math.min(max, Math.max(min, Number(raw.toFixed(2))));
    if (linked) onChangeAll(v);
    else onChangeSide(side, v);
  };

  const fields: { side: Side; short: string }[] = [
    { side: 'top', short: 'Top' },
    { side: 'right', short: 'Right' },
    { side: 'bottom', short: 'Bottom' },
    { side: 'left', short: 'Left' },
  ];

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-foreground/80">
          {label}
          {suffix ? <span className="text-muted-foreground">{suffix}</span> : null}
        </span>
        <button
          type="button"
          onClick={() => setLinked((x) => !x)}
          title={linked ? 'Sides linked - edits apply to all four' : 'Sides independent'}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
            linked ? 'bg-brand-soft text-brand' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {linked ? <Link2 size={12} /> : <Unlink2 size={12} />}
          {linked ? 'Linked' : 'Per side'}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {fields.map(({ side, short }) => (
          <label key={side} className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{short}</span>
            <input
              type="number"
              min={min}
              max={max}
              step={step}
              value={Math.round(values[side] * 10) / 10}
              onChange={(e) => commit(side, Number(e.target.value))}
              className="w-full rounded-md border border-input bg-background px-1.5 py-1 text-center text-xs tabular-nums text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase text-muted-foreground">{value}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-9 cursor-pointer rounded border border-input bg-background p-0.5"
        />
      </span>
    </label>
  );
}
