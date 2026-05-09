// Unified AuthProvider — single source of truth for both
// averrow-ops's /v2 auth context and averrow-tenant's /tenant auth
// context. Per SHARED_LOGIN_SPEC §1+§2 the auth lifecycle is
// canonical and lives here; products parameterize via
// AuthProviderConfig.
//
// Lifecycle steps (all products):
//   1. Hydrate from localStorage cache (no-flash UX).
//   2. Read tokens from URL hash/query (OAuth + magic-link callbacks).
//   3. If no token, attempt cookie-based refresh (silent re-auth).
//   4. Validate via /api/auth/me. Apply onValidatedUser hook.
//   5. Set loading=false, render.
//
// Logout (all products):
//   1. POST /api/auth/logout (best-effort; revokes refresh cookie).
//   2. Clear tokens + cache + product-specific side state.
//   3. Navigate to logoutRedirectTo.
//
// State updates use functional setters so concurrent tab activity
// (refresh in another tab, manual logout in another tab) doesn't
// race the auth lifecycle.

import {
  createContext, useCallback, useContext, useEffect, useState,
  type ReactNode,
} from 'react';
import type {
  SharedAuthUser, SharedAuthState, AuthHttpClient, AuthProviderConfig,
} from './types';

const AuthContext = createContext<SharedAuthState | null>(null);

interface TokenPayload {
  accessToken:  string;
  refreshToken: string;
  returnTo:     string | null;
  source:       'hash' | 'query';
}

function readTokensFromUrl(): TokenPayload | null {
  if (typeof window === 'undefined') return null;
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

interface AuthProviderProps {
  children:   ReactNode;
  httpClient: AuthHttpClient;
  config:     AuthProviderConfig;
}

export function AuthProvider({ children, httpClient, config }: AuthProviderProps) {
  const {
    userCacheKey,
    loginPath        = '/api/auth/login?return_to=/v2/',
    logoutPath       = '/api/auth/logout',
    refreshPath      = '/api/auth/refresh',
    mePath           = '/api/auth/me',
    logoutRedirectTo = '/',
    returnToPrefix   = '/v2',
    onValidatedUser,
    onLogoutCleanup,
    refreshMode      = 'cookie-refresh',
  } = config;

  // Cache helpers — bound to the per-product key.
  const loadCachedUser = useCallback((): SharedAuthUser | null => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(userCacheKey);
      if (!raw) return null;
      return JSON.parse(raw) as SharedAuthUser;
    } catch {
      return null;
    }
  }, [userCacheKey]);

  const saveCachedUser = useCallback((u: SharedAuthUser | null) => {
    try {
      if (u) localStorage.setItem(userCacheKey, JSON.stringify(u));
      else   localStorage.removeItem(userCacheKey);
    } catch {}
  }, [userCacheKey]);

  // Hydrate from cache on first render so the shell paints
  // immediately. Validation runs in the background.
  const [user, setUserState] = useState<SharedAuthUser | null>(() => {
    const cached = loadCachedUser();
    return cached && httpClient.getToken() ? cached : null;
  });
  const [loading, setLoading] = useState<boolean>(() => {
    return !(loadCachedUser() && httpClient.getToken());
  });

  const setUser = useCallback((u: SharedAuthUser | null) => {
    setUserState(u);
    saveCachedUser(u);
  }, [saveCachedUser]);

  const checkAuth = useCallback(async () => {
    // 1. Pull tokens from URL if this is a callback.
    const fromUrl = readTokensFromUrl();
    if (fromUrl && typeof window !== 'undefined') {
      httpClient.setTokens(fromUrl.accessToken, fromUrl.refreshToken);
      if (fromUrl.source === 'hash' && fromUrl.returnTo && fromUrl.returnTo.startsWith(returnToPrefix)) {
        window.history.replaceState({}, '', fromUrl.returnTo);
      } else {
        window.history.replaceState({}, '', window.location.pathname);
      }
    }

    // 2. No token → try silent cookie refresh (ops only).
    if (!httpClient.getToken() && refreshMode === 'cookie-refresh') {
      try {
        const refreshRes = await fetch(refreshPath, {
          method:      'POST',
          credentials: 'include',
          headers:     { 'Content-Type': 'application/json' },
          signal:      AbortSignal.timeout(3000),
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json() as { data?: { token?: string } };
          if (data.data?.token) httpClient.setTokens(data.data.token, '');
        }
      } catch { /* swallow — anon access falls through */ }
    }

    if (!httpClient.getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }

    // 3. Validate via /api/auth/me.
    try {
      const res = await httpClient.get<SharedAuthUser>(mePath);
      if (res.success && res.data) {
        const decision = onValidatedUser?.(res.data) ?? { kind: 'continue' };
        if (decision.kind === 'redirect') {
          if (typeof window !== 'undefined') window.location.href = decision.to;
          return;
        }
        setUser(res.data);
      } else {
        setUser(null);
        httpClient.clearTokens();
      }
    } catch {
      // httpClient.onAuthError already handles 401 cleanup; swallow
      // other errors so a transient network blip doesn't log the
      // user out.
    } finally {
      setLoading(false);
    }
  }, [httpClient, mePath, onValidatedUser, refreshMode, refreshPath, returnToPrefix, setUser]);

  useEffect(() => {
    httpClient.onAuthError(() => {
      setUser(null);
      httpClient.clearTokens();
    });

    // Hydrate-path redirect — if the cached user's onValidatedUser
    // would redirect them, do it before the network round-trip.
    const cached = loadCachedUser();
    if (cached && httpClient.getToken() && onValidatedUser) {
      const decision = onValidatedUser(cached);
      if (decision.kind === 'redirect') {
        if (typeof window !== 'undefined') window.location.href = decision.to;
        return;
      }
    }

    void checkAuth();
  }, [checkAuth, httpClient, loadCachedUser, onValidatedUser, setUser]);

  const login = useCallback(() => {
    if (typeof window !== 'undefined') window.location.href = loginPath;
  }, [loginPath]);

  const logout = useCallback(async () => {
    // Best-effort: a network error here still proceeds with local
    // teardown so the user isn't trapped on the shell.
    try { await httpClient.post(logoutPath, {}); } catch { /* swallow */ }
    httpClient.clearTokens();
    setUser(null);
    onLogoutCleanup?.();
    if (typeof window !== 'undefined') window.location.href = logoutRedirectTo;
  }, [httpClient, logoutPath, logoutRedirectTo, onLogoutCleanup, setUser]);

  const value: SharedAuthState = {
    user,
    loading,
    isAuthenticated: !!user,
    isSuperAdmin:    user?.role === 'super_admin',
    hasOrg:          !!user?.organization,
    login,
    logout,
    refreshUser:     checkAuth,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): SharedAuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
