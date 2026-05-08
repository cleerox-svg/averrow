const API_BASE = '';

// D1 Sessions API bookmark — tracks latest write position for read-after-write consistency.
// The backend sends x-d1-bookmark on every response; we send it back so D1 routes
// reads to replicas that are caught up to at least this point.
let lastBookmark: string | null = null;

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  total?: number;
}

class ApiClient {
  private token: string | null = null;
  private refreshToken: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private onUnauthorized: (() => void) | null = null;

  setTokens(access: string, refresh: string) {
    this.token = access;
    this.refreshToken = refresh;
    try {
      localStorage.setItem('averrow_token', access);
      localStorage.setItem('averrow_refresh', refresh);
    } catch {}
  }

  clearTokens() {
    this.token = null;
    this.refreshToken = null;
    try {
      localStorage.removeItem('averrow_token');
      localStorage.removeItem('averrow_refresh');
    } catch {}
  }

  getToken() {
    if (!this.token) {
      try {
        this.token = localStorage.getItem('averrow_token');
        this.refreshToken = localStorage.getItem('averrow_refresh');
      } catch {}
    }
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
      // Try refresh
      if (this.refreshToken) {
        const refreshed = await this.tryRefresh();
        if (refreshed) {
          headers['Authorization'] = `Bearer ${this.token}`;
          const retryResponse = await fetch(`${API_BASE}${path}`, { ...options, headers });
          const retryBookmark = retryResponse.headers.get('x-d1-bookmark');
          if (retryBookmark) lastBookmark = retryBookmark;
          return retryResponse.json() as Promise<ApiResponse<T>>;
        }
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
        const response = await fetch(`${API_BASE}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: this.refreshToken }),
        });
        if (!response.ok) return false;
        const data = await response.json() as { access_token: string; refresh_token: string };
        this.setTokens(data.access_token, data.refresh_token);
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
