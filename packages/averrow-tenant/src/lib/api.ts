// averrow-tenant — minimal API client.
//
// Matches averrow-ops's lib/api.ts JWT pattern: short-lived access
// token held IN MEMORY ONLY, sent as Authorization: Bearer. The
// long-lived refresh token lives in the HttpOnly `radar_refresh`
// cookie (H5, SECURITY_AUDIT_2026-06-10) — the browser attaches it to
// /api/auth/refresh automatically; JS never sees it. On page reload
// the shared AuthProvider bootstraps a fresh access token via that
// cookie. Fetches go to the same backend (`packages/averrow-worker`);
// proxied via vite.config.ts in dev and via worker route in prod, so
// everything is same-origin.

// One-time purge of the legacy localStorage key so tokens written by
// pre-H5 builds don't linger on disk.
try {
  localStorage.removeItem('averrow_token');
} catch {}

let accessToken: string | null = null;

export function getToken(): string | null {
  return accessToken;
}

/** H5: in-memory only — never persisted to localStorage. */
export function setToken(token: string | null): void {
  accessToken = token;
}

export interface ApiSuccess<T> { success: true; data: T; total?: number }
export interface ApiError { success: false; error: string }

// Single-flight cookie-based refresh — concurrent 401s share one
// attempt. Mirrors ops' ApiClient.tryRefresh.
let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      // H5: the refresh token rides the HttpOnly radar_refresh cookie
      // — same-origin credentials attach it; no body token. Rotation
      // happens server-side via Set-Cookie on the response.
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) return false;
      const body = await res.json() as { success: boolean; data?: { token?: string } };
      if (!body.success || !body.data?.token) return false;
      setToken(body.data.token);
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function apiFetch<T>(method: string, path: string, body?: unknown): Promise<ApiSuccess<T>> {
  const doFetch = () => {
    const token = getToken();
    return fetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res = await doFetch();

  // 401 → one cookie-based refresh, then retry once with the new
  // access token. Keeps long-lived tabs alive past the access-token
  // TTL without any JS-readable refresh token.
  if (res.status === 401 && await tryRefresh()) {
    res = await doFetch();
  }

  if (!res.ok) {
    let parsed: ApiError | null = null;
    try { parsed = await res.json() as ApiError; } catch { /* non-json */ }
    throw new Error(parsed?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<ApiSuccess<T>>;
}

export async function apiGet<T>(path: string): Promise<ApiSuccess<T>> {
  return apiFetch<T>('GET', path);
}

export async function apiPost<T, B = unknown>(path: string, body: B): Promise<ApiSuccess<T>> {
  return apiFetch<T>('POST', path, body);
}

export async function apiPatch<T, B = unknown>(path: string, body: B): Promise<ApiSuccess<T>> {
  return apiFetch<T>('PATCH', path, body);
}

export async function apiDelete<T>(path: string): Promise<ApiSuccess<T>> {
  return apiFetch<T>('DELETE', path);
}
