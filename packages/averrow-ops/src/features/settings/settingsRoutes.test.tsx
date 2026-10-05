// Route wiring for the account area, exercised through the real <App/> route table
// (only the shell chrome is stubbed).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Outlet, useLocation } from 'react-router-dom';
import { installDomStubs, stubViewport } from './settingsTestUtils';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  logout: vi.fn(),
  patch: vi.fn(),
  get: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/components/layout/ShellV4', () => ({
  ShellV4: () => <Outlet />,
  outletLayoutFor: () => 'bleed',
}));
vi.mock('@/lib/api', () => ({
  api: { get: mocks.get, patch: mocks.patch, post: vi.fn(), delete: vi.fn(), getToken: () => null },
}));
vi.mock('@/lib/push', () => ({
  isPushSupported: () => true,
  getPushStatus: vi.fn().mockResolvedValue({ supported: true, permission: 'default', subscribed: false, needsInstall: false }),
  listPushDevices: vi.fn().mockResolvedValue([]),
  removePushDevice: vi.fn(),
  sendTestPush: vi.fn(),
}));
vi.mock('@/hooks/useInstallPrompt', () => ({
  useInstallPrompt: () => ({ isStandalone: false, canInstall: false, isIos: false, install: vi.fn() }),
}));

import App from '@/App';

// The first test pays the cold dynamic-import cost of the lazy settings chunks.
configure({ asyncUtilTimeout: 10000 });

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  installDomStubs();
  stubViewport(true);
  mocks.patch.mockResolvedValue({ success: true });
  mocks.useAuth.mockReturnValue({
    isAuthenticated: true,
    loading: false,
    user: { id: 'u1', email: 'ada@averrow.com', name: 'Ada', role: 'admin', passkey_count: 2, organization: null },
    refreshUser: vi.fn(),
    logout: mocks.logout,
  });
});

describe('settings routes', () => {
  it('redirects legacy /profile to /settings/profile', async () => {
    renderAt('/profile');
    expect(await screen.findByLabelText('Display name')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/profile');
  });

  it('desktop: /settings redirects to Profile and shows the rail', async () => {
    renderAt('/settings');
    expect(await screen.findByLabelText('Display name')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/profile');
    const rail = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(rail).toHaveTextContent('Profile');
    expect(rail).toHaveTextContent('Security');
    expect(rail).toHaveTextContent('Notifications');
    expect(rail).toHaveTextContent('Devices & App');
    expect(screen.getByRole('link', { name: /Profile/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Security/ })).toHaveAttribute('href', '/settings/security');
    expect(screen.getByRole('link', { name: /Notifications/ })).toHaveAttribute('href', '/settings/notifications');
  });

  it('desktop: rail navigates to Devices & App', async () => {
    const user = userEvent.setup();
    renderAt('/settings/profile');
    await screen.findByLabelText('Display name');
    await user.click(screen.getByRole('link', { name: /Devices & App/ }));
    expect(await screen.findByText('Push devices')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/devices');
  });

  it('mobile: /settings stays put and shows the section list with the compact hero', async () => {
    stubViewport(false);
    renderAt('/settings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/settings$/);
    expect(screen.getByRole('link', { name: /Profile/ })).toHaveAttribute('href', '/settings/profile');
    expect(screen.getByRole('link', { name: /Devices & App/ })).toHaveAttribute('href', '/settings/devices');
    expect(screen.getByText('ada@averrow.com')).toBeInTheDocument();
    expect(screen.getByText('2 passkeys · Active sessions')).toBeInTheDocument();
  });

  it('mobile: Sign out on the home list signs out', async () => {
    stubViewport(false);
    const user = userEvent.setup();
    renderAt('/settings');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(mocks.logout).toHaveBeenCalled();
  });

  it('guards leaving Profile with unsaved edits', async () => {
    const user = userEvent.setup();
    renderAt('/settings/profile');
    const input = await screen.findByLabelText('Display name');
    await user.type(input, ' II');
    await user.click(screen.getByRole('link', { name: /Devices & App/ }));

    await screen.findByRole('dialog', { name: 'Discard changes?' });
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/profile');
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/profile');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('link', { name: /Devices & App/, hidden: true }));
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByText('Push devices')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/devices');
  });

  it('/settings/security renders inside the shell with Security active', async () => {
    mocks.get.mockResolvedValue({ success: false, error: 'offline' });
    renderAt('/settings/security');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Security/ })).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/security');
  });

  it('legacy /notifications/preferences and /settings/notifications land on the Channels tab', async () => {
    mocks.get.mockResolvedValue({ success: false, error: 'offline' });
    const { unmount } = renderAt('/notifications/preferences');
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/settings/notifications/channels'));
    expect(screen.getByRole('link', { name: /Notifications/ })).toHaveAttribute('aria-current', 'page');
    unmount();

    renderAt('/settings/notifications');
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/settings/notifications/channels'));
  });

  it('redirects an unknown notifications sub-tab to Channels', async () => {
    mocks.get.mockResolvedValue({ success: false, error: 'offline' });
    renderAt('/settings/notifications/bogus');
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/settings/notifications/channels'));
  });

  it('guards switching notification sub-tabs while quiet hours has unsaved edits', async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/notifications/preferences/v2')) {
        return Promise.resolve({ success: true, data: {
          inapp_severity_floor: 'info', push_severity_floor: 'low', email_severity_floor: 'high',
          digest_mode: 'daily', digest_severity_floor: 'medium',
          quiet_hours_start: '22:00', quiet_hours_end: '07:00', quiet_hours_timezone: 'UTC',
          critical_bypasses_quiet: 1, show_tenant_notifications: 0,
          cadence_intel: 'realtime', cadence_platform: 'realtime',
        } });
      }
      if (url.startsWith('/api/notifications/preferences')) return Promise.resolve({ success: true, data: {} });
      return Promise.resolve({ success: true, data: [] });
    });
    const user = userEvent.setup();
    renderAt('/settings/notifications/quiet-hours');
    const from = await screen.findByLabelText('From');
    fireEvent.change(from, { target: { value: '21:00' } });
    await user.click(screen.getByRole('tab', { name: 'Events' }));

    await screen.findByRole('dialog', { name: 'Discard changes?' });
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/notifications/quiet-hours');
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/settings/notifications/events'));
  });
});
