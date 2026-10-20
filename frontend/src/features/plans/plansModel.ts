/** Credit packages: one credit prepares one job (tailored resume and cover letter). */

export const SIGNUP_CREDITS = 50;
/** Pay-as-you-go reference rate the savings are measured against. */
export const BASE_RATE_CENTS = 10;

export type CreditPackage = {
  id: 'starter' | 'growth' | 'pro' | 'scale';
  name: string;
  credits: number;
  /** Price per credit in cents. */
  rateCents: number;
  tagline: string;
  badge?: 'popular' | 'value';
};

export const PACKAGES: readonly CreditPackage[] = [
  { id: 'starter', name: 'Starter', credits: 250, rateCents: 10, tagline: 'Try a focused search for a few weeks.' },
  { id: 'growth', name: 'Growth', credits: 500, rateCents: 9, tagline: 'Steady applying across a month or two.' },
  {
    id: 'pro',
    name: 'Pro',
    credits: 1000,
    rateCents: 8,
    tagline: 'For an active search at full speed.',
    badge: 'popular',
  },
  {
    id: 'scale',
    name: 'Scale',
    credits: 10000,
    rateCents: 5,
    tagline: 'High-volume applying, half the per-job price.',
    badge: 'value',
  },
];

const count = new Intl.NumberFormat('en-US');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const formatCount = (n: number) => count.format(n);

export function formatUsd(cents: number): string {
  return usd.format(cents / 100);
}

/** Per-credit price, always with two decimals ($0.08). */
export function formatRate(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function totalCents(pkg: CreditPackage): number {
  return pkg.credits * pkg.rateCents;
}

/** Percent saved against the base rate, rounded to a whole number. */
export function savingsPercent(pkg: CreditPackage): number {
  return Math.round((1 - pkg.rateCents / BASE_RATE_CENTS) * 100);
}

/** Dollars saved against buying the same credits at the base rate. */
export function savingsCents(pkg: CreditPackage): number {
  return pkg.credits * (BASE_RATE_CENTS - pkg.rateCents);
}

const WEEKS_PER_MONTH = 52 / 12;

export function monthlyJobs(jobsPerWeek: number): number {
  return Math.round(Math.max(0, jobsPerWeek) * WEEKS_PER_MONTH);
}

/** Smallest package that covers a month at this pace, else the largest. */
export function recommendPackage(jobsPerWeek: number): CreditPackage {
  const need = monthlyJobs(jobsPerWeek);
  return PACKAGES.find((p) => p.credits >= need) ?? PACKAGES[PACKAGES.length - 1];
}

/** Whole weeks a package lasts at this pace (Infinity when nothing is prepared). */
export function weeksCovered(pkg: CreditPackage, jobsPerWeek: number): number {
  if (jobsPerWeek <= 0) return Infinity;
  return Math.floor(pkg.credits / jobsPerWeek);
}

export function describeDuration(weeks: number): string {
  if (!Number.isFinite(weeks)) return 'as long as you need';
  if (weeks < 1) return 'less than a week';
  if (weeks < 9) return `about ${weeks} week${weeks === 1 ? '' : 's'}`;
  const months = Math.floor(weeks / WEEKS_PER_MONTH);
  if (months < 24) return `about ${months} months`;
  return `about ${Math.floor(months / 12)} years`;
}
