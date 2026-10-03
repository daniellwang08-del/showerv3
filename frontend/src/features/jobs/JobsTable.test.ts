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
    expect(cols.map((c) => c.id)).toEqual(['select', 'title', 'match', 'track']);
    const minimum = cols.reduce((sum, c) => sum + fixedWidth(c.width), 0);
    expect(minimum).toBeLessThanOrEqual(390 - 32 - 96);
  });

  it('keeps desktop widths for wider tiers', () => {
    const title = columnsFor('full').find((c) => c.id === 'title');
    expect(title?.width).toBe('minmax(16rem, 1fr)');
  });
});
