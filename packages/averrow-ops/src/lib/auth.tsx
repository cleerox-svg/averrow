import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api';

interface UserOrganization {
  id: number;
  name: string;
  slug: string;
  plan: string;
  role: string;
}

interface User {
  id: string;
  email: string;
  /** Computed by the backend as `display_name ?? name`. */
  name: string;
  role: string;
  /** Editable in Profile; falls back to Google name when null. */
  display_name?: string | null;
  /** IANA timezone; null means "auto-detect from browser." */
  timezone?: string | null;
  /** 'dark' | 'light' | null. Null means "follow OS / app default." */
  theme_preference?: 'dark' | 'light' | null;
  /** Drives FirstSignInPasskeyPrompt — auto-prompts when 0. */
  passkey_count?: number;
  avatar_url?: string;
  organization?: UserOrganization | null;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  isAuthenticated: boolean;
  isSuperAdmin: boolean;
  isBrandAdmin: boolean;
  login: () => void;
  logout: () => void;
  /** Re-fetch /api/auth/me. Call after profile edits or passkey changes. */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const USER_CACHE_KEY = 'averrow-user';

function loadCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

function saveCachedUser(user: User | null) {
  try {
    if (user) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_CACHE_KEY);
  } catch {}
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Hydrate from cache so the shell can render without a blank screen.
  // The cached user is validated in the background via /api/auth/me.
  // If validation fails the api.onAuthError handler clears state and redirects.
  const [user, setUserState] = useState<User | null>(() => {
    const cached = loadCachedUser();
    return cached && api.getToken() ? cached : null;
  });
  const [loading, setLoading] = useState(() => {
    // Skip the blocking loading screen if we already have something to show
    return !(loadCachedUser() && api.getToken());
  });

  const setUser = useCallback((u: User | null) => {
    setUserState(u);
    saveCachedUser(u);
  }, []);

  const checkAuth = useCallback(async () => {
    // Check URL for OAuth callback tokens (hash fragment from server redirect)
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = hashParams.get('token');
    const refreshToken = hashParams.get('refresh_token');

    // Also check query params for backwards compatibility
    const queryParams = new URLSearchParams(window.location.search);
    const accessTokenQuery = queryParams.get('access_token');
    const refreshTokenQuery = queryParams.get('refresh_token');

    if (accessToken) {
      api.setTokens(accessToken, refreshToken ?? '');
      const returnTo = hashParams.get('return_to');
      if (returnTo && returnTo.startsWith('/v2')) {
        window.history.replaceState({}, '', returnTo);
      } else {
        window.history.replaceState({}, '', window.location.pathname);
      }
    } else if (accessTokenQuery && refreshTokenQuery) {
      api.setTokens(accessTokenQuery, refreshTokenQuery);
      window.history.replaceState({}, '', window.location.pathname);
    }

    // If no token from hash, try cookie-based refresh — but with a hard
    // timeout so a slow backend can't blank the screen indefinitely.
    if (!api.getToken()) {
      try {
        const refreshRes = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(3000),
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json() as any;
          if (data.data?.token) {
            api.setTokens(data.data.token, '');
          }
        }
      } catch {}
    }

    if (!api.getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }

    // We have a token. If we already hydrated from cache, the shell is
    // already painting — this just refreshes the user record in the
    // background. If we did not hydrate from cache, this is the first
    // time we'll have a user object, so loading must clear after.
    try {
      const res = await api.get<User>('/api/auth/me');
      if (res.success && res.data) {
        setUser(res.data);
      } else {
        setUser(null);
        api.clearTokens();
      }
    } catch {
      // api.onAuthError already handles 401 cleanup; swallow other errors
      // so a transient network blip doesn't log the user out.
    } finally {
      setLoading(false);
    }
  }, [setUser]);

  useEffect(() => {
    api.onAuthError(() => {
      setUser(null);
      api.clearTokens();
    });
    checkAuth();
  }, [checkAuth, setUser]);

  const login = () => {
    window.location.href = '/api/auth/login?return_to=/v2/';
  };

  const logout = () => {
    api.clearTokens();
    setUser(null);
    saveCachedUser(null);
    window.location.href = '/';
  };

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      isAuthenticated: !!user,
      isSuperAdmin: user?.role === 'super_admin',
      isBrandAdmin: !!user && user.role !== 'super_admin' && !!user.organization,
      login,
      logout,
      refreshUser: checkAuth,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
