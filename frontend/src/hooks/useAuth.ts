import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import { requestOnce } from '../utils/requestOnce';

export type AuthPage = 'login' | 'signup';

export type AuthUser = {
  id?: string;
  email?: string;
  name?: string | null;
  display_name?: string;
  is_active?: boolean;
  is_admin?: boolean;
  created_at?: string;
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

  // Fetch (or refetch) the current user from /auth/me. Returns the user or null.
  // Used on mount, right after login/signup, and after a profile update so the
  // sidebar name/avatar always reflect the real account instead of the "User"
  // fallback that shows while `user` is still null.
  const refreshUser = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const res = await apiClient.get('/auth/me');
      const nextUser: AuthUser | null = res.data ?? null;
      setUser(nextUser);
      setIsAuthenticated(true);
      return nextUser;
    } catch {
      setUser(null);
      setIsAuthenticated(false);
      return null;
    }
  }, []);

  useEffect(() => {
    void requestOnce('auth:me', () => refreshUser());

    const interceptor = apiClient.interceptors.response.use(
      (response) => response,
      (error) => {
        // A 401 should sign the user out ONLY when it is about the Atomspace
        // session itself. Third-party integration endpoints (e.g. connecting a
        // job board) can return 401/downstream-auth errors that say nothing
        // about the Atomspace token — treating those as a logout wrongly
        // bounced the user to the sign-in page. Never force-logout for those.
        const url: string = error.config?.url ?? '';
        const isIntegrationAuthError = url.includes('/job-sites/');
        if (error.response?.status === 401 && !isIntegrationAuthError) {
          setIsAuthenticated(false);
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
      setUser(null);
    }
  }, []);

  const onAuthSuccess = useCallback(async () => {
    // Pull the freshly authenticated account so the sidebar shows the real
    // name/email immediately instead of the "User" fallback (previously `user`
    // stayed null until a full page reload re-ran /auth/me).
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
