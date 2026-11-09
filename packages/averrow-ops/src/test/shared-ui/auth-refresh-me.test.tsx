// Cold-load shortcut: POST /api/auth/refresh may carry `data.me` (the exact
// /api/auth/me payload). AuthProvider uses it and skips the /me round-trip;
// a missing or invalid `me` falls back to /me.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth, type AuthHttpClient } from '@averrow/shared/auth';

const ME = { id: 'u1', email: 'a@b.c', name: 'Ann', role: 'analyst' };
const CONFIG = { userCacheKey: 'test-refresh-me', loginPath: '/login' };

function makeClient(meFromGet: Record<string, unknown> = ME) {
  let token: string | null = null;
  const get = vi.fn().mockResolvedValue({ success: true, data: meFromGet });
  const client: AuthHttpClient = {
    getToken: () => token,
    setTokens: (t: string) => { token = t; },
    clearTokens: () => { token = null; },
    onAuthError: () => {},
    get: get as AuthHttpClient['get'],
    post: vi.fn().mockResolvedValue({ success: true }) as AuthHttpClient['post'],
  };
  return { client, get };
}

function mockRefresh(data: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data }),
  }));
}

function Who() {
  const { user, loading } = useAuth();
  return <div data-testid="who">{loading ? 'loading' : (user?.name ?? 'anon')}</div>;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('AuthProvider refresh payload', () => {
  it('uses data.me from the refresh response and does not call /me', async () => {
    mockRefresh({ token: 'tok', expires_in: 900, user: { id: 'u1', email: 'a@b.c', role: 'analyst' }, me: ME });
    const { client, get } = makeClient();
    render(<AuthProvider httpClient={client} config={CONFIG}><Who /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('Ann'));
    expect(get).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('test-refresh-me') ?? '{}').id).toBe('u1');
  });

  it('falls back to /me when me is absent', async () => {
    mockRefresh({ token: 'tok', expires_in: 900, user: { id: 'u1', email: 'a@b.c', role: 'analyst' } });
    const { client, get } = makeClient({ ...ME, name: 'FromMe' });
    render(<AuthProvider httpClient={client} config={CONFIG}><Who /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('FromMe'));
    expect(get).toHaveBeenCalledWith('/api/auth/me');
  });

  it('falls back to /me when me is invalid', async () => {
    mockRefresh({ token: 'tok', expires_in: 900, me: { id: 'u1', email: 'a@b.c', role: 7 } });
    const { client, get } = makeClient({ ...ME, name: 'FromMe' });
    render(<AuthProvider httpClient={client} config={CONFIG}><Who /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('FromMe'));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
