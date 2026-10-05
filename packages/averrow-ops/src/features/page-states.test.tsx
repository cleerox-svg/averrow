/**
 * Error vs empty vs loading on five representative list pages (UI
 * consolidation PR6b). The pages run their REAL query hooks; only the
 * network edge (`api.get`) is mocked. Contract under test:
 *
 *   - a rejected list query renders role="alert" with a "Try again" button
 *     that refetches, and NEVER the page's empty / "up to date" copy;
 *   - an empty (successful) response renders the empty copy, no alert;
 *   - a pending query renders neither.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { ToastProvider } from '@/components/ui/Toast';
import { stubMatchMedia } from '@/test/shared-ui/helpers';

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 's@averrow.com', role: 'super_admin', name: 'S', organization: { id: 'org1' } },
    isSuperAdmin: true,
  }),
}));

import { api } from '@/lib/api';
import { Alerts } from '@/features/alerts/Alerts';
import { Agents } from '@/features/agents/Agents';
import { Feeds } from '@/features/feeds/Feeds';
import { Providers } from '@/features/providers/Providers';
import { Takedowns } from '@/features/takedowns/Takedowns';
import { Trends } from '@/features/trends/Trends';
import { NotificationSettingsPage } from '@/features/settings/NotificationSettingsPage';
import { ToastProvider as SharedToastProvider } from '@averrow/shared/ui';
import { AttributionBacklog } from '@/features/admin/AttributionBacklog';
import { AdminAudit } from '@/features/admin/AdminAudit';
import { NotificationCenter } from '@/features/admin/NotificationCenter';
import { SpamTrap } from '@/features/spam-trap/SpamTrap';
import { Leads } from '@/features/leads/Leads';
import { DarkWeb } from '@/features/dark-web/DarkWeb';

const get = api.get as ReturnType<typeof vi.fn>;

type Route = { match: string; result: 'reject' | 'pending' | unknown };

/** Route `api.get` by URL prefix; anything unlisted resolves to an empty envelope. */
function routeApi(routes: Route[]) {
  get.mockImplementation((url: string) => {
    const hit = routes.find((r) => url.startsWith(r.match));
    if (hit?.result === 'reject') return Promise.reject(new Error('boom'));
    if (hit?.result === 'pending') return new Promise(() => {});
    if (hit) return Promise.resolve(hit.result);
    return Promise.resolve({ success: true });
  });
}

const callsTo = (prefix: string) =>
  get.mock.calls.filter(([u]) => String(u).startsWith(prefix)).length;

/** The page-level error alert (the page may render other alerts, e.g. toasts). */
function errorAlert(title: RegExp) {
  return screen.queryAllByRole('alert').find((el) => title.test(el.textContent ?? ''));
}

/** The inline "Couldn't refresh" stale-data banner (polite role=status). */
function staleBanner(title: RegExp) {
  return screen.queryAllByRole('status').find((el) => title.test(el.textContent ?? ''));
}

async function expectErrorWithRetry(title: RegExp, listPrefix: string, emptyCopy: RegExp[]) {
  await waitFor(() => expect(errorAlert(title)).toBeTruthy());
  const alert = errorAlert(title)!;
  for (const copy of emptyCopy) expect(screen.queryByText(copy)).not.toBeInTheDocument();

  const before = callsTo(listPrefix);
  await userEvent.setup().click(within(alert).getByRole('button', { name: /^Try again/ }));
  await waitFor(() => expect(callsTo(listPrefix)).toBeGreaterThan(before));
}

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(true);
});

