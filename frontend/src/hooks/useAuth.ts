import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';

export type AuthPage = 'login' | 'signup';

export type AuthUser = {
  id?: string;
  email?: string;
  name?: string | null;
  is_active?: boolean;
  created_at?: string;
};

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authPage, setAuthPage] = useState<AuthPage>('login');

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await apiClient.get('/auth/me');
        setUser(res.data ?? null);
        setIsAuthenticated(true);
      } catch {
        setUser(null);
        setIsAuthenticated(false);
      }
    };

    void checkAuth();

    const interceptor = apiClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          setIsAuthenticated(false);
          setUser(null);
        }
        return Promise.reject(error);
      },
    );

    return () => apiClient.interceptors.response.eject(interceptor);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiClient.post('/auth/logout');
    } finally {
      setIsAuthenticated(false);
      setUser(null);
    }
  }, []);

  const onAuthSuccess = useCallback(() => {
    setIsAuthenticated(true);
    setAuthPage('login');
  }, []);

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
    getUserInitial,
    setIsAuthenticated,
    setUser,
  };
}

