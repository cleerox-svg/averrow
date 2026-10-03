// Home layout and queue behaviour as super_admin (every source enabled).
// Per-role request gating lives in OverviewV4.roles.test.tsx.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';
import { createHomeApi, type HomeApiOptions } from '@/test/homeApi';
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

function setup(opts: HomeApiOptions = {}, role = 'super_admin') {
  const fake = createHomeApi(opts);
  get.mockImplementation(fake.handler);
  auth.mockReturnValue({ user: { name: 'Ada Lovelace', role }, isSuperAdmin: role === 'super_admin' });
  renderWithProviders(<OverviewV4 />);
  return fake;
}

const queue = () => screen.getByRole('region', { name: 'Needs you now' });

describe('OverviewV4 layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.pushState({}, '', '/');
    stubMatchMedia(true);
  });

  it('renders the hero, tempo band, queue, briefing, platform pulse and digest, and none of the old sections', async () => {
    setup({ alerts: { new_count: 4, critical_count: 0 } });

    expect(await screen.findByText('COMMAND CENTER')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /Ada/ })).toBeInTheDocument();
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument(); // the top bar owns LIVE
    expect(await screen.findByText(/Threat tempo/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Needs you now' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Daily briefing' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Platform pulse' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Everything else' })).toBeInTheDocument();

    // Removed: KPI hero tiles, StatGrid, ModuleHub, Live activity, etc.
    expect(screen.queryByText('Open alerts')).not.toBeInTheDocument();
    expect(screen.queryByText('Critical incidents')).not.toBeInTheDocument();
    expect(screen.queryByText(/PLATFORM OPERATIONS BRIEFING/i)).not.toBeInTheDocument();
  });

  it('the digest links to the canonical tab URLs', async () => {
    setup();
    const nav = await screen.findByRole('navigation', { name: 'Everything else' });
    const hrefs = within(nav).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);
    expect(hrefs).toEqual([
      ['Brand movers', '/explore?tab=brands'],
      ['All briefings', '/coverage?tab=trends'],
      ['Threats', '/console?tab=threats'],
      ['Observatory', '/observatory'],
    ]);
  });

  it('platform pulse has a visible heading and no hardcoded AI-mode note', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: 'Platform pulse' })).toBeInTheDocument();
    expect(screen.queryByText(/AI: rules mode/)).not.toBeInTheDocument();
  });

  it('the digest makes no requests of its own (brand movers is read from cache only)', async () => {
    const fake = setup();
    await screen.findByRole('navigation', { name: 'Everything else' });
    await waitFor(() => expect(fake.requests).toContain('/api/threats/inflow?window=7d'));
    expect(fake.requests.some((u) => u.includes('/api/brands/movers'))).toBe(false);
  });
});

