// Account-synced appearance (facelift P3-5):
//   - Settings -> Appearance is hidden while APPEARANCE_PICKER_ENABLED is false
//     and listed once it is true (the flag is mocked through a getter);
//   - the account's accent/base hydrate from /api/auth/me (server wins), and
//     never while the flag is false;
//   - AppearanceSettings applies a choice instantly, PATCHes the profile and
//     reverts + toasts on failure; Background is disabled in light mode;
//   - useAppearance instances share one store and follow other tabs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const flags = vi.hoisted(() => ({ enabled: false }));

vi.mock('../../../../shared/src/theme/appearanceDefaults', async (orig) => {
  const real = await orig<typeof import('../../../../shared/src/theme/appearanceDefaults')>();
  return {
    ...real,
    get APPEARANCE_PICKER_ENABLED() { return flags.enabled; },
  };
});

import {
  AppearanceSettings, ACCENT_SWATCHES, BASE_SWATCHES, getAccountSections, isAccountSectionEnabled,
} from '@averrow/shared/account';
import {
  APPEARANCE_PICKER_ENABLED, hydrateAppearanceFromAccount, useAppearance, ACCENTS, BASES,
} from '@averrow/shared/theme';
import { AuthProvider, type AuthHttpClient } from '@averrow/shared/auth';
import { ToastProvider } from '@averrow/shared/ui';
import { installDomStubs, stubViewport } from '../../features/settings/settingsTestUtils';

const html = document.documentElement;

function resetAppearance() {
  localStorage.clear();
  html.removeAttribute('data-accent');
  html.removeAttribute('data-base');
  html.setAttribute('data-theme', 'dark');
}

beforeEach(() => {
  flags.enabled = false;
  resetAppearance();
  installDomStubs();
  stubViewport(true);
});
afterEach(() => vi.restoreAllMocks());

// ── flag + sections ────────────────────────────────────────────────

describe('APPEARANCE_PICKER_ENABLED', () => {
  it('ships false (nothing changes for users until the P3-6 flip)', async () => {
    const real = await vi.importActual<typeof import('../../../../shared/src/theme/appearanceDefaults')>(
      '../../../../shared/src/theme/appearanceDefaults',
    );
    expect(real.APPEARANCE_PICKER_ENABLED).toBe(false);
  });

  it('the mocked flag reaches the public theme export', () => {
    expect(APPEARANCE_PICKER_ENABLED).toBe(false);
    flags.enabled = true;
    expect(APPEARANCE_PICKER_ENABLED).toBe(true);
  });
});

describe('getAccountSections', () => {
  it('leaves Appearance out while the flag is false', () => {
    expect(isAccountSectionEnabled('appearance')).toBe(false);
    expect(isAccountSectionEnabled('profile')).toBe(true);
    const ids = getAccountSections().map((s) => s.id);
    expect(ids).toEqual(['profile', 'security', 'notifications', 'devices']);
  });

  it('lists Appearance (after Security) once the flag is true', () => {
    flags.enabled = true;
    const sections = getAccountSections({ basePath: '/account' });
    expect(sections.map((s) => s.id)).toEqual(['profile', 'security', 'appearance', 'notifications', 'devices']);
    expect(sections.find((s) => s.id === 'appearance')).toMatchObject({
      label: 'Appearance', href: '/account/appearance', group: 'Preferences',
    });
  });
});

// ── hydration ─────────────────────────────────────────────────────

