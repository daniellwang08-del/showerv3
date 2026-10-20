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
  status: 'held' | 'redeemed';
  source: 'admin_grant' | 'purchase' | 'gift';
  owner: StorePerson | null;
  /** Set while a gift waits for an email that has no account yet. */
  pending_email: string | null;
  gifted_from: StorePerson | null;
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
  reason: 'signup_bonus' | 'package' | 'admin_adjust' | string;
  note: string | null;
  created_at: string | null;
}

export interface AdminStoreSummary {
  balance: number;
  held: Partial<Record<PackageCode, number>>;
  team_spaces: number;
  ledger: LedgerEntry[];
  catalog: CatalogEntry[];
}
