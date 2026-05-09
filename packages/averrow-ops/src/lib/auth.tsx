import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api';
import { clearLastSignInMethod as clearLastSignInMethodInStorage } from '@averrow/shared/login';

const LAST_SIGNIN_METHOD_KEY = 'averrow.lastSignInMethod';
const clearLastSignInMethod = () => clearLastSignInMethodInStorage(LAST_SIGNIN_METHOD_KEY);

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
  logout: () => Promise<void>;
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

/**
 * Phase D D2c rebadge gate — averrow-ops is staff-only. A
 * role='client' user (any customer) belongs at /tenant/, not here.
 * Hard-redirects so we don't even briefly render the staff shell
 * with their identity. Worker-side login redirect is the matching
 * backstop in packages/trust-radar/src/handlers/auth.ts.
 *
 * Single helper used by both the cache-hydrate path AND the
 * post-/me check path. Audit #5 — was previously two duplicated
 * code paths.
 */
function redirectClientToTenant(user: { role: string } | null): boolean {
  if (user?.role === 'client') {
    window.location.href = '/tenant/';
    return true;
  }
  return false;
}

/**
 * Read tokens from URL — accepts both the canonical hash form
 * (`#token=…`) used by OAuth + magic-link + passkey callbacks AND
 * the legacy query form (`?access_token=…&refresh_token=…`) for
 * backwards compatibility with older email links. Audit #6 — was
 * previously two parallel branches; now a single normalize step.
 *
 * Returns null when no tokens are present in the URL.
 */
interface TokenPayload {
  accessToken:  string;
  refreshToken: string;
  returnTo:     string | null;
  source:       'hash' | 'query';
}

function readTokensFromUrl(): TokenPayload | null {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const hashToken  = hashParams.get('token');
  if (hashToken) {
    return {
      accessToken:  hashToken,
      refreshToken: hashParams.get('refresh_token') ?? '',
      returnTo:     hashParams.get('return_to'),
      source:       'hash',
    };
  }
  const queryParams = new URLSearchParams(window.location.search);
  const queryToken  = queryParams.get('access_token');
  if (queryToken) {
    return {
      accessToken:  queryToken,
      refreshToken: queryParams.get('refresh_token') ?? '',
      returnTo:     null,
      source:       'query',
    };
  }
  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Hydrate from cache so the shell can render without a blank
  // screen. The cached user is validated in the background via
  // /api/auth/me. Audit #8 — previous IIFE re-ran on every render
  // and had a side-effect (window.location.href) baked into the
  // useState initializer. Now: pure read in useState, redirect in
  // useEffect. The redirect is gated by `api.getToken()` to avoid
  // looping during the initial token-less boot.
  const [user, setUserState] = useState<User | null>(() => {
    const cached = typeof window === 'undefined' ? null : loadCachedUser();
    return cached && api.getToken() ? cached : null;
  });
  const [loading, setLoading] = useState(() => {
    return !(loadCachedUser() && api.getToken());
  });

  const setUser = useCallback((u: User | null) => {
    setUserState(u);
    saveCachedUser(u);
  }, []);

  const checkAuth = useCallback(async () => {
    // 1. Pull tokens from the URL if this is an OAuth/magic-link/
    //    passkey callback. Single normalized read for both hash and
    //    legacy query forms (audit #6).
    const fromUrl = readTokensFromUrl();
    if (fromUrl) {
      api.setTokens(fromUrl.accessToken, fromUrl.refreshToken);
      // Hash callbacks may include a return_to pointing inside /v2;
      // restore it so the URL bar matches the real route. Other
      // sources just strip the param noise.
      if (fromUrl.source === 'hash' && fromUrl.returnTo && fromUrl.returnTo.startsWith('/v2')) {
        window.history.replaceState({}, '', fromUrl.returnTo);
      } else {
        window.history.replaceState({}, '', window.location.pathname);
      }
    }

    // 2. No token from URL — try refreshing via the HTTP-only
    //    cookie. Hard timeout so a slow backend can't blank the
    //    screen indefinitely.
    if (!api.getToken()) {
      try {
        const refreshRes = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(3000),
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json() as { data?: { token?: string } };
          if (data.data?.token) {
            api.setTokens(data.data.token, '');
          }
        }
      } catch { /* swallow */ }
    }

    if (!api.getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }

    // 3. Validate via /api/auth/me. Client-role users get redirected
    //    to /tenant/ (staff-only gate).
    try {
      const res = await api.get<User>('/api/auth/me');
      if (res.success && res.data) {
        if (redirectClientToTenant(res.data)) return;
        setUser(res.data);
      } else {
        setUser(null);
        api.clearTokens();
      }
    } catch {
      // api.onAuthError already handles 401 cleanup; swallow other
      // errors so a transient network blip doesn't log the user out.
    } finally {
      setLoading(false);
    }
  }, [setUser]);

  useEffect(() => {
    api.onAuthError(() => {
      setUser(null);
      api.clearTokens();
    });
    // Hydrate-path client-role redirect (audit #5+#8 consolidation).
    // The cached user might say role='client' if a customer visited
    // /v2 previously — bounce them before checkAuth runs.
    const cached = loadCachedUser();
    if (api.getToken() && redirectClientToTenant(cached)) return;
    checkAuth();
  }, [checkAuth, setUser]);

  const login = () => {
    window.location.href = '/api/auth/login?return_to=/v2/';
  };

  const logout = async () => {
    // Hit the backend so the refresh-token cookie + sessions row
    // are revoked. Best-effort: a network error here still proceeds
    // with local teardown so the user isn't trapped on the shell.
    try {
      await api.post('/api/auth/logout', {});
    } catch {
      /* swallow — local teardown still runs */
    }
    api.clearTokens();
    setUser(null);
    saveCachedUser(null);
    // Clear the per-device "last sign-in method" hint so the next
    // visitor on this device sees the first-time login view.
    clearLastSignInMethod();
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
