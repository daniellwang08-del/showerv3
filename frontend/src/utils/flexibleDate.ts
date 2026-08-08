/** Flexible resume dates: year (`2020`), year-month (`2020-01`), or full day (`2020-01-15`). */

export type DatePrecision = 'year' | 'month' | 'day';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const MONTH_LOOKUP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

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

function monthNum(token: string): number | undefined {
  return MONTH_LOOKUP[token.replace(/\./g, '').toLowerCase()];
}

function validYmd(year: number, month?: number, day?: number): boolean {
  if (year < 1900 || year > 2100) return false;
  if (month != null && (month < 1 || month > 12)) return false;
  if (day != null && (day < 1 || day > 31)) return false;
  return true;
}

function findDateInText(text: string): string | null {
  const s = text.trim();
  if (!s) return null;

  const monthDayYear = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (monthDayYear) {
    const mon = monthNum(monthDayYear[1]);
    const day = Number(monthDayYear[2]);
    const year = Number(monthDayYear[3]);
    if (mon && validYmd(year, mon, day)) return buildFlexibleDate('day', year, mon, day);
  }

  const dayMonthYear = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (dayMonthYear) {
    const day = Number(dayMonthYear[1]);
    const mon = monthNum(dayMonthYear[2]);
    const year = Number(dayMonthYear[3]);
    if (mon && validYmd(year, mon, day)) return buildFlexibleDate('day', year, mon, day);
  }

  const monthYear = s.match(/\b([A-Za-z]{3,9})\.?\s*,?\s*(\d{4})\b/);
  if (monthYear) {
    const mon = monthNum(monthYear[1]);
    const year = Number(monthYear[2]);
    if (mon && validYmd(year, mon)) return buildFlexibleDate('month', year, mon);
  }

  const mdy = s.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b/);
  if (mdy) {
    const a = Number(mdy[1]);
    const b = Number(mdy[2]);
    const year = Number(mdy[3]);
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31 && validYmd(year, a, b)) {
      return buildFlexibleDate('day', year, a, b);
    }
    if (b >= 1 && b <= 12 && a >= 1 && a <= 31 && validYmd(year, b, a)) {
      return buildFlexibleDate('day', year, b, a);
    }
  }

  const my = s.match(/\b(\d{1,2})[/\-.](\d{4})\b/);
  if (my) {
    const month = Number(my[1]);
    const year = Number(my[2]);
    if (validYmd(year, month)) return buildFlexibleDate('month', year, month);
  }

  const ym = s.match(/\b(\d{4})[/\-.](\d{1,2})\b/);
  if (ym) {
    const year = Number(ym[1]);
    const month = Number(ym[2]);
    if (validYmd(year, month)) return buildFlexibleDate('month', year, month);
  }

  const yearOnly = s.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    if (validYmd(year)) return buildFlexibleDate('year', year);
  }

  return null;
}

/**
 * Normalize free-form date text (e.g. résumé "Aug 2023", "Issued Nov 2021")
 * to canonical YYYY / YYYY-MM / YYYY-MM-DD. Returns '' when empty/unparseable.
 */
export function coerceFlexibleDate(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  if (/^(present|current|now|ongoing)$/i.test(v)) return '';

  const already = parseFlexibleDate(v);
  if (already) {
    return buildFlexibleDate(already.precision, already.year, already.month, already.day);
  }

  const issued = v.match(/\bissued\b([\s\S]*)$/i);
  if (issued) {
    const chunk = issued[1].split(/\bexpired\b/i)[0] ?? '';
    const found = findDateInText(chunk);
    if (found) return found;
  }

  return findDateInText(v) ?? '';
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
