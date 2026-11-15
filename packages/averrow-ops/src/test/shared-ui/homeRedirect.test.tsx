// The public home page sends a signed-in browser straight into its app. The
// session cookie is path-scoped to /api/auth, so the page reads a localStorage
// hint the apps maintain (packages/shared/src/auth/appHint.ts). This pins the
// marketing script (a plain inline file that can't import the shared module) to
// the same key/values and covers its decision table, and the hint lifecycle.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import {
  APP_HINT_KEY, HOME_NO_REDIRECT_URL, setAppHint, clearAppHint, readAppHint, AuthProvider,
} from '@averrow/shared/auth';
import type { AuthHttpClient } from '@averrow/shared/auth';

const SCRIPT = readFileSync(
  resolve(__dirname, '../../../../averrow-marketing/src/scripts/home-redirect.js'), 'utf8',
);
const LAYOUT = readFileSync(
  resolve(__dirname, '../../../../averrow-marketing/src/layouts/Layout.astro'), 'utf8',
);
const INDEX = readFileSync(
  resolve(__dirname, '../../../../averrow-marketing/src/pages/index.astro'), 'utf8',
);

/** Run the home script against a fake page; returns the replace() target or null. */
function runHome(opts: { pathname?: string; search?: string; hint?: string | null; storageThrows?: boolean }): string | null {
  let target: string | null = null;
  const location = {
    pathname: opts.pathname ?? '/',
    search: opts.search ?? '',
    replace: (u: string) => { target = u; },
  };
  const localStorage = {
    getItem: (k: string) => {
      if (opts.storageThrows) throw new Error('blocked');
      return k === 'averrow.app' ? (opts.hint ?? null) : null;
    },
  };
  new Function('location', 'localStorage', SCRIPT)(location, localStorage);
  return target;
}

describe('home-redirect.js', () => {
  it('uses the same key the apps write', () => {
    expect(APP_HINT_KEY).toBe('averrow.app');
    expect(SCRIPT).toContain(`"${APP_HINT_KEY}"`);
  });

  it('ops hint -> /ops/, tenant hint -> /tenant/', () => {
    expect(runHome({ hint: 'ops' })).toBe('/ops/');
    expect(runHome({ hint: 'tenant' })).toBe('/tenant/');
  });

  it.each([null, '', 'admin', 'OPS', 'v2', '/ops/', '<script>'])('hint %j -> stays', (hint) => {
    expect(runHome({ hint })).toBeNull();
  });

  it.each(['?home=1', '?home', '?x=1&home=1', '?home=0', '?a=b&home'])('%s never redirects', (search) => {
    expect(runHome({ hint: 'ops', search })).toBeNull();
  });

  it('?homepage / ?x=home do NOT count as the opt-out', () => {
    expect(runHome({ hint: 'ops', search: '?homepage=1' })).toBe('/ops/');
    expect(runHome({ hint: 'ops', search: '?x=home' })).toBe('/ops/');
  });

  it.each(['/pricing', '/about', '/blog/x', '/login', '/index.html', '/ops/', '//'])('only the exact home page: %s stays', (pathname) => {
    expect(runHome({ hint: 'ops', pathname })).toBeNull();
  });

  it('blocked storage fails closed (stays on the home page, no throw)', () => {
    expect(runHome({ hint: 'ops', storageThrows: true })).toBeNull();
  });

  it('is wired into the home page only', () => {
    expect(LAYOUT).toContain('home-redirect.js?raw');
    expect(LAYOUT).toContain('homeRedirect && <script is:inline');
    expect(INDEX).toMatch(/<Layout\s+homeRedirect/);
  });

  it('the ?home=1 escape used by the apps is what the script skips', () => {
    expect(HOME_NO_REDIRECT_URL).toBe('/?home=1');
    expect(runHome({ hint: 'ops', search: new URL(HOME_NO_REDIRECT_URL, 'https://x').search })).toBeNull();
  });
});

describe('app hint helpers', () => {
  beforeEach(() => localStorage.clear());

  it('set / read / clear', () => {
    expect(readAppHint()).toBeNull();
    setAppHint('ops');
    expect(localStorage.getItem('averrow.app')).toBe('ops');
    expect(readAppHint()).toBe('ops');
    setAppHint('tenant');
    expect(readAppHint()).toBe('tenant');
    clearAppHint();
    expect(readAppHint()).toBeNull();
  });

  it('ignores junk values', () => {
    localStorage.setItem('averrow.app', 'v2');
    expect(readAppHint()).toBeNull();
  });
});

// Lifecycle: the hint exists exactly while a session is valid, and is gone by
// the time the host can redirect anywhere (no home <-> app loop).
describe('AuthProvider maintains the hint', () => {
  const user = { id: 'u1', email: 'a@b.c', name: 'A', role: 'analyst' };
  const mk = (over: Partial<AuthHttpClient>): AuthHttpClient => {
    let token: string | null = null;
    return {
      getToken: () => token,
      setTokens: (a: string) => { token = a; },
      clearTokens: () => { token = null; },
      onAuthError: () => undefined,
      get: vi.fn(async () => ({ success: true, data: user })) as AuthHttpClient['get'],
      post: vi.fn(async () => ({ success: true })) as AuthHttpClient['post'],
      ...over,
    };
  };
  const cfg = { userCacheKey: 'hint-test-user', loginPath: '/api/auth/login?return_to=/ops/', returnToPrefix: '/ops', appHint: 'ops' as const };

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('valid session -> hint set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { token: 't', me: user } }), { status: 200 })));
    render(<AuthProvider httpClient={mk({})} config={cfg}><div /></AuthProvider>);
    await waitFor(() => expect(localStorage.getItem('averrow.app')).toBe('ops'));
  });

  it('no session (refresh fails) -> a stale hint is cleared before any redirect', async () => {
    localStorage.setItem('averrow.app', 'ops');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    render(<AuthProvider httpClient={mk({})} config={cfg}><div /></AuthProvider>);
    await waitFor(() => expect(localStorage.getItem('averrow.app')).toBeNull());
  });

  it('a product without appHint never touches the key', async () => {
    localStorage.setItem('averrow.app', 'tenant');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    render(<AuthProvider httpClient={mk({})} config={{ ...cfg, appHint: undefined }}><div /></AuthProvider>);
    await new Promise((r) => setTimeout(r, 20));
    expect(localStorage.getItem('averrow.app')).toBe('tenant');
  });
});
