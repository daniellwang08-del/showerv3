import { apiClient } from './client';
import type { UserProfile } from '../types/profile';
import type { AddressInfo, EEOPreferences, ProfileFormData } from '../types/profile';
import { profileFormToPayload } from '../utils/profilePayload';
import { profileToForm } from '../utils/profileFormData';

export async function fetchUserProfile(): Promise<UserProfile | null> {
  try {
    const { data } = await apiClient.get<UserProfile>('/profile');
    return data ?? null;
  } catch (err: unknown) {
    const status =
      err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { status?: number } }).response?.status
        : undefined;
    if (status === 404) return null;
    throw err;
  }
}

export async function saveUserProfile(form: ProfileFormData): Promise<UserProfile> {
  const { data } = await apiClient.put<UserProfile>('/profile', profileFormToPayload(form));
  return data;
}

/** Preferences-only EEO save, does not revalidate the résumé body. */
export async function saveEeoPreferences(eeo: EEOPreferences): Promise<UserProfile> {
  const emptyToNull = (s: string | undefined) => (s?.trim() ? s.trim() : null);
  const body = {
    gender: emptyToNull(eeo.gender ?? undefined),
    race: emptyToNull(eeo.race ?? undefined),
    sexual_orientation: emptyToNull(eeo.sexual_orientation ?? undefined),
    hispanic_latino: eeo.hispanic_latino ?? null,
    veteran_status: eeo.veteran_status ?? null,
    disability_status: eeo.disability_status ?? null,
    work_authorized: eeo.work_authorized ?? null,
    needs_sponsorship: eeo.needs_sponsorship ?? null,
  };
  const { data } = await apiClient.patch<UserProfile>('/profile/eeo', body);
  return data;
}

/** Preferences-only address save, does not revalidate the résumé body. */
export async function saveAddressPreferences(address: AddressInfo): Promise<UserProfile> {
  const emptyToNull = (s: string | undefined) => (s?.trim() ? s.trim() : null);
  const body = {
    line1: emptyToNull(address.line1 ?? undefined),
    line2: emptyToNull(address.line2 ?? undefined),
    city: emptyToNull(address.city ?? undefined),
    state: emptyToNull(address.state ?? undefined),
    postal_code: emptyToNull(address.postal_code ?? undefined),
    country: emptyToNull(address.country ?? undefined),
    local_preferences: (address.local_preferences ?? [])
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean)
      .slice(0, 30),
  };
  const { data } = await apiClient.patch<UserProfile>('/profile/address', body);
  return data;
}

/** Load profile as form data (empty form if none yet). */
export async function fetchProfileForm(): Promise<ProfileFormData> {
  const profile = await fetchUserProfile();
  return profileToForm(profile);
}
