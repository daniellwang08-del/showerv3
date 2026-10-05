import { describe, expect, it } from 'vitest';
import { resolveExpiry, toLocalInputValue } from './accessKeyExpiry';

const NOW = new Date('2026-10-05T12:00:00');
const HOUR = 60 * 60 * 1000;

describe('resolveExpiry', () => {
  it('adds the preset duration to now', () => {
    const r = resolveExpiry('7d', '', NOW);
    expect('expiresAt' in r && r.expiresAt.getTime() - NOW.getTime()).toBe(7 * 24 * HOUR);
  });

  it('accepts a custom local date and time within bounds', () => {
    const r = resolveExpiry('custom', '2026-10-20T09:30', NOW);
    expect('expiresAt' in r && toLocalInputValue(r.expiresAt)).toBe('2026-10-20T09:30');
  });

  it('rejects custom values that are missing, too soon, or too far out', () => {
    expect(resolveExpiry('custom', '', NOW)).toEqual({ error: 'Pick an expiry date and time.' });
    expect(resolveExpiry('custom', toLocalInputValue(new Date(NOW.getTime() + 5 * 60 * 1000)), NOW)).toEqual({
      error: 'Expiry must be at least 10 minutes from now.',
    });
    expect(resolveExpiry('custom', '2027-12-01T00:00', NOW)).toEqual({
      error: 'Expiry cannot be more than 365 days from now.',
    });
  });
});
