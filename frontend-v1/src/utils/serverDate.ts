/**
 * Parse datetimes from the API (FastAPI/Pydantic ISO strings).
 * Handles occasional "YYYY-MM-DD HH:MM:SS" shapes that Date.parse may reject.
 */
export function parseServerDateTime(value: string | null | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  let ms = Date.parse(value);
  if (!Number.isNaN(ms)) return ms;
  const normalized = value.includes('T') ? value : value.trim().replace(' ', 'T');
  ms = Date.parse(normalized);
  if (!Number.isNaN(ms)) return ms;
  return undefined;
}

/**
 * Normalize API / state timestamps to epoch milliseconds.
 * Handles finite numbers, ISO strings, and numeric strings (ms).
 */
export function toFiniteTimeMs(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === '') return undefined;
    if (/^\d{13}$/.test(t)) {
      const n = Number(t);
      return Number.isFinite(n) ? n : undefined;
    }
    return parseServerDateTime(t);
  }
  return undefined;
}

/** Stable local calendar identity for bucketing charts (avoids Set(ms) mismatches). */
export function localCalendarDayKey(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Stable local calendar month (year + month index) for monthly pipeline buckets. */
export function localCalendarMonthKey(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth()}`;
}
