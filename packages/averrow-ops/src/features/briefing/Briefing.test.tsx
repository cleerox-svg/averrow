import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { Briefing, briefingFreshness } from './Briefing';
import { sourceChips } from './IntelligenceBody';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
import { api } from '@/lib/api';

const authMock = vi.hoisted(() => ({ role: 'admin' as string }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', role: authMock.role } }) }));

const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function insight(over: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    type: 'insight',
    summary: '**Phishing surge** — 40 new domains hit Acme overnight, mostly on two hosting ranges.',
    severity: 'high',
    created_at: iso(30 * 60_000),
    details: null,
    related_brand_ids: '["brand_acme"]',
    related_campaign_id: 'camp_9',
    related_provider_ids: '["prov_1","prov_2"]',
    ...over,
  };
}

describe('Briefing shell — intelligence source', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the latest Observer insight with title, body, severity, freshness and a View all link', async () => {
    get.mockResolvedValue({ success: true, data: [insight()] });
    renderWithProviders(<Briefing source="intelligence" />);

    expect(await screen.findByRole('heading', { name: 'Phishing surge' })).toBeInTheDocument();
    expect(screen.getByText(/40 new domains hit Acme overnight/)).toBeInTheDocument();
    expect(screen.getByText('FRESH')).toBeInTheDocument();
    expect(screen.getByText('Observer')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Daily briefing' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View all briefings/ })).toHaveAttribute('href', '/coverage?tab=trends');
    expect(get).toHaveBeenCalledWith('/api/trends/intelligence?limit=1');
  });

  it('renders entity source chips that link to the brand, providers and campaign', async () => {
    get.mockResolvedValue({ success: true, data: [insight()] });
    renderWithProviders(<Briefing source="intelligence" />);

    const sources = await screen.findByLabelText('Sources');
    const links = within(sources).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Brand', '/brands/brand_acme'],
      ['Provider 1', '/explore?tab=providers&focus=prov_1'],
      ['Provider 2', '/explore?tab=providers&focus=prov_2'],
      ['Campaign', '/campaigns/camp_9'],
    ]);
  });

  it('shows no sources block when the insight links to nothing', async () => {
    get.mockResolvedValue({ success: true, data: [insight({ related_brand_ids: null, related_campaign_id: null, related_provider_ids: null })] });
    renderWithProviders(<Briefing source="intelligence" />);
    await screen.findByRole('heading', { name: 'Phishing surge' });
    expect(screen.queryByLabelText('Sources')).not.toBeInTheDocument();
  });

  it('drops the old wrong eyebrow and the dead Refresh button', async () => {
    get.mockResolvedValue({ success: true, data: [insight()] });
    renderWithProviders(<Briefing source="intelligence" />);
    await screen.findByRole('heading', { name: 'Phishing surge' });
    expect(screen.queryByText(/PLATFORM OPERATIONS BRIEFING/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();
  });

  it('collapses a long body behind a native disclosure', async () => {
    const long = `**T** — ${'word '.repeat(200)}`;
    get.mockResolvedValue({ success: true, data: [insight({ summary: long })] });
    renderWithProviders(<Briefing source="intelligence" />);
    expect(await screen.findByText('Read full briefing')).toBeInTheDocument();
  });

  it('shows the loading state, not an empty one, while fetching', () => {
    get.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Briefing source="intelligence" />);
    expect(screen.getByText('Loading the daily briefing…')).toBeInTheDocument();
    expect(screen.queryByText('No briefing generated yet')).not.toBeInTheDocument();
  });

  it('shows the empty state only when the request succeeded with no briefings', async () => {
    get.mockResolvedValue({ success: true, data: [] });
    renderWithProviders(<Briefing source="intelligence" />);
    expect(await screen.findByText('No briefing generated yet')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
  });

  it('a rejected request is an error with retry, never "no briefing"', async () => {
    get.mockRejectedValueOnce(new Error('HTTP 500'));
    renderWithProviders(<Briefing source="intelligence" />);
    expect(await screen.findByText("Couldn't load the daily briefing")).toBeInTheDocument();
    expect(screen.queryByText('No briefing generated yet')).not.toBeInTheDocument();

    get.mockResolvedValueOnce({ success: true, data: [insight()] });
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('heading', { name: 'Phishing surge' })).toBeInTheDocument();
  });

  it('a { success:false } envelope is an error too', async () => {
    get.mockResolvedValue({ success: false, error: 'internal' });
    renderWithProviders(<Briefing source="intelligence" />);
    expect(await screen.findByText("Couldn't load the daily briefing")).toBeInTheDocument();
  });

  it('marks the shell with its source', async () => {
    get.mockResolvedValue({ success: true, data: [insight()] });
    const { container } = renderWithProviders(<Briefing source="intelligence" />);
    await screen.findByRole('heading', { name: 'Phishing surge' });
    expect(container.querySelector('[data-briefing-source="intelligence"]')).not.toBeNull();
  });
});

