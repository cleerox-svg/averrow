// Edge cases around the refresh `data.me` shortcut in AuthProvider:
// the onValidatedUser redirect must still be honoured, and the hash-token
// (OAuth / magic-link) path must always validate through /me.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth, type AuthHttpClient } from '@averrow/shared/auth';

const ME = { id: 'u1', email: 'a@b.c', name: 'Ann', role: 'client' };
const CONFIG = { userCacheKey: 'test-refresh-me-hooks', loginPath: '/login' };

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
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data }) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Who() {
  const { user, loading } = useAuth();
  return <div data-testid="who">{loading ? 'loading' : (user?.name ?? 'anon')}</div>;
}

function stubLocation() {
  const original = window.location;
  const assigned: string[] = [];
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      hash: '',
      search: '',
      pathname: '/',
      get href() { return 'http://localhost/'; },
      set href(v: string) { assigned.push(v); },
    },
  });
  return { assigned, restore: () => Object.defineProperty(window, 'location', { configurable: true, value: original }) };
}

beforeEach(() => { localStorage.clear(); window.history.pushState({}, '', '/'); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('AuthProvider refresh-me shortcut: hooks and paths', () => {
  it('honours an onValidatedUser redirect on the me shortcut (no /me call, user not set)', async () => {
    mockRefresh({ token: 'tok', me: ME });
    const { client, get } = makeClient();
    const loc = stubLocation();
    const onValidatedUser = vi.fn().mockReturnValue({ kind: 'redirect', to: '/tenant/' });
    try {
      render(<AuthProvider httpClient={client} config={{ ...CONFIG, onValidatedUser }}><Who /></AuthProvider>);
      await waitFor(() => expect(loc.assigned).toEqual(['/tenant/']));
      expect(onValidatedUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }));
      expect(get).not.toHaveBeenCalled();
      expect(screen.getByTestId('who').textContent).not.toBe('Ann');
    } finally {
      loc.restore();
    }
  });

  it('calls onValidatedUser with the refresh-supplied me and continues on { kind: continue }', async () => {
    mockRefresh({ token: 'tok', me: ME });
    const { client, get } = makeClient();
    const onValidatedUser = vi.fn().mockReturnValue({ kind: 'continue' });
    render(<AuthProvider httpClient={client} config={{ ...CONFIG, onValidatedUser }}><Who /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('Ann'));
    expect(onValidatedUser).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it('hash-token path never refreshes and always validates via /me', async () => {
    window.history.pushState({}, '', '/#token=hashtok');
    // A refresh, if (wrongly) attempted, would hand back a different me.
    const fetchMock = mockRefresh({ token: 'tok2', me: { ...ME, name: 'FromRefresh' } });
    const { client, get } = makeClient({ ...ME, name: 'FromMe' });
    render(<AuthProvider httpClient={client} config={CONFIG}><Who /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('FromMe'));
    expect(get).toHaveBeenCalledWith('/api/auth/me');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.getToken()).toBe('hashtok');
  });

  it('query access_token path also validates via /me', async () => {
    window.history.pushState({}, '', '/?access_token=qtok');
    mockRefresh({ token: 'tok2', me: { ...ME, name: 'FromRefresh' } });
    const { client, get } = makeClient({ ...ME, name: 'FromMe' });
    render(<AuthProvider httpClient={client} config={CONFIG}><Who /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('FromMe'));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('a refresh response without a token ignores me and stays anonymous', async () => {
    mockRefresh({ me: ME });
    const { client, get } = makeClient();
    render(<AuthProvider httpClient={client} config={CONFIG}><Who /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('anon'));
    expect(get).not.toHaveBeenCalled();
    expect(client.getToken()).toBeNull();
  });
});
