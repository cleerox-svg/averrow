const API_BASE = '';

// D1 Sessions API bookmark — tracks latest write position for read-after-write consistency.
// The backend sends x-d1-bookmark on every response; we send it back so D1 routes
// reads to replicas that are caught up to at least this point.
let lastBookmark: string | null = null;

// H5 (SECURITY_AUDIT_2026-06-10): tokens never touch localStorage.
// The access token lives in memory on the ApiClient instance; the
// refresh token lives in the HttpOnly `radar_refresh` cookie, which
// the browser attaches to /api/auth/refresh automatically. On page
// reload the shared AuthProvider bootstraps a fresh access token via
// that cookie. One-time purge of the legacy keys so tokens written by
// pre-H5 builds don't linger on disk.
try {
  localStorage.removeItem('averrow_token');
  localStorage.removeItem('averrow_refresh');
} catch {}

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  total?: number;
}

class ApiClient {
  private token: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private onUnauthorized: (() => void) | null = null;

  /** H5: in-memory only. The `_refresh` parameter is kept for the
   *  AuthHttpClient adapter shape but ignored — the refresh token is
   *  cookie-managed by the backend and never visible to JS. */
  setTokens(access: string, _refresh: string) {
    this.token = access;
  }

  clearTokens() {
    this.token = null;
    // H6 (SECURITY_AUDIT_2026-06-10): tell the service worker to drop any
    // cached /api/* responses so authenticated data doesn't outlive the
    // session in Cache Storage. Guarded — SW may be unsupported (older
    // browsers, non-secure contexts) or not yet controlling this page.
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_API_CACHE' });
    } catch {}
  }

  getToken() {
    return this.token;
  }

  onAuthError(callback: () => void) {
    this.onUnauthorized = callback;
  }

  async fetch<T>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (lastBookmark) {
      headers['x-d1-bookmark'] = lastBookmark;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      // Try a cookie-based refresh — the HttpOnly radar_refresh cookie
      // (if the session is still alive) mints a new access token.
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${this.token}`;
        const retryResponse = await fetch(`${API_BASE}${path}`, { ...options, headers });
        const retryBookmark = retryResponse.headers.get('x-d1-bookmark');
        if (retryBookmark) lastBookmark = retryBookmark;
        return retryResponse.json() as Promise<ApiResponse<T>>;
      }
      this.onUnauthorized?.();
      throw new Error('Unauthorized');
    }

    const bookmark = response.headers.get('x-d1-bookmark');
    if (bookmark) lastBookmark = bookmark;

    return response.json() as Promise<ApiResponse<T>>;
  }

  async get<T>(path: string): Promise<ApiResponse<T>> {
    return this.fetch<T>(path);
  }

  async post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.fetch<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async patch<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.fetch<T>(path, {
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async put<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.fetch<T>(path, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async delete<T>(path: string): Promise<ApiResponse<T>> {
    return this.fetch<T>(path, { method: 'DELETE' });
  }

  private async tryRefresh(): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        // H5: the refresh token rides the HttpOnly radar_refresh
        // cookie — same-origin credentials attach it; no body token.
        // Rotation happens server-side via Set-Cookie on the response.
        const response = await fetch(`${API_BASE}/api/auth/refresh`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) return false;
        const data = await response.json() as { success: boolean; data?: { token?: string } };
        if (!data.success || !data.data?.token) return false;
        this.setTokens(data.data.token, '');
        return true;
      } catch {
        return false;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }
}

export const api = new ApiClient();