describe('sourceChips', () => {
  it('caps each kind at three chips and counts the overflow', () => {
    const { chips, more } = sourceChips({
      related_brand_ids: JSON.stringify(['a', 'b', 'c', 'd', 'e']),
      related_provider_ids: null,
      related_campaign_id: null,
    });
    expect(chips.map((c) => c.label)).toEqual(['Brand 1', 'Brand 2', 'Brand 3']);
    expect(more).toBe(2);
  });
  it('encodes ids in the link', () => {
    const { chips } = sourceChips({ related_brand_ids: '["a b/c"]', related_provider_ids: null, related_campaign_id: null });
    expect(chips[0]?.to).toBe('/brands/a%20b%2Fc');
  });
});

describe('briefingFreshness', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  it('FRESH under an hour, TODAY under a day, STALE after', () => {
    expect(briefingFreshness('2026-10-03T11:30:00Z', now)?.label).toBe('FRESH');
    expect(briefingFreshness('2026-10-03T03:00:00Z', now)?.label).toBe('TODAY');
    expect(briefingFreshness('2026-10-01T12:00:00Z', now)?.label).toBe('STALE');
  });
  it('reads D1 bare timestamps as UTC', () => {
    expect(briefingFreshness('2026-10-03 11:30:00', now)?.label).toBe('FRESH');
  });
  it('is null for missing or invalid dates', () => {
    expect(briefingFreshness(null, now)).toBeNull();
    expect(briefingFreshness('nope', now)).toBeNull();
  });
});

// ── Ops source ──────────────────────────────────────────────────────────

function opsBriefing(over: Record<string, unknown> = {}) {
  return {
    platformOverview: {
      totalThreats: 1000, last24h: 10, last12h: 5, avgPerHour: 1,
      brandsMonitored: 5, brandsClassified: 5, todayCount: 10, yesterdayCount: 8,
    },
    newCapabilities: {
      typosquat_total: 111, typosquat_new: 7, social_total: 222, social_new: 3, certstream: 55,
      appstore_total: 333, appstore_new: 4, darkweb_total: 444, darkweb_new: 5,
    },
    geopoliticalCampaigns: [{
      name: 'Operation Glasswing', status: 'active', conflict: 'Test conflict', start_date: '2026-09-01',
      briefing_priority: 'high', total_threats: 321, new_24h: 17, brands_hit: 9, threat_actors: 'GW', notes: null,
    }],
    marketingVisibility: {
      windowHours: 24, humanViews: 1234, aiCrawlerViews: 56, otherBotViews: 78, aiReferralSessions: 9,
      ctaClicks: 12, contactSubs: 3,
      topPages: [{ page: '/pricing', views: 400 }],
      aiCrawlerBreakdown: [{ crawler_name: 'GPTBot', hits: 40 }],
      aiReferralBySource: [{ ai_source: 'chatgpt.com', sessions: 6 }],
    },
    statusBadge: 'OPERATIONAL',
    generatedAt: new Date().toISOString(),
    ...over,
  };
}

function mockOpsRow(briefing: unknown, trigger = 'cron:daily') {
  get.mockResolvedValue({
    success: true,
    data: {
      id: 1, type: 'daily', report_date: '2026-10-03',
      report_data: typeof briefing === 'string' ? briefing : JSON.stringify(briefing),
      generated_at: iso(2 * 60 * 60_000), trigger, emailed: 1,
    },
  });
}