describe('hydrateAppearanceFromAccount', () => {
  it('is a no-op while the flag is false', () => {
    localStorage.setItem('averrow-accent', 'lime');
    hydrateAppearanceFromAccount({ accent_preference: 'violet', base_preference: 'navy' });
    expect(html.hasAttribute('data-accent')).toBe(false);
    expect(localStorage.getItem('averrow-accent')).toBe('lime');
  });

  it('server values win over localStorage', () => {
    flags.enabled = true;
    localStorage.setItem('averrow-accent', 'lime');
    localStorage.setItem('averrow-base', 'graphite');
    hydrateAppearanceFromAccount({ accent_preference: 'violet', base_preference: 'navy' });
    expect(html.getAttribute('data-accent')).toBe('violet');
    expect(html.getAttribute('data-base')).toBe('navy');
    expect(localStorage.getItem('averrow-accent')).toBe('violet');
    expect(localStorage.getItem('averrow-base')).toBe('navy');
  });

  it('a present null (or unknown value) means the default; an absent field leaves the device choice', () => {
    flags.enabled = true;
    localStorage.setItem('averrow-accent', 'lime');
    localStorage.setItem('averrow-base', 'navy');
    hydrateAppearanceFromAccount({ accent_preference: null });
    expect(localStorage.getItem('averrow-accent')).toBeNull();
    expect(localStorage.getItem('averrow-base')).toBe('navy'); // field absent: untouched
    hydrateAppearanceFromAccount({ base_preference: 'bogus' });
    expect(localStorage.getItem('averrow-base')).toBeNull();
    hydrateAppearanceFromAccount(null);
    hydrateAppearanceFromAccount(undefined);
  });

  it('updates mounted useAppearance hooks', () => {
    flags.enabled = true;
    const { result } = renderHook(() => useAppearance());
    expect(result.current.accent).toBeNull();
    act(() => hydrateAppearanceFromAccount({ accent_preference: 'mono', base_preference: 'navy' }));
    expect(result.current.accent).toBe('mono');
    expect(result.current.base).toBe('navy');
  });
});

