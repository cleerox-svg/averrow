// Unified AuthProvider — single source of truth for both
// averrow-ops's /v2 auth context and averrow-tenant's /tenant auth
// context. Per SHARED_LOGIN_SPEC §1+§2 the auth lifecycle is
// canonical and lives here; products parameterize via
// AuthProviderConfig.
//
// Lifecycle steps (all products):
//   1. Hydrate from localStorage cache (no-flash UX).
//   2. Read the access token from the URL hash/query (OAuth +
//      magic-link callbacks).
//   3. If no token, attempt cookie-based refresh (silent re-auth via
//      the HttpOnly `radar_refresh` cookie). This is the normal boot
//      path on every reload now that access tokens are memory-only
//      (H5, SECURITY_AUDIT_2026-06-10) — `loading` stays true until
//      the attempt settles, so hosts must not redirect to login
//      while `loading` is set.
//   4. Validate via /api/auth/me. Apply onValidatedUser hook.
//   5. Set loading=false, render.
//
// Token storage model (H5): the refresh token lives ONLY in the
// HttpOnly cookie — it never appears in JS-readable storage or in
// any JSON response. The access token lives ONLY in host-app
// memory (httpClient adapters must not persist it to localStorage).
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
  returnTo:     string | null;
  source:       'hash' | 'query';
}

/**
 * Path-prefix check that requires a boundary character after the
 * prefix so `'/v2evil/path'` does NOT match prefix `'/v2'`. The
 * next character must be undefined (end of string), or one of
 * `/`, `?`, `#` — i.e. a real path / query / fragment boundary.
 *
 * Without this, the post-callback `replaceState` would happily
 * write `'/v2evil/path'` into the URL bar, which (although
 * same-origin and not directly XSS-exploitable via replaceState)
 * could be weaponized by future code that reads
 * `window.location.pathname` for routing decisions. Defense in
 * depth.
 */
export function isSafeReturnTo(returnTo: string, prefix: string): boolean {
  if (!returnTo || !prefix) return false;
  if (!returnTo.startsWith(prefix)) return false;
  const next = returnTo.charAt(prefix.length);
  // Empty string → end of returnTo (exact prefix match) — safe.
  // '/' → child path. '?' → query string. '#' → fragment. All safe.
  return next === '' || next === '/' || next === '?' || next === '#';
}

/**
 * Defensive validation of a localStorage-cached user. Returns the
 * value if it looks like a SharedAuthUser, null otherwise. Guards
 * against storage poisoning by malicious extensions or stale data
 * from a previous schema. The properties checked are the ones
 * downstream consumers (Profile, TopBar, role guards) read; if any
 * are missing or wrong type, we treat the cache as absent and let
 * the network /api/auth/me round-trip refill it.
 */
export function isValidCachedUser(value: unknown): value is SharedAuthUser {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id    !== 'string') return false;
  if (typeof v.email !== 'string') return false;
  if (typeof v.name  !== 'string') return false;
  if (typeof v.role  !== 'string') return false;
  if (v.organization != null) {
    if (typeof v.organization !== 'object') return false;
    const o = v.organization as Record<string, unknown>;
    if (typeof o.id   !== 'number') return false;
    if (typeof o.name !== 'string') return false;
    if (typeof o.slug !== 'string') return false;
    if (typeof o.plan !== 'string') return false;
    if (typeof o.role !== 'string') return false;
  }
  return true;
}

// H5: only the short-lived access token rides the callback URL. The
// refresh token is delivered exclusively via the HttpOnly
// `radar_refresh` Set-Cookie on the session-issuing response and is
// never readable from JS.
function readTokensFromUrl(): TokenPayload | null {
  if (typeof window === 'undefined') return null;
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const hashToken  = hashParams.get('token');
  if (hashToken) {
    return {
      accessToken:  hashToken,
      returnTo:     hashParams.get('return_to'),
      source:       'hash',
    };
  }
  const queryParams = new URLSearchParams(window.location.search);
  const queryToken  = queryParams.get('access_token');
  if (queryToken) {
    return {
      accessToken:  queryToken,
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
    // loginPath is REQUIRED — no default. Defaulting to /v2/ would
    // silently misroute customers on a future product (FarmTrack,
    // etc.) that forgot to override.
    loginPath,
    logoutPath       = '/api/auth/logout',
    refreshPath      = '/api/auth/refresh',
    mePath           = '/api/auth/me',
    logoutRedirectTo = '/',
    returnToPrefix   = '/v2',
    onValidatedUser,
    onLogoutCleanup,
    refreshMode      = 'cookie-refresh',
  } = config;

  // Cache helpers — bound to the per-product key. Returns null on
  // any parse failure OR shape mismatch (defends against poisoned
  // localStorage from malicious browser extensions or stale entries
  // from previous schema versions). On mismatch we also clear the
  // bad entry so the network /api/auth/me round-trip can refill it
  // cleanly.
  const loadCachedUser = useCallback((): SharedAuthUser | null => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(userCacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!isValidCachedUser(parsed)) {
        try { localStorage.removeItem(userCacheKey); } catch {}
        return null;
      }
      return parsed;
    } catch {
      // Invalid JSON. Clear so we don't keep parsing it on every render.
      try { localStorage.removeItem(userCacheKey); } catch {}
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
  // immediately. Validation runs in the background. With memory-only
  // access tokens (H5) a full page reload starts with getToken() ===
  // null, so this fast path only fires when the provider remounts
  // within an already-bootstrapped document; reloads take the
  // cookie-refresh path in checkAuth with loading=true throughout.
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
    // 1. Pull the access token from the URL if this is a callback.
    const fromUrl = readTokensFromUrl();
    if (fromUrl && typeof window !== 'undefined') {
      httpClient.setTokens(fromUrl.accessToken, '');
      if (fromUrl.source === 'hash' && fromUrl.returnTo && isSafeReturnTo(fromUrl.returnTo, returnToPrefix)) {
        window.history.replaceState({}, '', fromUrl.returnTo);
      } else {
        // Strip the token noise from the URL bar even when returnTo
        // is unsafe — never echo attacker-controlled values back.
        window.history.replaceState({}, '', window.location.pathname);
      }
    }

    // 2. No token → try silent cookie refresh. This is the standard
    //    reload path for BOTH products now that access tokens are
    //    memory-only (H5): the HttpOnly radar_refresh cookie (set on
    //    every session-issuing flow) mints a fresh access token.
    //    credentials: 'same-origin' — the SPAs are served from the
    //    same origin as the API (worker assets in prod, Vite proxy in
    //    dev), and the cookie is SameSite=Strict anyway.
    if (!httpClient.getToken() && refreshMode === 'cookie-refresh') {
      try {
        const refreshRes = await fetch(refreshPath, {
          method:      'POST',
          credentials: 'same-origin',
          headers:     { 'Content-Type': 'application/json' },
          // 10s, not the old 3s: with memory-only access tokens this
          // refresh gates EVERY reload of a signed-in user — an
          // aborted attempt reads as "logged out" and bounces them to
          // the public homepage, so we give slow networks headroom.
          signal:      AbortSignal.timeout(10000),
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
