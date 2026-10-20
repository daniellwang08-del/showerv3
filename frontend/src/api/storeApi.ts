import { apiClient } from './client';
import type { AdminStoreSummary, LedgerEntry, PackageCode, StorePackage, StoreResponse } from '../types/store';

const pkg = (id: string) => `/store/packages/${encodeURIComponent(id)}`;
const adminUser = (id: string) => `/store/admin/users/${encodeURIComponent(id)}`;

export async function fetchStore(): Promise<StoreResponse> {
  const { data } = await apiClient.get<StoreResponse>('/store');
  return data;
}

export async function fetchLedger(limit = 50): Promise<{ balance: number; entries: LedgerEntry[] }> {
  const { data } = await apiClient.get<{ balance: number; entries: LedgerEntry[] }>('/store/ledger', {
    params: { limit },
  });
  return data;
}

export async function redeemPackage(id: string): Promise<{ balance: number; package: StorePackage }> {
  const { data } = await apiClient.post<{ balance: number; package: StorePackage }>(`${pkg(id)}/redeem`);
  return data;
}

export async function giftPackage(id: string, email: string): Promise<StorePackage> {
  const { data } = await apiClient.post<StorePackage>(`${pkg(id)}/gift`, { email });
  return data;
}

export async function cancelGift(id: string): Promise<StorePackage> {
  const { data } = await apiClient.post<StorePackage>(`${pkg(id)}/cancel-gift`);
  return data;
}

export async function fetchAdminStore(userId: string): Promise<AdminStoreSummary> {
  const { data } = await apiClient.get<AdminStoreSummary>(adminUser(userId));
  return data;
}

export async function adminGrant(
  userId: string,
  code: PackageCode,
  quantity: number,
): Promise<{ packages: StorePackage[]; summary: AdminStoreSummary }> {
  const { data } = await apiClient.post<{ packages: StorePackage[]; summary: AdminStoreSummary }>(
    `${adminUser(userId)}/grant`,
    { code, quantity },
  );
  return data;
}

export async function adminAdjust(userId: string, delta: number, note: string): Promise<AdminStoreSummary> {
  const { data } = await apiClient.post<AdminStoreSummary>(`${adminUser(userId)}/adjust`, { delta, note });
  return data;
}
