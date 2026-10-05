/**
 * Notification settings page (docs/ACCOUNT_DESIGN_SPEC.md §5.3), real hooks +
 * real shared sections, network edge (`api`, `lib/push`) mocked.
 *
 * Pins: quiet hours are read/written on v2 ONLY (never a v1 PATCH), the
 * quiet-hours time zone defaults to the profile zone, autosaved controls are
 * optimistic and roll back with an error on failure, brand overrides are hidden
 * for every staff role, the push-blocked banner, and the digest's disabled
 * reasons.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

let mockUser: { id: string; email: string; role: string; name: string; timezone: string | null };
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: mockUser }) }));

vi.mock('@/lib/push', () => ({
  getPushStatus: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
  sendTestPush: vi.fn(),
}));

import { api } from '@/lib/api';
import { getPushStatus, sendTestPush } from '@/lib/push';
import { ToastProvider } from '@averrow/shared/ui';
import { NotificationSettingsPage } from './NotificationSettingsPage';
import { resolveQuietTimezone } from '../../../../shared/src/account/notifications';
import type { NotificationTabId } from '../../../../shared/src/account/notifications';

const get = api.get as ReturnType<typeof vi.fn>;
const put = api.put as ReturnType<typeof vi.fn>;
const patch = api.patch as ReturnType<typeof vi.fn>;
const del = api.delete as ReturnType<typeof vi.fn>;

const V2 = '/api/notifications/preferences/v2';
const V1 = '/api/notifications/preferences';
const SUBS = '/api/notifications/subscriptions';

const baseV2 = {
  inapp_severity_floor: 'info', push_severity_floor: 'low', email_severity_floor: 'high',
  digest_mode: 'daily', digest_severity_floor: 'medium',
  quiet_hours_start: null, quiet_hours_end: null, quiet_hours_timezone: 'UTC',
  critical_bypasses_quiet: 1, show_tenant_notifications: 0,
  cadence_intel: 'realtime', cadence_platform: 'realtime',
};
const pushOk = { supported: true, permission: 'granted', subscribed: true, needsInstall: false };

function mockServer(opts: { v2?: Record<string, unknown>; v1?: Record<string, unknown>; subs?: unknown[] } = {}) {
  get.mockImplementation((url: string) => {
    if (url.startsWith(V2)) return Promise.resolve({ success: true, data: { ...baseV2, ...opts.v2 } });
    if (url.startsWith(SUBS)) return Promise.resolve({ success: true, data: opts.subs ?? [] });
    if (url.startsWith(V1)) return Promise.resolve({ success: true, data: opts.v1 ?? { brand_threat: true, feed_health: true } });
    return Promise.resolve({ success: true });
  });
  put.mockResolvedValue({ success: true });
  patch.mockResolvedValue({ success: true });
  del.mockResolvedValue({ success: true });
}

function stubDom() {
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width'), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderPage(tab: NotificationTabId) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>
          <NotificationSettingsPage tab={tab} hideTitle />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const putBodies = () => put.mock.calls.map(([, body]) => body as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  stubDom();
  mockUser = { id: 'u1', email: 'me@averrow.com', role: 'analyst', name: 'Me', timezone: 'America/Toronto' };
  (getPushStatus as ReturnType<typeof vi.fn>).mockResolvedValue(pushOk);
  mockServer();
});

describe('quiet hours (v2 only)', () => {
  it('saves the window with one explicit v2 PUT, defaults the zone to the profile zone, and never touches v1', async () => {
    renderPage('quiet-hours');
    const user = userEvent.setup();
    const toggle = await screen.findByRole('switch', { name: 'Quiet hours' });
    await user.click(toggle);

    // The form opens prefilled; nothing is written until Save.
    expect(put).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Toronto/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '23:00' } });
    expect(screen.getByText(/Quiet for 8 hours overnight/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0]).toBe(V2);
    expect(put.mock.calls[0]![1]).toEqual({
      quiet_hours_start: '23:00',
      quiet_hours_end: '07:00',
      quiet_hours_timezone: 'America/Toronto',
      critical_bypasses_quiet: 1,
    });
    // v1 (which still carries the old quiet columns) is never written for these.
    expect(patch).not.toHaveBeenCalled();
  });

  it('turning quiet hours off clears the v2 window immediately', async () => {
    mockServer({ v2: { quiet_hours_start: '22:00', quiet_hours_end: '07:00', quiet_hours_timezone: 'Europe/Paris' } });
    renderPage('quiet-hours');
    const toggle = await screen.findByRole('switch', { name: 'Quiet hours' });
    expect(toggle).toBeChecked();
    expect(screen.getByLabelText('From')).toHaveValue('22:00');

    await userEvent.setup().click(toggle);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(putBodies()[0]).toEqual({ quiet_hours_start: null, quiet_hours_end: null });
    expect(patch).not.toHaveBeenCalled();
  });

  it('keeps unsaved edits on screen when the save fails, with an error toast', async () => {
    put.mockResolvedValue({ success: false, error: 'nope' });
    renderPage('quiet-hours');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Quiet hours' }));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '08:30' } });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getAllByRole('alert').some((el) => /couldn't save/i.test(el.textContent ?? ''))).toBe(true));
    expect(screen.getByLabelText('To')).toHaveValue('08:30');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('Discard returns to the saved window', async () => {
    mockServer({ v2: { quiet_hours_start: '22:00', quiet_hours_end: '07:00', quiet_hours_timezone: 'UTC' } });
    renderPage('quiet-hours');
    const user = userEvent.setup();
    await screen.findByLabelText('From');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '21:00' } });
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('From')).toHaveValue('22:00');
    expect(put).not.toHaveBeenCalled();
  });
});

describe('resolveQuietTimezone', () => {
  it('uses the profile zone, then the detected zone, when no window is saved', () => {
    const none = { quiet_hours_start: null, quiet_hours_end: null, quiet_hours_timezone: 'UTC' };
    expect(resolveQuietTimezone(none, 'Asia/Tokyo', 'Europe/Paris')).toBe('Asia/Tokyo');
    expect(resolveQuietTimezone(none, null, 'Europe/Paris')).toBe('Europe/Paris');
    expect(resolveQuietTimezone(none, null, null)).toBe('UTC');
  });
  it('keeps the zone of a saved window, even UTC', () => {
    const saved = { quiet_hours_start: '22:00', quiet_hours_end: '07:00', quiet_hours_timezone: 'UTC' };
    expect(resolveQuietTimezone(saved, 'Asia/Tokyo', 'Europe/Paris')).toBe('UTC');
  });
});

describe('autosave (optimistic + rollback)', () => {
  it('shows the new value at once, then rolls back with an error when the PUT fails', async () => {
    let reject!: (e: Error) => void;
    put.mockImplementation(() => new Promise((_, r) => { reject = r; }));
    renderPage('channels');
    const user = userEvent.setup();
    const email = (await screen.findAllByRole('combobox')).find((el) => (el as HTMLSelectElement).value === 'high') as HTMLSelectElement;
    expect(email).toBeTruthy();

    await user.selectOptions(email, 'critical');
    await waitFor(() => expect(email.value).toBe('critical')); // optimistic
    expect(putBodies()[0]).toEqual({ email_severity_floor: 'critical' });

    reject(new Error('boom'));
    await waitFor(() => expect(email.value).toBe('high')); // rolled back
    await waitFor(() => expect(screen.getAllByRole('alert').some((el) => /couldn't save/i.test(el.textContent ?? ''))).toBe(true));
  });

  it('treats a { success: false } envelope as a failure too (writes only reject on network errors)', async () => {
    put.mockResolvedValue({ success: false, error: 'Invalid push_severity_floor' });
    renderPage('channels');
    const select = (await screen.findAllByRole('combobox')).find((el) => (el as HTMLSelectElement).value === 'low') as HTMLSelectElement;
    await userEvent.setup().selectOptions(select, 'high');
    await waitFor(() => expect(select.value).toBe('low'));
  });

  it('event toggles PATCH v1 with event keys only and roll back on failure', async () => {
    patch.mockResolvedValue({ success: false, error: 'x' });
    renderPage('events');
    const sw = await screen.findByRole('switch', { name: 'New threats against your brands' });
    expect(sw).toBeChecked();
    await userEvent.setup().click(sw);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]![0]).toBe(V1);
    expect(patch.mock.calls[0]![1]).toEqual({ brand_threat: false });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'New threats against your brands' })).toBeChecked());
  });

  it('"Turn all off" sends one batch for the group', async () => {
    renderPage('events');
    const group = (await screen.findByRole('heading', { name: 'Threats and brands' })).closest('section')!;
    await userEvent.setup().click(within(group).getByRole('button', { name: /turn all/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const body = patch.mock.calls[0]![1] as Record<string, boolean>;
    expect(Object.keys(body).sort()).toEqual(
      ['brand_threat', 'campaign_escalation', 'email_security_change', 'takedown_awaiting_approval'],
    );
  });
});

describe('brand overrides', () => {
  const subs = [{ brand_id: 'b1', brand_name: 'Acme', level: 'watching', snoozed_until: null, updated_at: '' }];

  it.each(['super_admin', 'admin', 'analyst', 'sales', 'support', 'billing', 'auditor'])(
    'are hidden for the staff role %s',
    async (role) => {
      mockUser = { ...mockUser, role };
      mockServer({ subs });
      renderPage('events');
      await screen.findByRole('heading', { name: 'Threats and brands' });
      expect(screen.queryByRole('heading', { name: 'Brand overrides' })).not.toBeInTheDocument();
      expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    },
  );

  it('are shown to a customer, with plain-language levels and platform events hidden', async () => {
    mockUser = { ...mockUser, role: 'client' };
    mockServer({ subs });
    renderPage('events');
    expect(await screen.findByRole('heading', { name: 'Brand overrides' })).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Follow closely')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Platform health' })).not.toBeInTheDocument();
  });
});

describe('push', () => {
  it('shows the blocked banner with how to fix it and disables the switch', async () => {
    (getPushStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ supported: true, permission: 'denied', subscribed: false, needsInstall: false });
    renderPage('channels');
    expect(await screen.findByText(/Notifications are blocked in this browser\. Allow them in your browser's site settings, then come back\./)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Push notifications' })).toBeDisabled();
  });

  it('reports the test notification result inline', async () => {
    (sendTestPush as ReturnType<typeof vi.fn>).mockResolvedValue({ attempted: 1, delivered: 1 });
    renderPage('channels');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('Sent. It should arrive in a few seconds.')).toBeInTheDocument();
  });

  it('links to Devices & App for device management', async () => {
    renderPage('channels');
    expect(await screen.findByRole('link', { name: /Devices that get push/ })).toHaveAttribute('href', '/settings/devices');
  });
});

describe('summary tab', () => {
  it('disables Include with a reason while the summary is off', async () => {
    mockServer({ v2: { digest_mode: 'off' } });
    renderPage('digest');
    expect(await screen.findByText('Choose a frequency to schedule summaries.')).toBeInTheDocument();
    expect(screen.getByText('Brand activity summary')).toBeInTheDocument();
  });

  it('keeps "instantly" reachable as its own switch', async () => {
    mockServer({ v2: { digest_mode: 'realtime' } });
    renderPage('digest');
    const sw = await screen.findByRole('switch', { name: 'Send updates instantly' });
    expect(sw).toBeChecked();
    await userEvent.setup().click(sw);
    await waitFor(() => expect(putBodies()[0]).toEqual({ digest_mode: 'daily' }));
  });
});

describe('copy', () => {
  it('uses no internal vocabulary', async () => {
    renderPage('channels');
    await screen.findByRole('tab', { name: 'Channels' });
    const text = document.body.textContent ?? '';
    for (const word of [/tenant/i, /legacy/i, /resend/i, /\bv2\b/i]) expect(text).not.toMatch(word);
  });
});
