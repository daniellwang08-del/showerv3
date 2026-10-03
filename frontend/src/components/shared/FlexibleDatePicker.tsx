import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  MONTH_NAMES,
  buildFlexibleDate,
  daysInMonth,
  formatFlexibleDate,
  parseFlexibleDate,
  type DatePrecision,
} from '../../utils/flexibleDate';

type Props = {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  placeholder?: string;
  /** Show a Present checkbox (typical for work end dates). Empty value = Present. */
  allowPresent?: boolean;
  hasError?: boolean;
  onPick?: () => void;
  size?: 'sm' | 'md';
  className?: string;
};

function inferPrecision(value: string): DatePrecision {
  return parseFlexibleDate(value)?.precision ?? 'month';
}

function todayValue(precision: DatePrecision): string {
  const t = new Date();
  const y = t.getFullYear();
  const m = t.getMonth() + 1;
  const d = t.getDate();
  if (precision === 'year') return buildFlexibleDate('year', y);
  if (precision === 'month') return buildFlexibleDate('month', y, m);
  return buildFlexibleDate('day', y, m, d);
}

export function FlexibleDatePicker({
  value,
  onChange,
  label,
  placeholder = 'Select date',
  allowPresent = false,
  hasError = false,
  onPick,
  size = 'sm',
  className = '',
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const parsed = parseFlexibleDate(value);
  const current = useMemo(() => new Date(), []);
  const [precision, setPrecision] = useState<DatePrecision>(() => inferPrecision(value));
  const [viewYear, setViewYear] = useState(parsed?.year ?? current.getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed?.month ?? current.getMonth() + 1);

  const isPresent = allowPresent && !value.trim();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const next = parseFlexibleDate(value);
    setPrecision(next?.precision ?? precision);
    setViewYear(next?.year ?? current.getFullYear());
    setViewMonth(next?.month ?? current.getMonth() + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync when opening / value changes while open
  }, [open, value]);

  const commit = (next: string) => {
    onChange(next);
    onPick?.();
  };

  const setPresent = (present: boolean) => {
    if (present) {
      commit('');
      setOpen(false);
      return;
    }
    // Leaving Present: seed a concrete end date so empty ≠ Present anymore.
    const next = todayValue(precision);
    commit(next);
    const p = parseFlexibleDate(next);
    if (p) {
      setViewYear(p.year);
      setViewMonth(p.month ?? current.getMonth() + 1);
    }
    setOpen(true);
  };

  const pickYear = (year: number) => {
    if (precision === 'year') {
      commit(buildFlexibleDate('year', year));
      setOpen(false);
      return;
    }
    setViewYear(year);
  };

  const pickMonth = (month: number) => {
    setViewMonth(month);
    if (precision === 'month') {
      commit(buildFlexibleDate('month', viewYear, month));
      setOpen(false);
      return;
    }
  };

  const pickDay = (day: number) => {
    commit(buildFlexibleDate('day', viewYear, viewMonth, day));
    setOpen(false);
  };

  const switchPrecision = (next: DatePrecision) => {
    setPrecision(next);
    if (isPresent) return;
    const baseYear = parsed?.year ?? viewYear;
    const baseMonth = parsed?.month ?? viewMonth;
    const baseDay = parsed?.day ?? 1;
    if (next === 'year') {
      commit(buildFlexibleDate('year', baseYear));
    } else if (next === 'month') {
      commit(buildFlexibleDate('month', baseYear, baseMonth));
    } else {
      commit(buildFlexibleDate('day', baseYear, baseMonth, baseDay));
    }
  };

  const display = formatFlexibleDate(value);
  const triggerLabel = display || (isPresent ? 'Present' : placeholder);
  const hasValue = Boolean(display) || isPresent;

  const triggerCls =
    size === 'md'
      ? 'w-full rounded-xl border border-input bg-card focus:border-ring focus:ring-3 focus:ring-ring/30 dark:bg-input/30 px-4 py-2.5 text-sm font-medium text-foreground outline-none transition'
      : 'block w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground outline-none transition focus:border-ring';

  const checkCls =
    size === 'md'
      ? 'h-3.5 w-3.5 rounded border-border text-brand focus:ring-ring/50'
      : 'h-3 w-3 rounded border-border text-brand focus:ring-ring/50';

  const dim = daysInMonth(viewYear, viewMonth);
  const firstDow = new Date(viewYear, viewMonth - 1, 1).getDay(); // 0 Sun

  return (
    <div className={`relative ${className}`} ref={rootRef}>
      {(label || allowPresent) && (
        <div className="mb-1 flex items-center justify-between gap-2">
          {label ? <div className="text-xs font-medium text-muted-foreground">{label}</div> : <span />}
          {allowPresent ? (
            <label className="inline-flex cursor-pointer items-center gap-1.5 select-none">
              <input
                type="checkbox"
                checked={isPresent}
                onChange={(e) => setPresent(e.target.checked)}
                className={checkCls}
              />
              <span className={`font-semibold text-muted-foreground ${size === 'md' ? 'text-xs' : 'text-[11px]'}`}>
                Present
              </span>
            </label>
          ) : null}
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          if (isPresent) return;
          setOpen((s) => !s);
        }}
        disabled={isPresent}
        className={`${triggerCls} flex items-center justify-between gap-2 text-left${
          hasError ? ' ring-2 ring-destructive/30 border-destructive/40' : ''
        }${isPresent ? ' cursor-default bg-muted/50 text-foreground' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-disabled={isPresent}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <CalendarDays className={`shrink-0 text-muted-foreground ${size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'}`} />
          <span className={`truncate ${hasValue ? 'text-foreground' : 'text-muted-foreground'}`}>{triggerLabel}</span>
        </span>
        {!isPresent ? (
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition ${open ? 'rotate-180' : ''}`} />
        ) : null}
      </button>

      {open && !isPresent && (
        <div className="absolute bg-popover text-popover-foreground left-0 z-40 mt-1.5 w-[280px] rounded-xl border border-border p-3 shadow-xl">
          {allowPresent ? (
            <label className="mb-2.5 flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-muted/50 px-2.5 py-2 select-none">
              <input
                type="checkbox"
                checked={false}
                onChange={(e) => {
                  if (e.target.checked) setPresent(true);
                }}
                className="h-3.5 w-3.5 rounded border-border text-brand focus:ring-ring/50"
              />
              <span className="text-xs font-semibold text-foreground">Present (current role)</span>
            </label>
          ) : null}

          <div className="mb-2.5 inline-flex w-full rounded-lg border border-border bg-muted/50 p-0.5">
            {([
              ['year', 'Year'],
              ['month', 'Month'],
              ['day', 'Day'],
            ] as const).map(([id, text]) => (
              <button
                key={id}
                type="button"
                onClick={() => switchPrecision(id)}
                className={`flex-1 rounded-md px-2 py-1 text-[11px] font-semibold transition ${
                  precision === id ? 'bg-card text-brand shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {text}
              </button>
            ))}
          </div>

          <div className="mb-2.5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewYear((y) => y - 1)}
              className="rounded-lg border border-border bg-card p-1.5 text-muted-foreground hover:bg-brand-soft"
              aria-label="Previous year"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (precision === 'year') pickYear(viewYear);
              }}
              className={`rounded-lg px-2 py-1 text-sm font-bold transition ${
                precision === 'year' && parsed?.year === viewYear && parsed.precision === 'year'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-foreground hover:bg-brand-soft'
              }`}
            >
              {viewYear}
            </button>
            <button
              type="button"
              onClick={() => setViewYear((y) => y + 1)}
              className="rounded-lg border border-border bg-card p-1.5 text-muted-foreground hover:bg-brand-soft"
              aria-label="Next year"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {precision !== 'year' && (
            <div className="mb-2 grid grid-cols-4 gap-1.5">
              {MONTH_NAMES.map((m, idx) => {
                const monthNum = idx + 1;
                const isActive =
                  parsed?.year === viewYear &&
                  parsed?.month === monthNum &&
                  (parsed.precision === 'month' || parsed.precision === 'day');
                const isView = precision === 'day' && viewMonth === monthNum;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => pickMonth(monthNum)}
                    className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition ${
                      isActive
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : isView
                          ? 'bg-brand-soft text-brand'
                          : 'bg-card/90 text-foreground hover:bg-brand-soft'
                    }`}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          )}

          {precision === 'day' && (
            <div className="mb-1">
              <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-0.5">
                {Array.from({ length: firstDow }).map((_, i) => (
                  <span key={`pad-${i}`} />
                ))}
                {Array.from({ length: dim }, (_, i) => i + 1).map((day) => {
                  const isActive =
                    parsed?.precision === 'day' &&
                    parsed.year === viewYear &&
                    parsed.month === viewMonth &&
                    parsed.day === day;
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => pickDay(day)}
                      className={`rounded-md py-1.5 text-xs font-semibold transition ${
                        isActive
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-foreground hover:bg-brand-soft'
                      }`}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mt-2.5 flex items-center justify-between gap-2 text-xs">
            <button
              type="button"
              onClick={() => {
                if (allowPresent) setPresent(true);
                else {
                  commit('');
                  setOpen(false);
                }
              }}
              className="font-semibold text-muted-foreground hover:text-foreground"
            >
              {allowPresent ? 'Present' : 'Clear'}
            </button>
            <button
              type="button"
              onClick={() => {
                const next = todayValue(precision);
                commit(next);
                const t = new Date();
                setViewYear(t.getFullYear());
                setViewMonth(t.getMonth() + 1);
                setOpen(false);
              }}
              className="font-semibold text-brand hover:text-brand/80"
            >
              {precision === 'year' ? 'This year' : precision === 'month' ? 'This month' : 'Today'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
