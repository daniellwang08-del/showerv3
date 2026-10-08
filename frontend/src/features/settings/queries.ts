import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchOriginalResume, fetchUserSettings } from '@/api/settingsApi';
import { fetchProfileForm } from '@/api/profileApi';
import { useJobsStore } from '@/stores/jobsStore';
import { useScraperStore } from '@/stores/scraperStore';
import type { UserSettings } from '@/types/settings';

export const SETTINGS_KEY = ['settings'] as const;
export const PROFILE_FORM_KEY = ['profile', 'form'] as const;
export const ORIGINAL_RESUME_KEY = ['profile', 'original-resume'] as const;

export function useSettingsQuery() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchUserSettings });
}

export function useOriginalResumeQuery() {
  return useQuery({ queryKey: ORIGINAL_RESUME_KEY, queryFn: fetchOriginalResume });
}

export function useProfileFormQuery() {
  return useQuery({ queryKey: PROFILE_FORM_KEY, queryFn: fetchProfileForm });
}

export function useSetSettings() {
  const queryClient = useQueryClient();
  return (next: UserSettings) => queryClient.setQueryData(SETTINGS_KEY, next);
}

/** Reload dashboard lists after server-side hide/restore passes. */
export function refreshJobStores() {
  void useJobsStore.getState().refreshLists({ showLoading: false, reset: true });
  void useScraperStore.getState().loadJobs();
}
