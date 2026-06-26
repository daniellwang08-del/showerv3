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
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Icon size={16} className="text-slate-500" />
        <h3 className="text-sm font-bold text-slate-900">{title}</h3>
      </div>
      <div className="space-y-3">{children}</div>
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
      <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-600">
        <span>{label}</span>
        <span className="tabular-nums text-slate-500">{format ? format(value) : `${value}${suffix ?? ''}`}</span>
      </div>
      <input
        ref={inputRef}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-blue-600"
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
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0 transition-colors ${
          checked ? 'bg-blue-600' : 'bg-slate-300'
        }`}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
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
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-600">{label}</div>
      <div className="inline-flex w-full rounded-lg border border-slate-200 bg-slate-50 p-0.5">
        {options.map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition ${
              value === opt.value ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {opt.label}
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
        <span className="text-xs font-medium text-slate-600">
          {label}
          {suffix ? <span className="text-slate-400">{suffix}</span> : null}
        </span>
        <button
          type="button"
          onClick={() => setLinked((x) => !x)}
          title={linked ? 'Sides linked — edits apply to all four' : 'Sides independent'}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
            linked ? 'bg-blue-50 text-blue-700' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          {linked ? <Link2 size={12} /> : <Unlink2 size={12} />}
          {linked ? 'Linked' : 'Per side'}
        </button>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {fields.map(({ side, short }) => (
          <label key={side} className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{short}</span>
            <input
              type="number"
              min={min}
              max={max}
              step={step}
              value={Math.round(values[side] * 10) / 10}
              onChange={(e) => commit(side, Number(e.target.value))}
              className="w-full rounded-md border border-slate-200 bg-white px-1.5 py-1 text-center text-xs tabular-nums text-slate-700 focus:border-blue-400 focus:outline-none"
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
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase text-slate-400">{value}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-9 cursor-pointer rounded border border-slate-200 bg-white p-0.5"
        />
      </span>
    </label>
  );
}
