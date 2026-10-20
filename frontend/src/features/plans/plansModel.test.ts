import { describe, expect, it } from 'vitest';
import {
  PACKAGES,
  describeDuration,
  formatRate,
  formatUsd,
  monthlyJobs,
  recommendPackage,
  savingsCents,
  savingsPercent,
  totalCents,
  weeksCovered,
} from './plansModel';

const byId = (id: string) => PACKAGES.find((p) => p.id === id)!;

describe('credit packages', () => {
  it('prices each package from its credits and per-credit rate', () => {
    expect(PACKAGES.map((p) => [p.credits, formatRate(p.rateCents), formatUsd(totalCents(p))])).toEqual([
      [250, '$0.10', '$25'],
      [500, '$0.09', '$45'],
      [1000, '$0.08', '$80'],
      [10000, '$0.05', '$500'],
    ]);
  });

  it('measures savings against the base rate', () => {
    expect(PACKAGES.map(savingsPercent)).toEqual([0, 10, 20, 50]);
    expect(formatUsd(savingsCents(byId('pro')))).toBe('$20');
    expect(formatUsd(savingsCents(byId('scale')))).toBe('$500');
  });

  it('suggests the smallest package that covers a month', () => {
    expect(monthlyJobs(40)).toBe(173);
    expect(recommendPackage(40).id).toBe('starter');
    expect(recommendPackage(100).id).toBe('growth');
    expect(recommendPackage(200).id).toBe('pro');
    expect(recommendPackage(300).id).toBe('scale');
    expect(recommendPackage(5000).id).toBe('scale');
  });

  it('describes how long credits last', () => {
    expect(weeksCovered(byId('starter'), 40)).toBe(6);
    expect(describeDuration(6)).toBe('about 6 weeks');
    expect(describeDuration(1)).toBe('about 1 week');
    expect(describeDuration(0)).toBe('less than a week');
    expect(describeDuration(weeksCovered(byId('scale'), 40))).toBe('about 4 years');
    expect(describeDuration(weeksCovered(byId('pro'), 0))).toBe('as long as you need');
  });
});