describe('Alerts', () => {
  const list = '/api/alerts?';
  const stats = '/api/alerts/stats';
  const emptyCopy = [/no open alerts/i, /up to date/i, /no alerts match/i];

  it('shows an error with retry (never empty / "up to date") when the list rejects', async () => {
    routeApi([{ match: list, result: 'reject' }, { match: stats, result: { success: true, data: { total: 0 } } }]);
    renderWithProviders(<Alerts />);
    await expectErrorWithRetry(/couldn't load alerts/i, list, emptyCopy);
  });

  it('shows the clear-queue copy for a genuinely empty, unfiltered list', async () => {
    routeApi([{ match: list, result: { success: true, data: [], total: 0 } }, { match: stats, result: { success: true, data: { total: 0 } } }]);
    renderWithProviders(<Alerts />);
    expect(await screen.findByText('No open alerts')).toBeInTheDocument();
    expect(screen.queryByText(/no alerts match your filters/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows neither error nor empty while loading', () => {
    routeApi([{ match: list, result: 'pending' }, { match: stats, result: 'pending' }]);
    renderWithProviders(<Alerts />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    for (const copy of emptyCopy) expect(screen.queryByText(copy)).not.toBeInTheDocument();
    expect(screen.getAllByRole('status').some((el) => el.getAttribute('aria-busy') === 'true')).toBe(true);
  });
});

describe('Agents', () => {
  const list = '/api/agents';
  const emptyCopy = [/no agents registered/i, /squadron offline/i];

  it('shows an error with retry (never "no agents") when the list rejects', async () => {
    routeApi([{ match: '/api/agents/runs', result: { success: true, data: [] } }, { match: list, result: 'reject' }]);
    renderWithProviders(<Agents />);
    await expectErrorWithRetry(/couldn't load agents/i, list, emptyCopy);
  });

  it('shows the empty copy (not the error look) for an empty registry', async () => {
    routeApi([{ match: list, result: { success: true, data: [] } }]);
    renderWithProviders(<Agents />);
    expect(await screen.findByText('No agents registered')).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
  });

  it('shows neither error nor empty while loading', () => {
    routeApi([{ match: list, result: 'pending' }]);
    renderWithProviders(<Agents />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    for (const copy of emptyCopy) expect(screen.queryByText(copy)).not.toBeInTheDocument();
  });
});

describe('Feeds', () => {
  const list = '/api/feeds/overview';
  const stats = '/api/feeds/aggregate-stats';
  const emptyCopy = [/no feeds configured/i, /no feeds match/i];

  it('shows an error with retry (never "no feeds") when the list rejects', async () => {
    routeApi([{ match: list, result: 'reject' }, { match: stats, result: { success: true, data: { active: 0, disabled: 0, total_ingested: 0 } } }]);
    renderWithProviders(<Feeds />);
    await expectErrorWithRetry(/couldn't load feeds/i, list, emptyCopy);
  });

  it('shows the empty copy for an empty feed list', async () => {
    routeApi([{ match: list, result: { success: true, data: [] } }, { match: stats, result: { success: true, data: { active: 0, disabled: 0, total_ingested: 0 } } }]);
    renderWithProviders(<Feeds />);
    expect(await screen.findByText('No feeds configured')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows neither error nor empty while loading', () => {
    routeApi([{ match: list, result: 'pending' }]);
    renderWithProviders(<Feeds />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    for (const copy of emptyCopy) expect(screen.queryByText(copy)).not.toBeInTheDocument();
  });
});

describe('Providers', () => {
  const list = '/api/providers/v2';
  const intel = '/api/providers/intelligence';
  const emptyCopy = [/no providers match/i];

  it('shows an error with retry (never "no providers match") when the list rejects', async () => {
    routeApi([
      { match: list, result: 'reject' },
      { match: intel, result: { success: true, data: { total_providers: 0, total_clusters: 0, active_operations: 0, accelerating: 0, pivots_detected: 0 } } },
      { match: '/api/providers/clusters', result: { success: true, data: [] } },
    ]);
    renderWithProviders(<Providers />);
    await expectErrorWithRetry(/couldn't load providers/i, list, emptyCopy);
  });

  it('shows the empty copy for an empty provider list', async () => {
    routeApi([{ match: list, result: { success: true, data: [] } }]);
    renderWithProviders(<Providers />);
    expect(await screen.findByText('No providers match')).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load providers/i)).not.toBeInTheDocument();
  });

  it('shows neither error nor empty while loading', () => {
    routeApi([{ match: list, result: 'pending' }, { match: intel, result: 'pending' }, { match: '/api/providers/clusters', result: 'pending' }]);
    renderWithProviders(<Providers />);
    expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
    for (const copy of emptyCopy) expect(screen.queryByText(copy)).not.toBeInTheDocument();
  });
});

describe('Takedowns', () => {
  const list = '/api/admin/takedowns';
  const emptyCopy = [/no takedown requests/i];

  it('shows an error with retry (never "no takedown requests") when the list rejects', async () => {
    routeApi([{ match: list, result: 'reject' }]);
    renderWithProviders(<Takedowns />);
    await expectErrorWithRetry(/couldn't load takedown requests/i, list, emptyCopy);
  });

  it('shows the empty copy for an empty queue', async () => {
    routeApi([{ match: list, result: { data: [], total: 0, status_counts: [], scope: 'authorized' } }]);
    renderWithProviders(<Takedowns />);
    expect(await screen.findByText('No takedown requests')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows neither error nor empty while loading', () => {
    routeApi([{ match: list, result: 'pending' }]);
    renderWithProviders(<Takedowns />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    for (const copy of emptyCopy) expect(screen.queryByText(copy)).not.toBeInTheDocument();
  });
});


// ─── Fix-batch coverage ─────────────────────────────────────────────

const tileFor = (label: string) => screen.getByText(label).closest('div,button') as HTMLElement;

describe('Trends (infinite refetch loop)', () => {
  const volume = '/api/trends/threat-volume';

  it('a rejected volume query renders an error alert and the request count stays bounded', async () => {
    routeApi([{ match: volume, result: 'reject' }]);
    renderWithProviders(<Trends />);
    await waitFor(() => expect(errorAlert(/couldn't load trends/i)).toBeTruthy());

    // Old behaviour: error fell through to content, whose ExecutiveSummary
    // remounted the same query, flipped it back to pending and swapped the
    // loader back in (~1 req/s forever). Wait well past a cycle and assert
    // the failing endpoint was hit exactly once.
    const settled = callsTo(volume);
    await new Promise((r) => setTimeout(r, 400));
    expect(callsTo(volume)).toBe(settled);
    expect(settled).toBe(1);
    expect(screen.queryByText('Intelligence Summary')).not.toBeInTheDocument();
  });

  it('Try again refetches once and recovers to the content', async () => {
    routeApi([{ match: volume, result: 'reject' }]);
    renderWithProviders(<Trends />);
    await waitFor(() => expect(errorAlert(/couldn't load trends/i)).toBeTruthy());

    routeApi([{ match: volume, result: { success: true, data: [] } }]);
    await userEvent.setup().click(within(errorAlert(/couldn't load trends/i)!).getByRole('button', { name: /^Try again/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Trends' })).toBeInTheDocument());
    // The recovered content mounts further observers of the same key, so the
    // count is >= 2 (initial + retry), not exactly 2.
    expect(callsTo(volume)).toBeGreaterThanOrEqual(2);
  });
});

describe('NotificationSettingsPage', () => {
  const v1 = '/api/notifications/preferences';
  const v2 = '/api/notifications/preferences/v2';
  const v2ok = { success: true, data: { digest_mode: 'daily' } };

  it('shows an error with retry and renders no toggles when prefs fail to load', async () => {
    routeApi([{ match: v2, result: v2ok }, { match: v1, result: 'reject' }]);
    renderWithProviders(<SharedToastProvider><NotificationSettingsPage /></SharedToastProvider>);
    await waitFor(() => expect(errorAlert(/couldn't load your notification preferences/i)).toBeTruthy());
    expect(screen.queryByRole('tab', { name: 'Channels' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();

    const before = callsTo(v1);
    await userEvent.setup().click(within(errorAlert(/couldn't load your notification/i)!).getByRole('button', { name: /^Try again/ }));
    await waitFor(() => expect(callsTo(v1)).toBeGreaterThan(before));
  });

  it('does not render the toggles while prefs are still loading', () => {
    routeApi([{ match: v2, result: 'pending' }, { match: v1, result: 'pending' }]);
    renderWithProviders(<SharedToastProvider><NotificationSettingsPage /></SharedToastProvider>);
    // The toast provider keeps empty live regions mounted; the loader is the busy one.
    expect(screen.getAllByRole('status').some((el) => el.getAttribute('aria-busy') === 'true')).toBe(true);
    expect(screen.queryByRole('tab', { name: 'Channels' })).not.toBeInTheDocument();
  });

  it('renders the sections once both preference sets have loaded', async () => {
    routeApi([{ match: v2, result: v2ok }, { match: v1, result: { success: true, data: {} } }]);
    renderWithProviders(<SharedToastProvider><NotificationSettingsPage /></SharedToastProvider>);
    expect(await screen.findByRole('tab', { name: 'Channels' })).toBeInTheDocument();
    expect(screen.queryAllByRole('alert').filter((el) => (el.textContent ?? '').trim())).toHaveLength(0);
  });
});

describe('AttributionBacklog', () => {
  const list = '/api/admin/agents/attribution-backlog';

  it('shows an error + "Couldn\'t load" tiles (never "keeping up" / 0) when the fetch fails', async () => {
    routeApi([{ match: list, result: 'reject' }]);
    renderWithProviders(<AttributionBacklog />);
    await waitFor(() => expect(errorAlert(/couldn't load the attribution backlog/i)).toBeTruthy());
    expect(screen.queryByText(/attributor is keeping up/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Couldn't load").length).toBe(5);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows the clear copy for a genuinely empty backlog', async () => {
    routeApi([{ match: list, result: { success: true, data: { items: [], totals: { total_clusters: 4, unattributed: 0, attempted_unknown: 0, never_attempted: 0, dismissed: 4 } } } }]);
    renderWithProviders(<AttributionBacklog />);
    expect(await screen.findByText('No unattributed clusters')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('AdminAudit', () => {
  const list = '/api/admin/audit';

  it('shows an error + "Couldn\'t load" tiles (never 0 / "no entries") when the fetch fails', async () => {
    routeApi([{ match: list, result: 'reject' }]);
    renderWithProviders(<AdminAudit />);
    await waitFor(() => expect(errorAlert(/couldn't load the audit log/i)).toBeTruthy());
    expect(screen.queryByText(/no audit entries/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Couldn't load").length).toBe(4);
  });

  it('shows "—" (aria-busy), not 0, while loading', () => {
    routeApi([{ match: list, result: 'pending' }]);
    renderWithProviders(<AdminAudit />);
    expect(tileFor('Total Events')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});

describe('NotificationCenter', () => {
  const stats = '/api/admin/notifications/stats';

  it('shows "Couldn\'t load" tiles, not 0, when stats fail', async () => {
    routeApi([{ match: stats, result: 'reject' }]);
    renderWithProviders(<NotificationCenter />);
    await waitFor(() => expect(screen.getAllByText("Couldn't load").length).toBe(4));
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows loading tiles (not 0) while pending', () => {
    routeApi([{ match: stats, result: 'pending' }]);
    renderWithProviders(<NotificationCenter />);
    expect(tileFor('Total fired')).toHaveAttribute('aria-busy', 'true');
  });
});

describe('SpamTrap', () => {
  it('shows "Couldn\'t load" (not 0/0/0/—/never) when its queries fail', async () => {
    routeApi([
      { match: '/api/spam-trap/stats', result: 'reject' },
      { match: '/api/spam-trap/addresses', result: 'reject' },
    ]);
    renderWithProviders(<SpamTrap />);
    await waitFor(() => expect(screen.getAllByText("Couldn't load").length).toBeGreaterThanOrEqual(5));
    expect(screen.queryByText('never')).not.toBeInTheDocument();
  });

  it('shows loading tiles (not 0 / never) while pending', () => {
    routeApi([{ match: '/api/spam-trap/', result: 'pending' }]);
    renderWithProviders(<SpamTrap />);
    expect(tileFor('SEEDS DEPLOYED')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('never')).not.toBeInTheDocument();
  });
});

describe('Leads pipeline tiles', () => {
  it('render "Couldn\'t load" tiles (instead of vanishing) when stats fail', async () => {
    routeApi([
      { match: '/api/admin/sales-leads/stats', result: 'reject' },
      { match: '/api/admin/sales-leads?', result: { success: true, data: { leads: [], total: 0, stats: {} } } },
    ]);
    renderWithProviders(<Leads />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sales Pipeline' }));
    await waitFor(() => expect(screen.getAllByText("Couldn't load").length).toBeGreaterThanOrEqual(1));
  });
});

describe('Providers: stale data and failed keepPreviousData filters', () => {
  const list = '/api/providers/v2';
  const ok = { success: true, data: [] };

  function renderWithClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <Providers />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    return client;
  }

  it('a failed refetch with data on screen keeps it, shows the inline error AND the list state', async () => {
    routeApi([{ match: list, result: ok }]);
    const client = renderWithClient();
    expect(await screen.findByText('No providers match')).toBeInTheDocument();

    routeApi([{ match: list, result: 'reject' }]);
    await client.refetchQueries({ queryKey: ['providers-v2'] });

    const inline = await waitFor(() => {
      const el = staleBanner(/couldn't refresh providers/i);
      expect(el).toBeTruthy();
      return el!;
    });
    expect(inline).toHaveTextContent(/showing the last loaded list/i);
    expect(within(inline).getByRole('button', { name: /^Try again/ })).toBeInTheDocument();
    // Last good (empty) data is still on screen, not replaced by the card error.
    expect(screen.getByText('No providers match')).toBeInTheDocument();
    expect(errorAlert(/couldn't load providers/i)).toBeUndefined();
  });

  it('a failed new filter (keepPreviousData placeholder) is an error, never the previous filter\'s rows/empty copy', async () => {
    routeApi([{ match: list, result: ok }]);
    renderWithClient();
    expect(await screen.findByText('No providers match')).toBeInTheDocument();

    routeApi([{ match: list, result: 'reject' }]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'ACTIVE' }));

    await waitFor(() => expect(errorAlert(/couldn't load providers/i)).toBeTruthy());
    expect(screen.queryByText('No providers match')).not.toBeInTheDocument();
  });
});

describe('Takedowns: refetch fails after an empty result', () => {
  it('shows the inline error AND the empty state (not a blank area)', async () => {
    const list = '/api/admin/takedowns';
    routeApi([{ match: list, result: { data: [], total: 0, status_counts: [], scope: 'authorized' } }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <ToastProvider>
            <Takedowns />
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('No takedown requests')).toBeInTheDocument();

    routeApi([{ match: list, result: 'reject' }]);
    await client.refetchQueries({ queryKey: ['admin-takedowns'] });

    await waitFor(() => expect(staleBanner(/couldn't refresh takedowns/i)).toBeTruthy());
    expect(screen.getByText('No takedown requests')).toBeInTheDocument();
    expect(errorAlert(/couldn't load takedown requests/i)).toBeUndefined();
  });
});

describe('DarkWeb classification badge', () => {
  it('uses the shared proper-cased "Confirmed" label for confirmed mentions', async () => {
    routeApi([{ match: '/api/darkweb/mentions', result: { success: true, data: {
      results: [{
        id: 'm1', brand_id: 'b1', brand_name: 'Acme', brand_domain: 'acme.com', source: 'paste', source_url: 'https://x', source_channel: null,
        source_author: null, posted_at: null, content_snippet: 'leak', matched_terms: null, match_type: null, classification: 'confirmed',
        severity: 'high', status: 'active', first_seen: '2026-01-01', last_seen: '2026-01-02',
      }],
      total: 1,
      aggregates: { slice: { total_active: 1, confirmed_active: 1, suspicious_active: 0, critical_active: 0, high_active: 1, medium_active: 0, low_active: 0 }, by_source: [], by_severity: [] },
      applied: {},
    } } }]);
    renderWithProviders(<DarkWeb />);
    const row = (await screen.findByText('leak')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Confirmed')).toBeInTheDocument();
    expect(within(row).queryByText('confirmed')).not.toBeInTheDocument();
  });
});
