const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Server bounds for an access key's lifetime (see signup_approval_service). */
export const MIN_KEY_LIFETIME_MS = 10 * MINUTE;
export const MAX_KEY_LIFETIME_MS = 365 * DAY;

export type ExpiryPreset = '1h' | '24h' | '3d' | '7d' | '30d' | 'custom';

export const EXPIRY_PRESETS: Array<{ value: ExpiryPreset; label: string; ms?: number }> = [
  { value: '1h', label: '1 hour', ms: HOUR },
  { value: '24h', label: '24 hours', ms: DAY },
  { value: '3d', label: '3 days', ms: 3 * DAY },
  { value: '7d', label: '7 days', ms: 7 * DAY },
  { value: '30d', label: '30 days', ms: 30 * DAY },
  { value: 'custom', label: 'Custom date and time' },
];

/** `YYYY-MM-DDTHH:mm` in local time, the format `<input type="datetime-local">` uses. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/** Resolve the admin's choice to an expiry instant, or an error message. */
export function resolveExpiry(
  preset: ExpiryPreset,
  customValue: string,
  now: Date = new Date(),
): { expiresAt: Date } | { error: string } {
  if (preset !== 'custom') {
    const ms = EXPIRY_PRESETS.find((p) => p.value === preset)?.ms ?? DAY;
    return { expiresAt: new Date(now.getTime() + ms) };
  }
  if (!customValue) return { error: 'Pick an expiry date and time.' };
  const expiresAt = new Date(customValue);
  if (Number.isNaN(expiresAt.getTime())) return { error: 'Pick an expiry date and time.' };
  const delta = expiresAt.getTime() - now.getTime();
  if (delta < MIN_KEY_LIFETIME_MS) return { error: 'Expiry must be at least 10 minutes from now.' };
  if (delta > MAX_KEY_LIFETIME_MS) return { error: 'Expiry cannot be more than 365 days from now.' };
  return { expiresAt };
}
