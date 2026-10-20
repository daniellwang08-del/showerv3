import type { AdminUser } from '@/types/admin';
import type { AdminPackage, AdminPackageStatus, CatalogEntry, PackageCode } from '@/types/store';

export const ADMIN_STORE_KEY = ['admin', 'store'] as const;
export const OVERVIEW_KEY = [...ADMIN_STORE_KEY, 'overview'] as const;
export const PACKAGES_KEY = [...ADMIN_STORE_KEY, 'packages'] as const;
export const PAGE_SIZE = 50;
export const MAX_QUANTITY = 20;
export const MAX_RECIPIENTS = 100;

export const STATUS_META: Record<AdminPackageStatus, { label: string; hint: string; dot: string; chip: string }> = {
  held: {
    label: 'Unused',
    hint: 'In a store, ready to use',
    dot: 'bg-brand',
    chip: 'border-brand/30 bg-brand-soft text-brand',
  },
  waiting: {
    label: 'Awaiting signup',
    hint: 'Sent to an email with no account yet',
    dot: 'bg-status-preparing',
    chip: 'border-status-preparing/30 bg-status-preparing/10 text-status-preparing',
  },
  redeemed: {
    label: 'Used',
    hint: 'Became credits or a team space',
    dot: 'bg-status-ready',
    chip: 'border-status-ready/30 bg-status-ready/10 text-status-ready',
  },
  revoked: {
    label: 'Revoked',
    hint: 'Taken back by an admin',
    dot: 'bg-muted-foreground/50',
    chip: 'border-border bg-muted text-muted-foreground',
  },
};

export const STATUS_ORDER: AdminPackageStatus[] = ['held', 'waiting', 'redeemed', 'revoked'];

/** One accent per package so the same package reads the same everywhere on the page. */
export const CODE_TONE: Record<PackageCode, { swatch: string; soft: string; text: string }> = {
  starter: { swatch: 'bg-chart-1', soft: 'bg-chart-1/12', text: 'text-chart-1' },
  growth: { swatch: 'bg-chart-3', soft: 'bg-chart-3/12', text: 'text-chart-3' },
  pro: { swatch: 'bg-brand', soft: 'bg-brand/12', text: 'text-brand' },
  scale: { swatch: 'bg-chart-4', soft: 'bg-chart-4/12', text: 'text-chart-4' },
  team: { swatch: 'bg-chart-2', soft: 'bg-chart-2/12', text: 'text-chart-2' },
};

export const SOURCE_LABEL: Record<AdminPackage['source'], string> = {
  admin_grant: 'Admin grant',
  purchase: 'Purchase',
  gift: 'Gift',
};

export function packageStatus(pkg: AdminPackage): AdminPackageStatus {
  if (pkg.status === 'held') return pkg.owner ? 'held' : 'waiting';
  return pkg.status;
}

const num = new Intl.NumberFormat('en-US');
export const fmt = (n: number) => num.format(n);

export function usd(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function packageSummary(c: Pick<CatalogEntry, 'kind' | 'credits'>): string {
  return c.kind === 'team' ? '1 team space' : `${fmt(c.credits)} credits`;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

export function normalizeEmail(value: string): string | null {
  const email = value.trim().replace(/^<|>$/g, '').trim().toLowerCase();
  return email.length <= 255 && EMAIL_RE.test(email) ? email : null;
}

/** Splits pasted text into new unique emails and the pieces that are not emails. */
export function parseRecipients(text: string, existing: string[] = []): { emails: string[]; invalid: string[] } {
  const seen = new Set(existing);
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    if (!part) continue;
    const email = normalizeEmail(part);
    if (!email) invalid.push(part);
    else if (!seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  }
  return { emails, invalid };
}

export type RecipientState = 'account' | 'new' | 'admin' | 'disabled';

export function recipientState(email: string, byEmail: Map<string, AdminUser>): RecipientState {
  const user = byEmail.get(email);
  if (!user) return 'new';
  if (user.is_admin) return 'admin';
  if (!user.is_active) return 'disabled';
  return 'account';
}

export const RECIPIENT_NOTE: Record<RecipientState, string> = {
  account: 'Has an account',
  new: 'Claims it at signup',
  admin: 'Admins cannot hold packages',
  disabled: 'Account is disabled',
};

export type Bundle = Partial<Record<PackageCode, number>>;

export function bundleTotals(bundle: Bundle, catalog: CatalogEntry[], people: number) {
  let packages = 0;
  let credits = 0;
  let cents = 0;
  let teams = 0;
  for (const c of catalog) {
    const q = bundle[c.code] ?? 0;
    packages += q;
    credits += q * c.credits;
    cents += q * c.price_cents;
    if (c.kind === 'team') teams += q;
  }
  return {
    perPerson: { packages, credits, cents, teams },
    all: { packages: packages * people, credits: credits * people, cents: cents * people, teams: teams * people },
  };
}

const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '-';
  const sec = Math.round((ms - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(sec / 86400), 'day');
  return dateFmt.format(ms);
}

export function fullDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}
