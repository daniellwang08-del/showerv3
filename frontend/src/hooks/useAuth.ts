import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import { requestOnce } from '../utils/requestOnce';

export type AuthPage = 'login' | 'signup';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** The API marks "signed in, but the signup still waits for an admin" with this header on a 403. */
export function isPendingApprovalError(error: unknown): boolean {
  const res = (error as { response?: { status?: number; headers?: Record<string, unknown> } })?.response;
  return res?.status === 403 && res.headers?.['x-auth-status'] === 'pending';
}

/** Server explanation when a session ended because the signup was declined. */
function rejectionNotice(error: unknown): string | null {
  const res = (error as { response?: { status?: number; headers?: Record<string, unknown>; data?: { detail?: unknown } } })
    ?.response;
  if (res?.status !== 401 || res.headers?.['x-auth-status'] !== 'rejected') return null;
  return typeof res.data?.detail === 'string' ? res.data.detail : null;
}

export type AuthUser = {
  id?: string;
  email?: string;
  name?: string | null;
  display_name?: string;
  is_active?: boolean;
  is_admin?: boolean;
  created_at?: string;
  approval_status?: ApprovalStatus;
  approved_at?: string | null;
  // Subscription snapshot mirrored from Stripe (see /auth/me).
  is_subscribed?: boolean;
  subscription_plan?: string | null;
  subscription_status?: string | null;
  subscription_current_period_end?: string | null;
  subscription_cancel_at_period_end?: boolean;
};

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authPage, setAuthPage] = useState<AuthPage>('login');
  // Signed in with a pending signup: only the approval screen is reachable.
  const [pendingApproval, setPendingApproval] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  // Fetch (or refetch) the current user from /auth/me. Returns the user or null.
  // Used on mount, right after login/signup, and after a profile update so the
  // sidebar name/avatar always reflect the real account instead of the "User"
  // fallback that shows while `user` is still null.
  const refreshUser = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const res = await apiClient.get('/auth/me');
      const nextUser: AuthUser | null = res.data ?? null;
      setUser(nextUser);
      setPendingApproval(false);
      setIsAuthenticated(true);
      return nextUser;
    } catch (error) {
      setUser(null);
      setPendingApproval(isPendingApprovalError(error));
      const notice = rejectionNotice(error);
      if (notice) setAuthNotice(notice);
      setIsAuthenticated(false);
      return null;
    }
  }, []);

  useEffect(() => {
    void requestOnce('auth:me', () => refreshUser());

    const interceptor = apiClient.interceptors.response.use(
      (response) => response,
      (error) => {
        // A 401 should sign the user out ONLY when it is about the NAO
        // session itself. Third-party integration endpoints (e.g. connecting a
        // job board) can return 401/downstream-auth errors that say nothing
        // about the NAO token, treating those as a logout wrongly
        // bounced the user to the sign-in page. Never force-logout for those.
        const url: string = error.config?.url ?? '';
        const isIntegrationAuthError = url.includes('/job-sites/');
        if (error.response?.status === 401 && !isIntegrationAuthError) {
          const notice = rejectionNotice(error);
          if (notice) setAuthNotice(notice);
          setIsAuthenticated(false);
          setPendingApproval(false);
          setUser(null);
        }
        return Promise.reject(error);
      },
    );

    return () => apiClient.interceptors.response.eject(interceptor);
  }, [refreshUser]);

  const logout = useCallback(async () => {
    try {
      await apiClient.post('/auth/logout');
    } finally {
      setIsAuthenticated(false);
      setPendingApproval(false);
      setUser(null);
    }
  }, []);

  const onAuthSuccess = useCallback(async () => {
    // Pull the freshly authenticated account so the sidebar shows the real
    // name/email immediately instead of the "User" fallback (previously `user`
    // stayed null until a full page reload re-ran /auth/me).
    setAuthNotice(null);
    await refreshUser();
    setAuthPage('login');
  }, [refreshUser]);

  const getUserInitial = useCallback((): string => {
    if (user?.name) return user.name.charAt(0).toUpperCase();
    if (user?.email) return user.email.charAt(0).toUpperCase();
    return 'U';
  }, [user?.email, user?.name]);

  return {
    isAuthenticated,
    pendingApproval,
    authNotice,
    user,
    authPage,
    setAuthPage,
    logout,
    onAuthSuccess,
    refreshUser,
    getUserInitial,
    setIsAuthenticated,
    setUser,
  };
}
