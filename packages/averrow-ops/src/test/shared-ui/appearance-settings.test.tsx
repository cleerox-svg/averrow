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
  AppearanceSettings, ACCENT_SWATCHES, BASE_SWATCHES, BASE_CARD_SWATCHES, SWATCH_OUTLINE,
  ProfileSettings, accountSettingsSubtitle, getAccountSections, isAccountSectionEnabled,
} from '@averrow/shared/account';
import {
  APPEARANCE_PICKER_ENABLED, hydrateAppearanceFromAccount, useAppearance, useTheme, ACCENTS, BASES,
} from '@averrow/shared/theme';
import { AuthProvider, useAuth, type AuthHttpClient } from '@averrow/shared/auth';
import { __resetAccountSyncForTests } from '../../../../shared/src/theme/accountSync';
import { __resetAppearanceStoreForTests } from '../../../../shared/src/theme/useAppearance';
import { ToastProvider } from '@averrow/shared/ui';
import { installDomStubs, stubViewport } from '../../features/settings/settingsTestUtils';

const html = document.documentElement;

function resetAppearance() {
  localStorage.clear();
  html.removeAttribute('data-accent');
  html.removeAttribute('data-base');
  html.setAttribute('data-theme', 'dark');
  // Module state: the once-per-session hydration flag + per-field save queues.
  __resetAccountSyncForTests();
  __resetAppearanceStoreForTests();
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

  it('keeps the legacy copy while the flag is false', () => {
    expect(getAccountSections().find((x) => x.id === 'profile')?.description).toBe('Name, appearance and time zone');
    expect(accountSettingsSubtitle()).toBe('Your profile, security and notifications.');
  });

  it('flag on: Profile no longer claims appearance, the subtitle mentions it, and Appearance has its own tone', () => {
    flags.enabled = true;
    const sections = getAccountSections();
    expect(sections.find((x) => x.id === 'profile')?.description).not.toMatch(/appearance/i);
    expect(accountSettingsSubtitle()).toMatch(/appearance/i);
    const tone = sections.find((x) => x.id === 'appearance')?.tone;
    expect(sections.filter((x) => x.id !== 'appearance').map((x) => x.tone)).not.toContain(tone);
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
    __resetAccountSyncForTests(); // a new session (hydration runs once per session)
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

// ── hydration: once per session, never over a local pick (P3-5 review) ──

describe('account hydration runs once per session', () => {
  const BASE_USER = { id: 'u1', email: 'a@b.c', name: 'A', role: 'analyst' };
  function sequenceClient(...users: Array<Record<string, unknown>>): AuthHttpClient {
    const get = vi.fn();
    for (const u of users) get.mockResolvedValueOnce({ success: true, data: { ...BASE_USER, ...u } });
    get.mockResolvedValue({ success: true, data: { ...BASE_USER, ...users[users.length - 1] } });
    return {
      getToken: () => 'tok', setTokens: () => {}, clearTokens: () => {}, onAuthError: () => {},
      get: get as AuthHttpClient['get'],
      post: vi.fn().mockResolvedValue({ success: true }) as AuthHttpClient['post'],
    };
  }
  function Refresh() {
    const { refreshUser } = useAuth();
    return <button type="button" onClick={() => { void refreshUser(); }}>refresh</button>;
  }
  function Picker() {
    const { setAccent } = useAppearance();
    const { setTheme } = useTheme();
    return (
      <>
        <button type="button" onClick={() => setAccent('lime')}>pick lime</button>
        <button type="button" onClick={() => setTheme('light')}>pick light</button>
      </>
    );
  }
  const CONFIG = { userCacheKey: 'test-user', loginPath: '/login' };

  it('refreshUser does not re-apply the account over a newer local pick', async () => {
    flags.enabled = true;
    // /me #1 = violet; /me #2 (the refresh) still carries the OLD violet.
    const http = sequenceClient({ accent_preference: 'violet' }, { accent_preference: 'violet' });
    const user = userEvent.setup();
    render(<AuthProvider httpClient={http} config={CONFIG}><Refresh /><Picker /></AuthProvider>);
    await waitFor(() => expect(html.getAttribute('data-accent')).toBe('violet'));
    await user.click(screen.getByText('pick lime'));
    expect(html.getAttribute('data-accent')).toBe('lime');
    await user.click(screen.getByText('refresh'));
    await waitFor(() => expect(http.get).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(html.getAttribute('data-accent')).toBe('lime');
    expect(localStorage.getItem('averrow-accent')).toBe('lime');
  });

  it('a later /me never re-applies even an unchanged-locally field', async () => {
    flags.enabled = true;
    const http = sequenceClient({ accent_preference: 'violet' }, { accent_preference: 'mono' });
    const user = userEvent.setup();
    render(<AuthProvider httpClient={http} config={CONFIG}><Refresh /></AuthProvider>);
    await waitFor(() => expect(html.getAttribute('data-accent')).toBe('violet'));
    await user.click(screen.getByText('refresh'));
    await waitFor(() => expect(http.get).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(html.getAttribute('data-accent')).toBe('violet');
  });

  it('the first hydration skips a field picked locally before /me arrived, but applies the rest', () => {
    flags.enabled = true;
    const { result } = renderHook(() => useAppearance());
    act(() => result.current.setAccent('lime'));
    act(() => hydrateAppearanceFromAccount({ accent_preference: 'violet', base_preference: 'navy' }));
    expect(html.getAttribute('data-accent')).toBe('lime');
    expect(html.getAttribute('data-base')).toBe('navy');
  });

  it('the first hydration skips a field whose save is still pending', async () => {
    flags.enabled = true;
    let settle: (v: unknown) => void = () => {};
    const patch = vi.fn().mockImplementation(() => new Promise((r) => { settle = r; }));
    const { user } = setup(patch);
    await user.click(screen.getByRole('radio', { name: 'Navy' }));
    act(() => hydrateAppearanceFromAccount({ base_preference: 'graphite' }));
    expect(html.getAttribute('data-base')).toBe('navy');
    await act(async () => { settle({ success: true }); });
    expect(html.getAttribute('data-base')).toBe('navy');
  });

  it('logout starts a new session (the next sign-in hydrates again)', async () => {
    flags.enabled = true;
    hydrateAppearanceFromAccount({ accent_preference: 'violet' });
    const { resetAccountSyncSession } = await import('@averrow/shared/theme');
    resetAccountSyncSession();
    hydrateAppearanceFromAccount({ accent_preference: 'mono' });
    expect(html.getAttribute('data-accent')).toBe('mono');
  });
});

// ── light / dark follows the account (owner decision, P3-5 review) ──

describe('theme_preference hydrates useTheme', () => {
  it('applies the account light/dark and updates mounted useTheme hooks (flag on)', () => {
    flags.enabled = true;
    localStorage.setItem('averrow-theme', 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    act(() => hydrateAppearanceFromAccount({ theme_preference: 'light' }));
    expect(html.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('averrow-theme')).toBe('light');
    expect(result.current.theme).toBe('light');
    expect(result.current.isLight).toBe(true);
  });

  it('a null account theme means Auto (follow the device)', () => {
    flags.enabled = true;
    localStorage.setItem('averrow-theme', 'light');
    hydrateAppearanceFromAccount({ theme_preference: null });
    expect(localStorage.getItem('averrow-theme')).toBe('auto');
  });

  it('an absent theme_preference leaves the device theme alone', () => {
    flags.enabled = true;
    localStorage.setItem('averrow-theme', 'light');
    hydrateAppearanceFromAccount({ accent_preference: 'violet' });
    expect(localStorage.getItem('averrow-theme')).toBe('light');
  });

  it('changes nothing while the flag is off', () => {
    localStorage.setItem('averrow-theme', 'dark');
    hydrateAppearanceFromAccount({ theme_preference: 'light' });
    expect(html.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('averrow-theme')).toBe('dark');
  });

  it('a local theme pick before /me is not overwritten', () => {
    flags.enabled = true;
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('light'));
    act(() => hydrateAppearanceFromAccount({ theme_preference: 'dark' }));
    expect(html.getAttribute('data-theme')).toBe('light');
  });

  it('ProfileSettings still PATCHes light/dark, and a later /me cannot undo it', async () => {
    flags.enabled = true;
    hydrateAppearanceFromAccount({ theme_preference: 'dark' });
    expect(html.getAttribute('data-theme')).toBe('dark');
    const patch = vi.fn().mockResolvedValue({ success: true });
    function Host() {
      const { theme, setTheme } = useTheme();
      return (
        <ProfileSettings
          user={{ id: 'u1', email: 'a@b.c', name: 'A', role: 'analyst', organization: null }}
          apiClient={{ patch }}
          theme={theme}
          onThemeChange={setTheme}
          onUserUpdated={async () => { hydrateAppearanceFromAccount({ theme_preference: 'dark' }); }}
          onSignOut={() => {}}
        />
      );
    }
    render(<ToastProvider><Host /></ToastProvider>);
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Light' }));
    expect(patch).toHaveBeenCalledWith('/api/profile', { theme_preference: 'light' });
    await act(async () => { await Promise.resolve(); });
    expect(html.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('averrow-theme')).toBe('light');
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

describe('serialized saves (P3-5 review)', () => {
  /** A patch whose calls settle only when the test says so. */
  function controlledPatch() {
    const pending: Array<(v: unknown) => void> = [];
    const patch = vi.fn().mockImplementation(() => new Promise((r) => { pending.push(r); }));
    return { patch, settle: async (i: number, v: unknown) => { await act(async () => { pending[i]!(v); }); } };
  }

  it('one PATCH at a time; after it settles only the latest pick is sent', async () => {
    const { patch, settle } = controlledPatch();
    const { user } = setup(patch);
    await user.click(screen.getByRole('radio', { name: 'Violet' }));
    await user.click(screen.getByRole('radio', { name: 'Mono' }));
    await user.click(screen.getByRole('radio', { name: 'Lime' }));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenLastCalledWith('/api/profile', { accent_preference: 'violet' });
    await settle(0, { success: true });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenLastCalledWith('/api/profile', { accent_preference: 'lime' });
    await settle(1, { success: true });
    expect(html.getAttribute('data-accent')).toBe('lime');
  });

  it('A then B, both failing: reverts to the last server-confirmed value, not A', async () => {
    flags.enabled = true;
    hydrateAppearanceFromAccount({ accent_preference: 'mono' }); // server-confirmed
    const { patch, settle } = controlledPatch();
    const { user } = setup(patch);
    await user.click(screen.getByRole('radio', { name: 'Violet' })); // A
    await user.click(screen.getByRole('radio', { name: 'Lime' }));   // B
    await settle(0, { success: false });
    expect(html.getAttribute('data-accent')).toBe('lime'); // superseded: no revert yet
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    await settle(1, { success: false });
    expect(html.getAttribute('data-accent')).toBe('mono');
    expect(localStorage.getItem('averrow-accent')).toBe('mono');
    expect(screen.getByRole('radio', { name: 'Mono' })).toBeChecked();
    expect(await screen.findAllByText(/Couldn't save your appearance/)).toHaveLength(1);
  });

  it('A failing, B succeeding: keeps B and does not toast', async () => {
    const { patch, settle } = controlledPatch();
    const { user } = setup(patch);
    await user.click(screen.getByRole('radio', { name: 'Navy' }));     // A
    await user.click(screen.getByRole('radio', { name: 'Graphite' })); // B
    await settle(0, { success: false });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenLastCalledWith('/api/profile', { base_preference: 'graphite' });
    await settle(1, { success: true });
    expect(html.getAttribute('data-base')).toBe('graphite');
    expect(screen.queryByText(/Couldn't save your appearance/)).toBeNull();
  });

  it('a failure after a confirmed save reverts to that save, not to the start', async () => {
    const { patch, settle } = controlledPatch();
    const { user } = setup(patch);
    await user.click(screen.getByRole('radio', { name: 'Violet' }));
    await settle(0, { success: true });
    await user.click(screen.getByRole('radio', { name: 'Lime' }));
    await settle(1, { success: false });
    expect(html.getAttribute('data-accent')).toBe('violet');
  });
});

describe('storage events with hostile values (P3-5 review)', () => {
  it.each([
    ['averrow-accent', 'data-accent', '"><img src=x onerror=alert(1)>'],
    ['averrow-accent', 'data-accent', 'INDIGO'],
    ['averrow-base', 'data-base', 'navy; background:url(//evil)'],
  ])('%s = %j applies the default and never writes it to <html>', (key, attr, bad) => {
    html.setAttribute('data-accent', 'violet');
    html.setAttribute('data-base', 'navy');
    const { result } = renderHook(() => useAppearance());
    const spy = vi.spyOn(html, 'setAttribute');
    act(() => {
      localStorage.setItem(key, bad);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: bad }));
    });
    // Default today is null = no attribute (the legacy look).
    expect(html.hasAttribute(attr)).toBe(false);
    expect(spy.mock.calls.some(([, v]) => v === bad)).toBe(false);
    expect(result.current[attr === 'data-accent' ? 'accent' : 'base']).toBeNull();
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
  it.each(BASES)('%s card chip matches its dark --bg-card (indigo layer)', (b) => {
    const sel = b === 'navy'
      ? ':root[data-accent="indigo"][data-base="navy"]:not([data-theme="light"])'
      : ':root[data-accent="indigo"]:not([data-base="navy"]):not([data-theme="light"])';
    expect(BASE_CARD_SWATCHES[b]).toBe(tokenIn(sel, '--bg-card'));
  });

  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  it.each([...BASES.map((b) => BASE_CARD_SWATCHES[b]), '#ffffff'])(
    'the swatch outline is >= 3:1 against a %s card', (card) => {
      expect(contrast(SWATCH_OUTLINE, card)).toBeGreaterThanOrEqual(3);
    },
  );

  it('renders the background swatch as page colour with a card-colour chip', () => {
    setup();
    for (const b of BASES) {
      const sw = document.querySelector(`[data-swatch="${b}"]`) as HTMLElement;
      expect(sw).not.toBeNull();
      expect(sw.querySelector('[data-swatch-card]')).not.toBeNull();
    }
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
