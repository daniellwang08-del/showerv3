import { apiClient } from './client';

export async function fetchProfilePhoto(): Promise<string | null> {
  const { data } = await apiClient.get<{ photo: string | null }>('/profile/photo');
  return data.photo ?? null;
}

export async function saveProfilePhoto(dataUrl: string): Promise<string | null> {
  const { data } = await apiClient.put<{ photo: string | null }>('/profile/photo', { data_url: dataUrl });
  return data.photo ?? null;
}

export async function removeProfilePhoto(): Promise<void> {
  await apiClient.delete('/profile/photo');
}
