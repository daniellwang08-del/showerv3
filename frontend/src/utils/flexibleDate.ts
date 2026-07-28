/** Flexible resume dates: year (`2020`), year-month (`2020-01`), or full day (`2020-01-15`). */

export type DatePrecision = 'year' | 'month' | 'day';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type ParsedFlexibleDate = {
  year: number;
  month?: number;
  day?: number;
  precision: DatePrecision;
};

export function parseFlexibleDate(raw: string | null | undefined): ParsedFlexibleDate | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (/^present$/i.test(v)) return null;
  const day = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) {
    const y = Number(day[1]);
    const m = Number(day[2]);
    const d = Number(day[3]);
    if (y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { year: y, month: m, day: d, precision: 'day' };
    }
    return null;
  }
  const month = v.match(/^(\d{4})-(\d{2})$/);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    if (y >= 1900 && y <= 2100 && m >= 1 && m <= 12) {
      return { year: y, month: m, precision: 'month' };
    }
    return null;
  }
  if (/^\d{4}$/.test(v)) {
    const y = Number(v);
    if (y >= 1900 && y <= 2100) return { year: y, precision: 'year' };
  }
  return null;
}

export function formatFlexibleDate(raw: string | null | undefined, empty = ''): string {
  const v = (raw ?? '').trim();
  if (!v) return empty;
  if (/^present$/i.test(v)) return 'Present';
  const parsed = parseFlexibleDate(v);
  if (!parsed) return v;
  if (parsed.precision === 'year') return String(parsed.year);
  const mon = MONTH_NAMES[(parsed.month ?? 1) - 1];
  if (parsed.precision === 'month') return `${mon} ${parsed.year}`;
  return `${mon} ${parsed.day}, ${parsed.year}`;
}

export function formatFlexiblePeriod(start?: string | null, end?: string | null): string {
  const s = formatFlexibleDate(start);
  const e = formatFlexibleDate(end);
  if (s && e) return `${s} - ${e}`;
  if (s) return `${s} - Present`;
  return e || '';
}

export function buildFlexibleDate(precision: DatePrecision, year: number, month?: number, day?: number): string {
  if (precision === 'year') return String(year);
  const m = Math.min(12, Math.max(1, month ?? 1));
  if (precision === 'month') return `${year}-${String(m).padStart(2, '0')}`;
  const dim = daysInMonth(year, m);
  const d = Math.min(dim, Math.max(1, day ?? 1));
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Comparable integer for ordering across precisions (year < month < day within same period). */
export function flexibleDateSortKey(raw: string | null | undefined): number | null {
  const p = parseFlexibleDate(raw);
  if (!p) return null;
  const m = p.month ?? 0;
  const d = p.day ?? 0;
  return p.year * 10000 + m * 100 + d;
}

export function isFlexibleDateAfter(a: string, b: string): boolean {
  const ka = flexibleDateSortKey(a);
  const kb = flexibleDateSortKey(b);
  if (ka == null || kb == null) return false;
  return ka > kb;
}

export { MONTH_NAMES };