describe('OverviewV4 queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.pushState({}, '', '/');
    stubMatchMedia(true);
  });

  it('ranks items, shows the top 5 with "N of M open", and each row has one action', async () => {
    setup({
      alerts: { new_count: 30, critical_count: 4 },
      incidents: [{ severity: 'critical', created_at: new Date().toISOString() }],
      pending: [{ agent_id: 'a', requested_at: new Date().toISOString() }],
      statusCounts: [{ status: 'draft', count: 2 }],
      agents: [{ agent_id: 'x', display_name: 'Xagent', circuit_state: 'tripped', error_count_24h: 0, paused_at: null, last_run_at: new Date().toISOString() }],
      atRisk: [{ feed_name: 'f', display_name: 'Feed F', severity: 'high' }],
      unattributed: 12,
      candidates: 3,
    });

    // Eight sources produced an item; Home shows the top five.
    expect(await screen.findByText('5 of 8 open')).toBeInTheDocument();
    expect(await screen.findByText('8 items need you')).toBeInTheDocument();
    const q = screen.getByRole('list', { name: 'Ranked items needing attention' });
    expect(within(q).getAllByRole('listitem')).toHaveLength(5);

    const rows = within(q).getAllByRole('listitem');
    // Critical alerts / critical incident rank above the low-severity backlog items.
    expect(rows[0]).toHaveTextContent(/alerts awaiting triage|open incident/);
    expect(within(q).queryByText(/awaiting attribution/)).not.toBeInTheDocument();
    for (const row of rows) expect(within(row).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Triage: 30 alerts awaiting triage/ })).toBeInTheDocument();
  });

  it('an action navigates to the canonical tab URL', async () => {
    setup({ alerts: { new_count: 3, critical_count: 0 } });
    const btn = await screen.findByRole('button', { name: /Triage: 3 alerts awaiting triage/ });
    await userEvent.click(btn);
    expect(window.location.pathname + window.location.search).toBe('/console?tab=alerts');
  });

  it('shows the clear state only when every enabled source succeeded and found nothing', async () => {
    setup();
    expect(await screen.findByText('Nothing needs you right now')).toBeInTheDocument();
    expect(screen.getByText('0 items need you')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't check/)).not.toBeInTheDocument();
  });

  it.each([
    ['alerts', '/api/alerts/triage-summary', 'alerts'],
    ['critical intelligence', '/api/intel/critical-banner', 'critical intelligence'],
    ['incidents', '/api/admin/incidents', 'incidents'],
    ['agent approvals', '/api/admin/agents/approvals/pending', 'agent approvals'],
    ['takedowns', '/api/admin/takedowns', 'takedowns'],
    ['agents', '/api/agents', 'agents'],
    ['feeds', '/api/admin/dashboard', 'feeds'],
    ['the attribution backlog', '/api/admin/agents/attribution-backlog', 'the attribution backlog'],
    ['brand candidates', '/api/admin/brand-candidates', 'brand candidates'],
  ])('a rejected %s source shows "Couldn\'t check", with retry, and never the clear state', async (_n, url, label) => {
    const fake = setup({ fail: { [url]: 'reject' } });
    expect(await screen.findByText(`Couldn't check ${label}`)).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs you right now')).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't be checked/)).toBeInTheDocument();

    // Retry re-requests exactly that source.
    const before = fake.requests.filter((u) => u.startsWith(url)).length;
    await userEvent.click(within(queue()).getByRole('button', { name: `Retry ${label}` }));
    await waitFor(() => expect(fake.requests.filter((u) => u.startsWith(url)).length).toBeGreaterThan(before));
  });

  it('a { success:false } envelope counts as a failure, not a zero', async () => {
    setup({ fail: { '/api/agents': 'envelope', '/api/admin/dashboard': 'envelope' } });
    expect(await screen.findByText("Couldn't check agents")).toBeInTheDocument();
    expect(await screen.findByText("Couldn't check feeds")).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs you right now')).not.toBeInTheDocument();
  });

  it('healthy sources still show their items beside a failed one', async () => {
    setup({ alerts: { new_count: 8, critical_count: 0 }, fail: { '/api/agents': 'reject' } });
    expect(await screen.findByText('8 alerts awaiting triage')).toBeInTheDocument();
    expect(await screen.findByText("Couldn't check agents")).toBeInTheDocument();
    const sub = document.querySelector('.home-hero-sub')!;
    expect(sub).toHaveTextContent("1 item needs you, and 1 source couldn't be checked");
    expect(sub.querySelector('strong')).toHaveTextContent('1 item needs you');
  });

  it('a recovered retry removes the failure row', async () => {
    const fake = createHomeApi({ fail: { '/api/agents': 'reject' } });
    get.mockImplementation(fake.handler);
    auth.mockReturnValue({ user: { name: 'Ada', role: 'super_admin' }, isSuperAdmin: true });
    renderWithProviders(<OverviewV4 />);
    await screen.findByText("Couldn't check agents");

    const healthy = createHomeApi();
    get.mockImplementation(healthy.handler);
    await userEvent.click(screen.getByRole('button', { name: 'Retry agents' }));
    await waitFor(() => expect(screen.queryByText("Couldn't check agents")).not.toBeInTheDocument());
    expect(await screen.findByText('Nothing needs you right now')).toBeInTheDocument();
  });
});
