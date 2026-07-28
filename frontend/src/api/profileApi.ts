import { apiClient } from './client';
import type { UserProfile } from '../types/profile';
import type { ProfileFormData } from '../types/profile';
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

/** Load profile as form data (empty form if none yet). */
export async function fetchProfileForm(): Promise<ProfileFormData> {
  const profile = await fetchUserProfile();
  return profileToForm(profile);
}