describe('AuthProvider hydrates appearance from /api/auth/me', () => {
  function client(user: Record<string, unknown>): AuthHttpClient {
    return {
      getToken: () => 'tok',
      setTokens: () => {},
      clearTokens: () => {},
      onAuthError: () => {},
      get: vi.fn().mockResolvedValue({ success: true, data: user }) as AuthHttpClient['get'],
      post: vi.fn().mockResolvedValue({ success: true }) as AuthHttpClient['post'],
    };
  }
  const USER = { id: 'u1', email: 'a@b.c', name: 'A', role: 'analyst', accent_preference: 'violet', base_preference: 'navy' };

  it('applies the server accent/base once the user is validated (flag on)', async () => {
    flags.enabled = true;
    localStorage.setItem('averrow-accent', 'lime');
    const http = client(USER);
    render(<AuthProvider httpClient={http} config={{ userCacheKey: 'test-user', loginPath: '/login' }}><div /></AuthProvider>);
    await waitFor(() => expect(html.getAttribute('data-accent')).toBe('violet'));
    expect(html.getAttribute('data-base')).toBe('navy');
    expect(http.get).toHaveBeenCalledWith('/api/auth/me');
  });

  it('changes nothing while the flag is off', async () => {
    const http = client(USER);
    render(<AuthProvider httpClient={http} config={{ userCacheKey: 'test-user', loginPath: '/login' }}><div /></AuthProvider>);
    await waitFor(() => expect(http.get).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(html.hasAttribute('data-accent')).toBe(false);
    expect(html.hasAttribute('data-base')).toBe(false);
  });
});

// ── the page ──────────────────────────────────────────────────────

function setup(patch = vi.fn().mockResolvedValue({ success: true })) {
  render(<ToastProvider><AppearanceSettings apiClient={{ patch }} /></ToastProvider>);
  return { patch, user: userEvent.setup() };
}

describe('AppearanceSettings', () => {
  it('shows four accents and two backgrounds; indigo / graphite read as selected by default', () => {
    setup();
    for (const label of ['Indigo', 'Violet', 'Mono', 'Lime', 'Graphite', 'Navy']) {
      expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('radio', { name: 'Indigo' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Graphite' })).toBeChecked();
  });

  it('applies an accent instantly and saves it to the account', async () => {
    const { user, patch } = setup();
    await user.click(screen.getByRole('radio', { name: 'Violet' }));
    expect(html.getAttribute('data-accent')).toBe('violet');
    expect(localStorage.getItem('averrow-accent')).toBe('violet');
    expect(patch).toHaveBeenCalledWith('/api/profile', { accent_preference: 'violet' });
    expect(screen.getByRole('radio', { name: 'Violet' })).toBeChecked();
  });

  it('saves the background', async () => {
    const { user, patch } = setup();
    await user.click(screen.getByRole('radio', { name: 'Navy' }));
    expect(html.getAttribute('data-base')).toBe('navy');
    expect(patch).toHaveBeenCalledWith('/api/profile', { base_preference: 'navy' });
  });

  it('reverts and toasts when the save fails', async () => {
    localStorage.setItem('averrow-accent', 'lime');
    html.setAttribute('data-accent', 'lime');
    const patch = vi.fn().mockResolvedValue({ success: false, error: 'nope' });
    const { user } = setup(patch);
    await user.click(screen.getByRole('radio', { name: 'Mono' }));
    expect(await screen.findByText(/Couldn't save your appearance/)).toBeInTheDocument();
    expect(html.getAttribute('data-accent')).toBe('lime');
    expect(localStorage.getItem('averrow-accent')).toBe('lime');
    expect(screen.getByRole('radio', { name: 'Lime' })).toBeChecked();
  });

  it('a rejected request also reverts', async () => {
    const patch = vi.fn().mockRejectedValue(new Error('offline'));
    const { user } = setup(patch);
    await user.click(screen.getByRole('radio', { name: 'Navy' }));
    expect(await screen.findByText(/Couldn't save your appearance/)).toBeInTheDocument();
    expect(html.hasAttribute('data-base')).toBe(false);
    expect(localStorage.getItem('averrow-base')).toBeNull();
  });

  it('a failed earlier save does not revert a later choice', async () => {
    let failFirst: (v: unknown) => void = () => {};
    const patch = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { failFirst = r; }))
      .mockResolvedValue({ success: true });
    const { user } = setup(patch);
    await user.click(screen.getByRole('radio', { name: 'Violet' }));
    await user.click(screen.getByRole('radio', { name: 'Lime' }));
    await act(async () => { failFirst({ success: false }); });
    expect(html.getAttribute('data-accent')).toBe('lime');
  });

  it('disables Background in light mode and says why', async () => {
    html.setAttribute('data-theme', 'light');
    const { patch } = setup();
    expect(screen.getByRole('radio', { name: 'Navy' })).toBeDisabled();
    expect(screen.getByText(/Backgrounds apply in dark mode/)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    // Re-enables live when the theme flips back to dark.
    act(() => html.setAttribute('data-theme', 'dark'));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Navy' })).toBeEnabled());
  });
});

describe('swatch colours', () => {
  const css = readFileSync(resolve(__dirname, '../../../../shared/src/theme/appearance.css'), 'utf8');
  const tokenIn = (selector: string, token: string) => {
    const i = css.indexOf(`${selector} {`);
    expect(i, selector).toBeGreaterThan(-1);
    const block = css.slice(i, css.indexOf('}', i));
    return new RegExp(`${token}:\\s*([^;]+);`).exec(block)?.[1]?.trim().toLowerCase();
  };
  it.each(ACCENTS)('%s matches its dark --primary', (a) => {
    expect(ACCENT_SWATCHES[a]).toBe(tokenIn(`:root[data-accent="${a}"]:not([data-theme="light"])`, '--primary'));
  });
  it.each(BASES)('%s matches its dark --bg-page (indigo layer)', (b) => {
    const sel = b === 'navy'
      ? ':root[data-accent="indigo"][data-base="navy"]:not([data-theme="light"])'
      : ':root[data-accent="indigo"]:not([data-base="navy"]):not([data-theme="light"])';
    expect(BASE_SWATCHES[b]).toBe(tokenIn(sel, '--bg-page'));
  });
});

// ── shared store ──────────────────────────────────────────────────

describe('useAppearance shared store', () => {
  it('keeps every instance in sync', () => {
    const a = renderHook(() => useAppearance());
    const b = renderHook(() => useAppearance());
    act(() => a.result.current.setAccent('violet'));
    expect(b.result.current.accent).toBe('violet');
    act(() => b.result.current.setBase('navy'));
    expect(a.result.current.base).toBe('navy');
  });

  it('follows a change made in another tab (storage event)', () => {
    const { result } = renderHook(() => useAppearance());
    act(() => {
      localStorage.setItem('averrow-accent', 'lime');
      window.dispatchEvent(new StorageEvent('storage', { key: 'averrow-accent', newValue: 'lime' }));
    });
    expect(result.current.accent).toBe('lime');
    expect(html.getAttribute('data-accent')).toBe('lime');
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(result.current.accent).toBeNull();
    expect(html.hasAttribute('data-accent')).toBe(false);
  });

  it('ignores unrelated storage keys', () => {
    const { result } = renderHook(() => useAppearance());
    act(() => {
      localStorage.setItem('averrow-accent', 'mono'); // written without an event for our key
      window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }));
    });
    expect(result.current.accent).toBeNull();
  });
});