describe('Briefing shell — ops source', () => {
  beforeEach(() => { vi.clearAllMocks(); authMock.role = 'admin'; });

  it('renders the ops briefing in the shared shell, tagged with its source', async () => {
    mockOpsRow(opsBriefing());
    const { container } = renderWithProviders(<Briefing source="ops" />);
    expect(await screen.findByText('TODAY')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Platform operations briefing' })).toBeInTheDocument();
    expect(container.querySelector('[data-briefing-source="ops"]')).not.toBeNull();
    expect(screen.getByText(/scheduled/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/briefings/latest');
    // Not the intelligence endpoint.
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining('/api/trends/intelligence'));
  });

  it('renders geopoliticalCampaigns', async () => {
    mockOpsRow(opsBriefing());
    renderWithProviders(<Briefing source="ops" />);
    expect(await screen.findByText('Geopolitical Campaigns')).toBeInTheDocument();
    expect(screen.getByText('Operation Glasswing')).toBeInTheDocument();
    expect(screen.getByText('321')).toBeInTheDocument();
  });

  it('renders marketingVisibility including its breakdown tables', async () => {
    mockOpsRow(opsBriefing());
    renderWithProviders(<Briefing source="ops" />);
    expect(await screen.findByText(/Marketing Visibility \(24h\)/)).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('/pricing')).toBeInTheDocument();
    expect(screen.getByText('GPTBot')).toBeInTheDocument();
    expect(screen.getByText('chatgpt.com')).toBeInTheDocument();
  });

  it('renders the new-capability counts, including app stores and dark web', async () => {
    mockOpsRow(opsBriefing());
    renderWithProviders(<Briefing source="ops" />);
    const heading = await screen.findByText('New Capabilities');
    const card = heading.closest('div')!.parentElement!;
    for (const name of ['Typosquat', 'Social', 'App stores', 'Dark web']) {
      expect(within(card).getByText(name)).toBeInTheDocument();
    }
    expect(within(card).getByText('333')).toBeInTheDocument();
    expect(within(card).getByText('444')).toBeInTheDocument();
  });

  it('tolerates a stale stored briefing that predates the newer sections', async () => {
    mockOpsRow({
      platformOverview: opsBriefing().platformOverview,
      statusBadge: 'OPERATIONAL',
      generatedAt: new Date().toISOString(),
    });
    renderWithProviders(<Briefing source="ops" />);
    expect(await screen.findByText('Day over Day')).toBeInTheDocument();
    expect(screen.queryByText('Geopolitical Campaigns')).not.toBeInTheDocument();
    expect(screen.queryByText(/Marketing Visibility/)).not.toBeInTheDocument();
  });

  it('shows DEGRADED status from the payload', async () => {
    mockOpsRow(opsBriefing({ statusBadge: 'DEGRADED' }));
    renderWithProviders(<Briefing source="ops" />);
    expect(await screen.findByText('DEGRADED')).toBeInTheDocument();
  });

  it('is an error with retry when the request fails, never the empty state', async () => {
    get.mockRejectedValueOnce(new Error('HTTP 500'));
    renderWithProviders(<Briefing source="ops" />);
    expect(await screen.findByText("Couldn't load the briefing")).toBeInTheDocument();
    expect(screen.queryByText('No briefing generated yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run briefing now/i })).not.toBeInTheDocument();

    mockOpsRow(opsBriefing());
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('heading', { name: 'Platform operations briefing' })).toBeInTheDocument();
  });

  it('an unparseable stored payload is an error, not an empty briefing', async () => {
    mockOpsRow('{not json');
    renderWithProviders(<Briefing source="ops" />);
    expect(await screen.findByText("Couldn't load the briefing")).toBeInTheDocument();
  });

  it('shows the empty state with Run Briefing Now when none has been generated', async () => {
    get.mockResolvedValue({ success: true, data: null });
    renderWithProviders(<Briefing source="ops" />);
    expect(await screen.findByText('No briefing generated yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run briefing now/i })).toBeInTheDocument();
  });

  it('shows the loading state while fetching', () => {
    get.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Briefing source="ops" />);
    expect(screen.getByText('Loading briefing…')).toBeInTheDocument();
  });

  it('Run Briefing Now posts, announces success, and refetches the briefing', async () => {
    mockOpsRow(opsBriefing());
    post.mockResolvedValue({ success: true, data: {} });
    renderWithProviders(<Briefing source="ops" />);
    await userEvent.click(await screen.findByRole('button', { name: /run briefing now/i }));
    expect(post).toHaveBeenCalledWith('/api/briefings/generate');
    expect(await screen.findByRole('status')).toHaveTextContent(/Briefing generated/);
    await waitFor(() => expect(get.mock.calls.filter((c) => c[0] === '/api/briefings/latest').length).toBeGreaterThan(1));
  });

  it('Run Briefing Now announces a failure assertively', async () => {
    mockOpsRow(opsBriefing());
    post.mockResolvedValue({ success: false, error: 'Generation exploded' });
    renderWithProviders(<Briefing source="ops" />);
    await userEvent.click(await screen.findByRole('button', { name: /run briefing now/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Generation exploded');
  });
});

describe('Briefing shell — ops source, Run Briefing Now role gating', () => {
  beforeEach(() => { vi.clearAllMocks(); authMock.role = 'admin'; });

  it.each(['admin', 'super_admin'])('%s sees the button and it posts', async (role) => {
    authMock.role = role;
    mockOpsRow(opsBriefing());
    post.mockResolvedValue({ success: true, data: {} });
    renderWithProviders(<Briefing source="ops" />);
    await userEvent.click(await screen.findByRole('button', { name: /run briefing now/i }));
    expect(post).toHaveBeenCalledWith('/api/briefings/generate');
  });

  it.each(['analyst', 'support', 'sales', 'billing', 'auditor'])('%s sees a read-only briefing with no button', async (role) => {
    authMock.role = role;
    mockOpsRow(opsBriefing());
    renderWithProviders(<Briefing source="ops" />);
    expect(await screen.findByText('TODAY')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run briefing now/i })).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['analyst', 'support', 'sales', 'billing', 'auditor'])('%s empty state explains the schedule instead of a dead CTA', async (role) => {
    authMock.role = role;
    get.mockResolvedValue({ success: true, data: null });
    renderWithProviders(<Briefing source="ops" />);
    expect(await screen.findByText('No briefing generated yet.')).toBeInTheDocument();
    expect(screen.getByText(/runs automatically at 13:13 UTC/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run briefing now/i })).not.toBeInTheDocument();
  });
});
