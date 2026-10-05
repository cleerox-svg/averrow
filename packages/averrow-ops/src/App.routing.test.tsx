// Routing coverage for PR #1739 (v4 is the only ops shell).
//
// "/" must render OverviewV4 inside ShellV4 for EVERY staff user — including a
// non-super-admin staff user with an organization attached, who used to be
// routed to the (now deleted) BrandAdminDashboard. The real <App/> route table
// is rendered; only auth, the network, and unrelated chrome are stubbed.
// OverviewV4 renders for real against a stubbed API (every GET resolves an
// empty list) — the hero is what we assert on.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import App from './App';

const mocks = vi.hoisted(() => ({ useAuth: vi.fn() }));

vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ success: true, data: [] }) },
}));
vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/hooks/useOpenAlertCount', () => ({
  useOpenAlertCount: () => ({ isSuccess: false, isError: false, data: undefined }),
}));
vi.mock('@/components/layout/ThemeCycleButton', () => ({ ThemeCycleButton: () => null }));
vi.mock('@/components/PlatformAlertBanner', () => ({ PlatformAlertBanner: () => null }));
vi.mock('@/components/InstallAppBanner', () => ({ InstallAppBanner: () => null }));

function mockUser(overrides: Record<string, unknown>, isSuperAdmin: boolean) {
  mocks.useAuth.mockReturnValue({
    user: {
      id: 'u1',
      email: 'staff@averrow.com',
      name: 'Ada Lovelace',
      display_name: 'Ada Lovelace',
      role: 'admin',
      organization: null,
      passkey_count: 1,
      ...overrides,
    },
    isAuthenticated: true,
    loading: false,
    isSuperAdmin,
    logout: vi.fn().mockResolvedValue(undefined),
    refreshUser: vi.fn().mockResolvedValue(undefined),
  });
}

function renderApp(path = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('App routing — "/" is OverviewV4 inside ShellV4 for every staff user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['super_admin', { role: 'super_admin' }, true],
    [
      'non-super-admin staff WITH an organization (formerly BrandAdminDashboard)',
      { role: 'admin', organization: { id: 'org1', name: 'Acme', slug: 'acme', plan: 'professional', role: 'owner' } },
      false,
    ],
  ];

  it.each(cases)('%s', async (_label, overrides, isSuperAdmin) => {
    mockUser(overrides, isSuperAdmin);
    const { container } = renderApp('/');

    // OverviewV4's hero (lazy chunk -> findBy*). The first test pays the cold
    // dynamic-import/transform cost of the whole Overview graph, which can
    // exceed findBy's 1s default on a loaded machine.
    expect(await screen.findByText('COMMAND CENTER', {}, { timeout: 10000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /Ada/ })).toBeInTheDocument();

    // ...rendered inside ShellV4's chrome: the Overview nav row + outlet wrapper
    const shell = container.querySelector('.shell-v4');
    expect(shell).not.toBeNull();
    expect(shell!.querySelector('.v4-outlet')).toContainElement(screen.getByText('COMMAND CENTER'));
    expect(screen.getByRole('link', { name: /Overview/ })).toHaveAttribute('href', '/');
  });
});
