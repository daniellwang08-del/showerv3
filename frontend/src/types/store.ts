export type PackageCode = 'starter' | 'growth' | 'pro' | 'scale' | 'team';
export type PackageKind = 'credits' | 'team';

export interface StorePerson {
  id: string;
  name: string;
  email: string;
}

export interface StorePackage {
  id: string;
  code: PackageCode;
  kind: PackageKind;
  name: string;
  credits: number;
  price_cents: number;
  status: 'held' | 'redeemed' | 'revoked';
  source: 'admin_grant' | 'purchase' | 'gift';
  owner: StorePerson | null;
  /** Set while a gift waits for an email that has no account yet. */
  pending_email: string | null;
  gifted_from: StorePerson | null;
  /** Message from the admin who granted it. */
  note?: string | null;
  redeemed_at: string | null;
  team_space: { id: string; public_id: string; name: string } | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CatalogEntry {
  code: PackageCode;
  kind: PackageKind;
  name: string;
  credits: number;
  price_cents: number;
}

export interface StoreResponse {
  balance: number;
  held: StorePackage[];
  used: StorePackage[];
  given: StorePackage[];
  catalog: CatalogEntry[];
}

export interface LedgerEntry {
  id: string;
  delta: number;
  balance_after: number;
  reason:
    | 'signup_bonus'
    | 'package'
    | 'admin_adjust'
    | 'job_prepare'
    | 'job_prepare_refund'
    | 'tailor'
    | 'tailor_refund'
    | string;
  note: string | null;
  created_at: string | null;
}

export interface AdminPackage extends StorePackage {
  granted_by: StorePerson | null;
  revoked_at: string | null;
  revoked_by: StorePerson | null;
  revoke_reason: string | null;
}

/** Admin view of a package's state; "waiting" is held by an email with no account yet. */
export type AdminPackageStatus = 'held' | 'waiting' | 'redeemed' | 'revoked';

export interface AdminPackagePage {
  total: number;
  items: AdminPackage[];
}

export interface AdminStoreOverview {
  totals: Record<AdminPackageStatus, number>;
  by_code: Record<string, Record<AdminPackageStatus, number>>;
  unused_credits: number;
  granted_value_cents: number;
  credit_balance_total: number;
  users_with_credits: number;
  holders: number;
  team_spaces: number;
  grant_trend: Array<{ date: string; count: number }>;
  catalog: CatalogEntry[];
}

export interface BulkGrantResult {
  granted: Array<{ email: string; user: StorePerson | null; pending: boolean; count: number }>;
  skipped: Array<{ email: string; reason: string }>;
  total_packages: number;
}

export interface AdminStoreSummary {
  balance: number;
  held: Partial<Record<PackageCode, number>>;
  held_packages: AdminPackage[];
  team_spaces: number;
  ledger: LedgerEntry[];
  catalog: CatalogEntry[];
}
