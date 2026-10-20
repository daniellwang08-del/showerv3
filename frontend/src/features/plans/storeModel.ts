import type { LedgerEntry, StorePackage } from '@/types/store';

export const STORE_KEY = ['store'] as const;
export const TEAM_OVERVIEW_KEY = ['teams', 'overview'] as const;

const ORDER: Record<string, number> = { team: 0, scale: 1, pro: 2, growth: 3, starter: 4 };

export type HeldGroup = {
  key: string;
  code: StorePackage['code'];
  origin: string;
  first: StorePackage;
  items: StorePackage[];
};

export function packageOrigin(pkg: StorePackage): string {
  if (pkg.source === 'gift') return `Gift from ${pkg.gifted_from?.name ?? 'another NAO user'}`;
  if (pkg.source === 'purchase') return 'Purchased';
  return 'Added by NAO';
}

/** Identical held packages from the same origin and note collapse into one card with a count. */
export function groupHeld(held: StorePackage[]): HeldGroup[] {
  const groups = new Map<string, HeldGroup>();
  for (const pkg of held) {
    const origin = packageOrigin(pkg);
    const key = `${pkg.code}:${origin}:${pkg.note ?? ''}`;
    const group = groups.get(key);
    if (group) group.items.push(pkg);
    else groups.set(key, { key, code: pkg.code, origin, first: pkg, items: [pkg] });
  }
  return [...groups.values()].sort((a, b) => (ORDER[a.code] ?? 9) - (ORDER[b.code] ?? 9));
}

export function ledgerLabel(entry: LedgerEntry): string {
  switch (entry.reason) {
    case 'signup_bonus':
      return 'Welcome credits';
    case 'package':
      return entry.note ?? 'Credit package';
    case 'admin_adjust':
      return entry.note ?? 'Adjusted by NAO';
    default:
      return entry.note ?? 'Balance change';
  }
}

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : dateFmt.format(d);
}
