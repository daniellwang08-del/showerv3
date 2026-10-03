import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coalesce } from './coalesce';

describe('coalesce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the first call immediately and folds a burst into one trailing call', () => {
    const fn = vi.fn();
    const run = coalesce(fn, 2000);

    run();
    expect(fn).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 20; i++) run();
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('runs immediately again once the window has passed', () => {
    const fn = vi.fn();
    const run = coalesce(fn, 2000);

    run();
    vi.advanceTimersByTime(2500);
    run();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
