// Role gating prevents REQUESTS, not just UI: a role that may not call an
// endpoint must never fire it. Renders the real Home for every global role
// against a recording fake API and asserts on the request log.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { stubMatchMedia } from '@/test/shared-ui/helpers';
import { createHomeApi } from '@/test/homeApi';
import { OverviewV4 } from './OverviewV4';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));
vi.mock('@/hooks/useInstallPrompt', () => ({
  useInstallPrompt: () => ({ isStandalone: true, canInstall: false, isIos: false, install: vi.fn() }),
}));

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

const get = api.get as unknown as ReturnType<typeof vi.fn>;
const auth = useAuth as unknown as ReturnType<typeof vi.fn>;

// Endpoint prefix -> roles allowed to call it (mirrors the worker route guards).
const STAFF = ['super_admin', 'admin', 'analyst', 'sales', 'support', 'billing', 'auditor'];
const ALLOWED: Record<string, string[]> = {
  '/api/alerts/triage-summary': STAFF,
  '/api/intel/critical-banner': STAFF,
  '/api/agents': STAFF,
  '/api/admin/incidents': ['super_admin'],
  '/api/admin/agents/approvals/pending': ['super_admin'],
  '/api/admin/takedowns': ['super_admin', 'admin', 'analyst'], // manage_takedowns
  '/api/admin/dashboard': ['super_admin', 'admin'],
  '/api/admin/agents/attribution-backlog': ['super_admin', 'admin'],
  '/api/admin/brand-candidates': ['super_admin', 'admin'],
};

async function renderAs(role: string) {
  const fake = createHomeApi();
  get.mockImplementation(fake.handler);
  auth.mockReturnValue({ user: { name: 'Test User', role }, isSuperAdmin: role === 'super_admin' });
  renderWithProviders(<OverviewV4 />);
  // The queue settles to its clear state once every enabled source answered.
  await screen.findByText('Nothing needs you right now');
  // Let any further (forbidden) request that was going to fire, fire.
  await waitFor(() => expect(fake.requests).toContain('/api/threats/inflow?window=7d'));
  return fake.requests;
}

describe('Home role gating: no forbidden requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.pushState({}, '', '/');
    stubMatchMedia(true);
  });

  it.each(STAFF)('%s requests exactly the sources its role allows', async (role) => {
    const requests = await renderAs(role);

    for (const [prefix, roles] of Object.entries(ALLOWED)) {
      const called = requests.some((u) => u === prefix || u.startsWith(`${prefix}?`) || u.startsWith(`${prefix}/`));
      expect(called, `${role} ${roles.includes(role) ? 'should call' : 'must NOT call'} ${prefix}`).toBe(roles.includes(role));
    }
  });

  it.each(['analyst', 'sales', 'support', 'billing', 'auditor'])('%s never touches /api/admin/incidents or the approvals endpoint', async (role) => {
    const requests = await renderAs(role);
    expect(requests.filter((u) => u.startsWith('/api/admin/incidents'))).toEqual([]);
    expect(requests.filter((u) => u.includes('/approvals'))).toEqual([]);
  });

  it.each(['sales', 'support', 'billing', 'auditor'])('%s (no manage_takedowns) never touches /api/admin/takedowns', async (role) => {
    const requests = await renderAs(role);
    expect(requests.filter((u) => u.startsWith('/api/admin/takedowns'))).toEqual([]);
  });

  it.each(['analyst', 'sales', 'support', 'billing', 'auditor'])('%s makes no /api/admin/* request at all except takedowns for analyst', async (role) => {
    const requests = await renderAs(role);
    const admin = requests.filter((u) => u.startsWith('/api/admin/'));
    expect(admin.every((u) => role === 'analyst' && u.startsWith('/api/admin/takedowns'))).toBe(true);
  });

  it('admin never calls the super_admin-only endpoints', async () => {
    const requests = await renderAs('admin');
    expect(requests.filter((u) => u.startsWith('/api/admin/incidents') || u.includes('/approvals'))).toEqual([]);
  });

  it('a gated role is shown a clear queue, not a failure, for sources it was never allowed to ask', async () => {
    await renderAs('support');
    expect(screen.queryByText(/Couldn't check/)).not.toBeInTheDocument();
  });

  it.each(['client', ''])('role %j requests no queue source at all', async (role) => {
    const fake = createHomeApi();
    get.mockImplementation(fake.handler);
    auth.mockReturnValue({ user: { name: 'X', role }, isSuperAdmin: false });
    renderWithProviders(<OverviewV4 />);
    expect(await screen.findByText('No queue for your role')).toBeInTheDocument();
    await waitFor(() => expect(fake.requests).toContain('/api/threats/inflow?window=7d'));
    for (const prefix of Object.keys(ALLOWED)) {
      expect(fake.requests.some((u) => u.startsWith(prefix))).toBe(false);
    }
  });
});

describe('Home takedowns polling', () => {
  it('polls the uncached takedown counts every 2 minutes, not the 30s default', async () => {
    stubMatchMedia(true);
    const fake = createHomeApi();
    get.mockImplementation(fake.handler);
    auth.mockReturnValue({ user: { name: 'T', role: 'admin' }, isSuperAdmin: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><OverviewV4 /></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(fake.requests.some((u) => u.startsWith('/api/admin/takedowns'))).toBe(true));
    const q = client.getQueryCache().findAll({ queryKey: ['admin-takedowns'] })[0]!;
    expect(q.observers[0]!.options.refetchInterval).toBe(120_000);
  });
});
