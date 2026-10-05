// Security page behaviour: honest loading/error/empty states, passkey removal,
// per-session sign-out, sign out other devices, sign out everywhere.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@averrow/shared/ui';
import { SecuritySettings } from '../../../../shared/src/account/security';
import type {
  SecurityApiClient, SecurityApiResponse, SecurityPasskeyAdapter, PasskeyDevice,
} from '../../../../shared/src/account/security/types';
import { installDomStubs, stubViewport } from '@/test/shared-ui/overlays/helpers';

const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const session = (id: string, over: Record<string, unknown> = {}) => ({
  id, user_agent: UA_MAC, ip_masked: '203.0.113.•••', issued_at: iso(86_400_000),
  last_active_at: iso(3 * 3_600_000), auth_method: 'google_oauth', is_current: false, ...over,
});

const passkey = (id: string, label: string): PasskeyDevice => ({
  id, device_label: label, user_agent: null, backed_up: 0, transports: ['internal'],
  created_at: iso(10 * 86_400_000), last_used_at: iso(2 * 86_400_000),
});

type Handler = (path: string, body?: unknown) => SecurityApiResponse<unknown> | Promise<SecurityApiResponse<unknown>>;

function setup(opts: {
  sessions?: Handler;
  list?: () => Promise<PasskeyDevice[]>;
  remove?: (id: string) => Promise<void>;
  supported?: boolean;
  requiresPasskey?: boolean;
  onSignedOut?: () => void;
  post?: Handler;
  del?: Handler;
} = {}) {
  const defaultSessions = () => ({
    success: true,
    data: { total: 2, current_known: true, sessions: [session('s-other'), session('s-cur', { is_current: true, last_active_at: iso(1000), auth_method: 'passkey' })] },
  });
  const api = {
    get: vi.fn(async (p: string) => (opts.sessions ?? defaultSessions)(p)),
    post: vi.fn(async (p: string, b?: unknown) => (opts.post ?? (() => ({ success: true, data: { revoked: 1 } })))(p, b)),
    delete: vi.fn(async (p: string) => (opts.del ?? (() => ({ success: true })))(p)),
  } as unknown as SecurityApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  const passkeys: SecurityPasskeyAdapter & { remove: ReturnType<typeof vi.fn> } = {
    isSupported: () => opts.supported ?? true,
    list: opts.list ?? (async () => [passkey('pk1', 'MacBook Touch ID'), passkey('pk2', 'YubiKey 5')]),
    register: vi.fn(async () => {}),
    remove: vi.fn(opts.remove ?? (async () => {})),
  };
  const onSignedOut = opts.onSignedOut ?? vi.fn();
  render(
    <ToastProvider>
      <SecuritySettings api={api} passkeys={passkeys} onSignedOut={onSignedOut} requiresPasskey={opts.requiresPasskey} />
    </ToastProvider>,
  );
  return { api, passkeys, onSignedOut: onSignedOut as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  installDomStubs();
  stubViewport(false);
});

