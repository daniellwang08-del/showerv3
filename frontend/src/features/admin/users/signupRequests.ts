import { useQuery } from '@tanstack/react-query';
import { fetchSignupRequests } from '@/api/adminApi';

export const signupRequestsKey = ['admin-signup-requests'] as const;
export const SIGNUP_REQUESTS_POLL_MS = 15_000;

export function useSignupRequests(enabled = true) {
  return useQuery({
    queryKey: signupRequestsKey,
    queryFn: fetchSignupRequests,
    refetchInterval: SIGNUP_REQUESTS_POLL_MS,
    enabled,
  });
}

/** Pending signup count for the admin sidebar badge (shares the panel's cache). */
export function usePendingSignupCount(enabled: boolean): number {
  return useSignupRequests(enabled).data?.length ?? 0;
}
