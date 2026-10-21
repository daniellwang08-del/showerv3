import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchProfilePhoto, removeProfilePhoto, saveProfilePhoto } from '../api/profilePhotoApi';

export const PROFILE_PHOTO_KEY = ['profile-photo'] as const;

export function useProfilePhoto(enabled = true) {
  return useQuery({ queryKey: PROFILE_PHOTO_KEY, queryFn: fetchProfilePhoto, enabled, staleTime: 5 * 60_000 });
}

/** Save (data URL) or remove (null) the profile photo and refresh every avatar. */
export function useSetProfilePhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dataUrl: string | null) => {
      if (!dataUrl) {
        await removeProfilePhoto();
        return null;
      }
      return saveProfilePhoto(dataUrl);
    },
    onSuccess: (photo) => qc.setQueryData(PROFILE_PHOTO_KEY, photo),
  });
}