describe('Security page — states never lie', () => {
  it('shows loading skeletons, no counts, and no "0 sessions" / "No passkeys" while loading', () => {
    setup({ sessions: () => new Promise(() => {}), list: () => new Promise(() => {}) });
    expect(screen.getByText('Loading your passkeys…')).toBeInTheDocument();
    expect(screen.getByText('Loading your sessions…')).toBeInTheDocument();
    expect(screen.queryByText(/0 active sessions?/i)).toBeNull();
    expect(screen.queryByText(/0 passkeys?/i)).toBeNull();
    expect(screen.queryByText('No passkeys yet')).toBeNull();
    expect(screen.queryByText('Your account is protected')).toBeNull();
  });

  it('shows an error with retry when sessions fail, then recovers', async () => {
    let fail = true;
    const { api } = setup({ sessions: () => (fail ? { success: false, error: 'boom' } : { success: true, data: { sessions: [session('s1', { is_current: true })], current_known: true } }) });
    expect(await screen.findByText("Couldn't load your sessions")).toBeInTheDocument();
    expect(screen.queryByText(/0 active sessions?/i)).toBeNull();
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: /Try again: Couldn't load your sessions/ }));
    expect(await screen.findByText('This device')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('shows an error (not "No passkeys yet") when the passkey list fails', async () => {
    setup({ list: async () => { throw new Error('nope'); } });
    expect(await screen.findByText("Couldn't load your passkeys")).toBeInTheDocument();
    expect(screen.queryByText('No passkeys yet')).toBeNull();
    expect(screen.queryByText('Your account is protected')).toBeNull();
    expect(screen.queryByText('Add a passkey to secure your account')).toBeNull();
  });

  it('empty passkey list prompts to add one', async () => {
    setup({ list: async () => [] });
    expect(await screen.findByText('No passkeys yet')).toBeInTheDocument();
    expect(screen.getByText('Add a passkey to secure your account')).toBeInTheDocument();
    expect(screen.getByText('0 passkeys')).toBeInTheDocument();
  });

  it('renders the protected status card with real chips once loaded', async () => {
    setup();
    expect(await screen.findByText('Your account is protected')).toBeInTheDocument();
    expect(screen.getByText('2 passkeys')).toBeInTheDocument();
    expect(screen.getByText('2 active sessions')).toBeInTheDocument();
    expect(screen.getByText('Signed in with a passkey')).toBeInTheDocument();
    expect(screen.getByText('MacBook Touch ID')).toBeInTheDocument();
    expect(screen.getAllByText(/Last used 2 days ago/)).toHaveLength(2);
  });

  it('unsupported browser: banner, Add disabled with a reason, list still loads', async () => {
    setup({ supported: false });
    expect(await screen.findByText('MacBook Touch ID')).toBeInTheDocument();
    const add = screen.getAllByRole('button', { name: /Add passkey/ })[0]!;
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', expect.stringMatching(/doesn't support passkeys/));
    expect(screen.getAllByText(/doesn't support passkeys/).length).toBeGreaterThan(0);
  });
});

describe('Security page — sessions', () => {
  it('lists this device first with a badge and no Sign out button on it', async () => {
    setup();
    await screen.findByText('This device');
    const rows = screen.getAllByText('Chrome on macOS');
    expect(rows).toHaveLength(2);
    // This device is first.
    expect(rows[0]!.closest('.ds-srow')).toContainElement(screen.getByText('This device'));
    expect(within(rows[0]!.closest('.ds-srow') as HTMLElement).queryByRole('button', { name: /Sign out/ })).toBeNull();
    expect(within(rows[1]!.closest('.ds-srow') as HTMLElement).getByRole('button', { name: /Sign out Chrome on macOS/ })).toBeInTheDocument();
    expect(screen.getAllByText('203.0.113.•••').length).toBe(2);
  });

  it('signs out one session via DELETE and refreshes the list', async () => {
    const { api } = setup();
    await screen.findByText('This device');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out Chrome on macOS' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/auth/sessions/s-other'));
    expect(await screen.findByText('Signed out Chrome on macOS.')).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it('shows the row error and a toast when a session sign-out fails', async () => {
    setup({ del: () => ({ success: false, error: 'Session not found' }) });
    await screen.findByText('This device');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out Chrome on macOS' }));
    expect((await screen.findAllByText('Session not found')).length).toBeGreaterThan(0);
  });

  it('caps at 5 sessions and reveals the rest', async () => {
    const many = [session('cur', { is_current: true })]
      .concat(Array.from({ length: 6 }, (_, i) => session(`o${i}`, { user_agent: UA_IPHONE, last_active_at: iso((i + 1) * 3_600_000) })));
    setup({ sessions: () => ({ success: true, data: { current_known: true, sessions: many } }) });
    await screen.findByText('This device');
    expect(screen.getAllByText('Safari on iOS')).toHaveLength(4);
    const more = screen.getByRole('button', { name: 'Show 2 more' });
    await userEvent.setup().click(more);
    expect(screen.getAllByText('Safari on iOS')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument();
  });
});

describe('Security page — passkey removal', () => {
  async function openRemove(user: ReturnType<typeof userEvent.setup>, label: string) {
    await screen.findByText(label);
    const trigger = screen.getByRole('button', { name: `Options for ${label}` });
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    return screen.findByRole('dialog', { name: 'Remove this passkey?' });
  }

  it('confirms before removing, then calls the adapter and refreshes', async () => {
    const user = userEvent.setup();
    const { passkeys } = setup();
    const dialog = await openRemove(user, 'YubiKey 5');
    expect(within(dialog).getByText(/You can add it again anytime/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/only passkey/)).toBeNull();
    expect(passkeys.remove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove passkey' }));
    await waitFor(() => expect(passkeys.remove).toHaveBeenCalledWith('pk2'));
    expect(await screen.findByText('Passkey removed.')).toBeInTheDocument();
  });

  it('warns when it is the last passkey', async () => {
    const user = userEvent.setup();
    setup({ list: async () => [passkey('pk1', 'MacBook Touch ID')] });
    const dialog = await openRemove(user, 'MacBook Touch ID');
    expect(within(dialog).getByText(/This is your only passkey\. After removing it you'll sign in with Google\./)).toBeInTheDocument();
  });

  it('uses the stronger warning for roles that require a passkey', async () => {
    const user = userEvent.setup();
    setup({ list: async () => [passkey('pk1', 'MacBook Touch ID')], requiresPasskey: true });
    const dialog = await openRemove(user, 'MacBook Touch ID');
    expect(within(dialog).getByText(/Your role requires one/)).toBeInTheDocument();
  });

  it('keeps the dialog open with the error when removal fails', async () => {
    const user = userEvent.setup();
    setup({ remove: async () => { throw new Error('Could not remove it'); } });
    const dialog = await openRemove(user, 'YubiKey 5');
    await user.click(within(dialog).getByRole('button', { name: 'Remove passkey' }));
    expect(await within(dialog).findByText('Could not remove it')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Remove this passkey?' })).toBeInTheDocument();
  });
});

describe('Security page — sign-out actions', () => {
  it('sign out other devices: confirms, posts, stays signed in', async () => {
    const user = userEvent.setup();
    const { api, onSignedOut } = setup();
    await screen.findByText('This device');
    await user.click(screen.getByRole('button', { name: 'Sign out other devices' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign out other devices?' });
    expect(within(dialog).getByText("You'll stay signed in here.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Sign out other devices' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/auth/sessions/revoke-others'));
    expect(await screen.findByText('Signed out your other devices.')).toBeInTheDocument();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('disables sign out other devices with a reason when there are none', async () => {
    setup({ sessions: () => ({ success: true, data: { current_known: true, sessions: [session('cur', { is_current: true })] } }) });
    await screen.findByText('This device');
    expect(screen.getByRole('button', { name: 'Sign out other devices' })).toBeDisabled();
    expect(screen.getByText('No other devices are signed in.')).toBeInTheDocument();
  });

  it('sign out everywhere: confirm copy, posts, then logs the user out', async () => {
    const user = userEvent.setup();
    const { api, onSignedOut } = setup();
    await screen.findByText('This device');
    await user.click(screen.getAllByRole('button', { name: 'Sign out everywhere' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of all devices?' });
    expect(within(dialog).getByText(/This ends all your sessions, including this one\./)).toBeInTheDocument();
    expect(within(dialog).getByText("You'll need to sign in again.")).toBeInTheDocument();
    expect(onSignedOut).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/auth/logout-all'));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
  });

  it('does not log out when sign out everywhere fails', async () => {
    const user = userEvent.setup();
    const { onSignedOut } = setup({ post: () => ({ success: false, error: 'Server said no' }) });
    await screen.findByText('This device');
    await user.click(screen.getAllByRole('button', { name: 'Sign out everywhere' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of all devices?' });
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    expect(await within(dialog).findByText('Server said no')).toBeInTheDocument();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('shows the Google footer note', async () => {
    setup();
    expect(await screen.findByText('Averrow never stores your Google password. Sign-in is handled by Google.')).toBeInTheDocument();
  });
});
