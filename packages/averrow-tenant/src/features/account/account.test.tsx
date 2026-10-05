// Tenant account area (docs/ACCOUNT_DESIGN_SPEC.md) — route wiring and the
// tenant-specific rules, through the real route table + real shared pages with
// only the network edge (`@/lib/api`, `@/lib/auth`, `@/lib/passkeys`) mocked.
//
// Pins: /profile -> /account/profile, no Devices & App section (no tenant
// service worker), brand overrides visible to a client, push shown as
// unavailable, and the Security page reading the caller-scoped sessions API.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configure, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  logout: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/lib/api', () => ({
  apiGet: mocks.get, apiPost: mocks.post, apiPatch: mocks.patch, apiPut: mocks.put, apiDelete: mocks.del,
}));
vi.mock('@/lib/passkeys', () => ({ isPasskeySupported: () => true, registerPasskey: vi.fn() }));

import { accountRoutes } from './routes';

configure({ asyncUtilTimeout: 10000 });

function stubDom(desktop: boolean) {
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width') ? desktop : query.includes('max-width') ? !desktop : false,
    media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route element={<Outlet />}>{accountRoutes}</Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const baseV2 = {
  inapp_severity_floor: 'info', push_severity_floor: 'low', email_severity_floor: 'high',
  digest_mode: 'daily', digest_severity_floor: 'medium',
  quiet_hours_start: null, quiet_hours_end: null, quiet_hours_timezone: 'UTC',
  critical_bypasses_quiet: 1, show_tenant_notifications: 0,
  cadence_intel: 'realtime', cadence_platform: 'realtime',
};
const subs = [{ brand_id: 'b1', brand_name: 'Acme', level: 'watching', snoozed_until: null, updated_at: '' }];

beforeEach(() => {
  vi.clearAllMocks();
  stubDom(true);
  mocks.get.mockImplementation((url: string) => {
    if (url.startsWith('/api/notifications/preferences/v2')) return Promise.resolve({ success: true, data: baseV2 });
    if (url.startsWith('/api/notifications/subscriptions')) return Promise.resolve({ success: true, data: subs });
    if (url.startsWith('/api/notifications/preferences')) return Promise.resolve({ success: true, data: { brand_threat: true } });
    if (url.startsWith('/api/auth/sessions')) return Promise.resolve({ success: true, data: { total: 0, current_known: false, sessions: [] } });
    if (url.startsWith('/api/passkeys')) return Promise.resolve({ success: true, data: [] });
    return Promise.resolve({ success: true, data: null });
  });
  mocks.put.mockResolvedValue({ success: true, data: null });
  mocks.useAuth.mockReturnValue({
    isAuthenticated: true,
    loading: false,
    user: {
      id: 'u1', email: 'cust@acme.com', name: 'Cust', role: 'client', passkey_count: 1,
      organization: { id: 'o1', name: 'Acme', slug: 'acme', plan: 'professional', role: 'owner' },
    },
    refreshUser: vi.fn(),
    logout: mocks.logout,
  });
});

describe('account routes', () => {
  it('redirects legacy /profile to /account/profile', async () => {
    renderAt('/profile');
    expect(await screen.findByLabelText('Display name')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/account/profile');
  });

  it('desktop: /account lands on Profile and the rail offers no Devices & App', async () => {
    renderAt('/account');
    expect(await screen.findByLabelText('Display name')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/account/profile');
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav).toHaveTextContent('Profile');
    expect(nav).toHaveTextContent('Security');
    expect(nav).toHaveTextContent('Notifications');
    expect(nav).not.toHaveTextContent('Devices');
    // Links live under /account, never the org /settings area.
    for (const a of nav.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^\/account\//);
  });

  it('mobile: /account is the section list, without Devices & App', async () => {
    stubDom(false);
    renderAt('/account');
    expect(await screen.findByRole('link', { name: /Security/ })).toHaveAttribute('href', '/account/security');
    expect(screen.getByRole('link', { name: /Profile/ })).toHaveAttribute('href', '/account/profile');
    expect(screen.getByRole('link', { name: /Notifications/ })).toHaveAttribute('href', '/account/notifications');
    expect(screen.queryByText(/Devices/)).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/account$/);
  });

  it('/account/devices does not exist: it falls back to Profile', async () => {
    renderAt('/account/devices');
    expect(await screen.findByLabelText('Display name')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/account/profile');
  });

  it('/account/notifications defaults to the Channels tab; an unknown tab redirects there', async () => {
    renderAt('/account/notifications/bogus');
    expect(await screen.findByRole('switch', { name: 'Push notifications' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/account/notifications/channels');
  });
});

describe('notifications for a customer', () => {
  it('shows brand overrides (and no platform-health group) on the Events tab', async () => {
    renderAt('/account/notifications/events');
    expect(await screen.findByRole('heading', { name: 'Brand overrides' })).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Platform health' })).not.toBeInTheDocument();
  });

  it('shows push as unavailable (no service worker) with the switch disabled and no devices link', async () => {
    renderAt('/account/notifications/channels');
    expect(await screen.findByText("Push isn't available here")).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Push notifications' })).toBeDisabled();
    expect(screen.queryByText('Devices that get push')).not.toBeInTheDocument();
  });

  it('loads prefs and subscriptions from the caller-scoped endpoints without writing', async () => {
    renderAt('/account/notifications/events');
    await screen.findByText('Acme');
    // Nothing is written on load.
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledWith('/api/notifications/preferences/v2');
    expect(mocks.get).toHaveBeenCalledWith('/api/notifications/subscriptions');
  });
});

describe('security for a customer', () => {
  it('reads the caller-scoped sessions list and passkeys', async () => {
    renderAt('/account/security');
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/auth/sessions'));
    expect(mocks.get).toHaveBeenCalledWith('/api/passkeys');
  });
});
