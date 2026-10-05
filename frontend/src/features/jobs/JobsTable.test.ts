import { describe, expect, it } from 'vitest';
import { columnsFor } from './JobsTable';

const REM = 16;

function fixedWidth(width: string): number {
  const min = width.match(/minmax\(([\d.]+)rem/);
  if (min) return Number(min[1]) * REM;
  if (width.startsWith('minmax(0')) return 0;
  return Number.parseFloat(width) * REM;
}

describe('columnsFor', () => {
  it('fits the compact tier on a 390px phone', () => {
    const cols = columnsFor('compact');
    expect(cols.map((c) => c.id)).toEqual(['select', 'title', 'location', 'match', 'track']);
    const minimum = cols.reduce((sum, c) => sum + fixedWidth(c.width), 0);
    expect(minimum).toBeLessThanOrEqual(390 - 32 - 96);
  });

  it('shares spare width between role, location, source and status on wide tables', () => {
    const cols = columnsFor('full');
    expect(cols.find((c) => c.id === 'title')?.width).toBe('minmax(12rem, 1.4fr)');
    expect(cols.find((c) => c.id === 'location')?.width).toBe('minmax(10rem, 1.3fr)');
    expect(cols.find((c) => c.id === 'source')?.width).toBe('minmax(7.5rem, 1fr)');
    expect(cols.find((c) => c.id === 'status')?.width).toBe('minmax(9.5rem, 1fr)');
    expect(cols.find((c) => c.id === 'mode')?.width).toBe('5.5rem');
    expect(cols.find((c) => c.id === 'posted')?.width).toBe('4.5rem');
    expect(cols.find((c) => c.id === 'added')?.width).toBe('4.5rem');
    expect(cols.find((c) => c.id === 'match')?.width).toBe('7.5rem');
    expect(cols.find((c) => c.id === 'docs')?.width).toBe('5rem');
  });

  it('sizes the actions column to its inline buttons', () => {
    const ctx = { sheetsConfigured: true, pumbleConfigured: false };
    const width = (tier: 'full' | 'medium') => columnsFor(tier, ctx).find((c) => c.id === 'track')?.width;
    expect(width('full')).toBe('14.75rem');
    expect(width('medium')).toBe('7.25rem');
    expect(columnsFor('compact', ctx).find((c) => c.id === 'track')?.width).toBe('4rem');
  });
});
