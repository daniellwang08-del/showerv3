import { describe, expect, it } from 'vitest';
import { LOW_CREDITS, creditBadge } from './storeModel';

describe('creditBadge', () => {
  it('shows a plain balance when there is enough to work with', () => {
    expect(creditBadge(50)).toEqual({ text: '50 credits', label: '50 credits available', level: 'ok' });
    expect(creditBadge(1250)).toEqual({ text: '1,250 credits', label: '1,250 credits available', level: 'ok' });
  });

  it('shortens very large balances but keeps the exact count in the label', () => {
    expect(creditBadge(12_500)).toEqual({ text: '12.5k credits', label: '12,500 credits available', level: 'ok' });
  });

  it('warns when the balance runs low', () => {
    expect(creditBadge(LOW_CREDITS).level).toBe('low');
    expect(creditBadge(LOW_CREDITS + 1).level).toBe('ok');
    expect(creditBadge(1)).toEqual({ text: '1 credit', label: '1 credit available, running low', level: 'low' });
  });

  it('flags an empty balance', () => {
    expect(creditBadge(0)).toEqual({ text: 'No credits', label: 'No credits left', level: 'empty' });
    expect(creditBadge(-3).level).toBe('empty');
  });
});
