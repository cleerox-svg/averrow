// averrow-tenant — minimal API client.
//
// Matches averrow-ops's lib/api.ts JWT pattern: token in localStorage
// under `averrow_token`, sent as Authorization: Bearer. Fetches go to
// the same backend (`packages/trust-radar`); proxied via vite.config.ts
// in dev and via worker route in prod.

const TOKEN_KEY = 'averrow_token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token === null) {
      localStorage.removeItem(TOKEN_KEY);
    } else {
      localStorage.setItem(TOKEN_KEY, token);
    }
  } catch {
    // Storage unavailable — caller can still use in-memory fallback
    // if needed. For the skeleton we just no-op.
  }
}

export interface ApiSuccess<T> { success: true; data: T; total?: number }
export interface ApiError { success: false; error: string }

export async function apiGet<T>(path: string): Promise<ApiSuccess<T>> {
  const token = getToken();
  const res = await fetch(path, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let body: ApiError | null = null;
    try { body = await res.json() as ApiError; } catch { /* non-json */ }
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<ApiSuccess<T>>;
}

export async function apiPost<T, B = unknown>(path: string, body: B): Promise<ApiSuccess<T>> {
  const token = getToken();
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let parsed: ApiError | null = null;
    try { parsed = await res.json() as ApiError; } catch { /* non-json */ }
    throw new Error(parsed?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<ApiSuccess<T>>;
}
