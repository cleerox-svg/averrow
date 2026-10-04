// Real Console + real Threats: clicking a Corroboration row changes `?q=`, which
// remounts the Threats view (Console keys the pane on `q`). The scroll/focus must
// land on the NEW #threats-table, not the one that existed before navigation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';
import { Console } from '@/features/console/Console';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ isSuperAdmin: false, user: { id: 'u1', role: 'analyst', name: 'Ada', email: 'a@x.io' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('@/hooks/useThreatAggregate', () => ({ useThreatAggregate: () => ({ data: undefined, isError: false, refetch: vi.fn() }) }));
vi.mock('./ThreatInflowChart', () => ({ ThreatInflowChart: () => null }));
vi.mock('@averrow/shared/threats-table', () => ({
  ThreatsTable: () => null,
  useThreatsTable: () => ({
    state: { severity: '', type: '', status: '', country: '', brandId: '', q: '' },
    params: { limit: 50, offset: 0, sort: 'last_seen', dir: 'desc' },
    pageSize: 50,
    setFilter: vi.fn(), setSearch: vi.fn(), toggleSort: vi.fn(), setPage: vi.fn(),
  }),
}));
vi.mock('@/features/alerts/Alerts', () => ({ Alerts: () => null }));
vi.mock('@/features/takedowns/Takedowns', () => ({ Takedowns: () => null }));
vi.mock('@/features/admin-incidents/Incidents', () => ({ AdminIncidents: () => null }));

import { api } from '@/lib/api';
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const ROW = {
  ip_address: '203.0.113.7', feed_count: 5, feeds: ['urlhaus', 'openphish'],
  threat_count: 12, brand_count: 3, last_seen: '2026-10-03T10:00:00Z',
};

let releaseList: () => void = () => {};
let listGate: Promise<void> = Promise.resolve();

describe('Corroboration row click -> Threats table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia(false);
    listGate = new Promise<void>((r) => { releaseList = r; });
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/intel/multi-feed-consensus')) return { success: true, data: [ROW] };
      if (url.startsWith('/api/threats')) {
        // Hold the q-scoped list open so tests can prove nothing scrolls before it resolves.
        if (window.location.search.includes('q=')) await listGate;
        return { success: true, data: { threats: [], total: 0 } };
      }
      return { success: true, data: [] };
    });
  });

  it('scrolls and focuses the remounted table, once, and clears the one-shot state', async () => {
    window.history.pushState({}, '', '/?tab=threats');
    const calls: Element[] = [];
    const opts: ScrollIntoViewOptions[] = [];
    Element.prototype.scrollIntoView = function (this: Element, o?: boolean | ScrollIntoViewOptions) {
      calls.push(this);
      if (typeof o === 'object') opts.push(o);
    };
    renderWithProviders(<Console />);
    const link = await screen.findByRole('link', { name: /203\.0\.113\.7/ }, { timeout: 8000 });
    const oldTable = document.getElementById('threats-table');
    expect(oldTable).not.toBeNull();

    await userEvent.setup().click(link);

    // Table remounted with `q`, but its list is still loading: no scroll yet.
    await waitFor(() => expect(window.location.search).toContain('q=203.0.113.7'));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(0);
    releaseList();
    await waitFor(() => expect(calls.length).toBe(1));
    const newTable = document.getElementById('threats-table');
    expect(newTable).not.toBeNull();
    expect(newTable).not.toBe(oldTable);
    expect(oldTable!.isConnected).toBe(false);
    expect(calls[0]).toBe(newTable);
    expect(opts[0]).toMatchObject({ behavior: 'smooth' });
    expect(document.activeElement).toBe(newTable);
    expect(window.location.search).toContain('q=203.0.113.7');
    expect(window.history.state?.usr?.focusTable).toBeFalsy();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
  });

  it('uses instant scrolling under prefers-reduced-motion', async () => {
    stubMatchMedia(true);
    window.history.pushState({}, '', '/?tab=threats');
    const opts: ScrollIntoViewOptions[] = [];
    Element.prototype.scrollIntoView = function (o?: boolean | ScrollIntoViewOptions) {
      if (typeof o === 'object') opts.push(o);
    };
    renderWithProviders(<Console />);
    await userEvent.setup().click(await screen.findByRole('link', { name: /203\.0\.113\.7/ }, { timeout: 8000 }));
    releaseList();
    await waitFor(() => expect(opts.length).toBe(1));
    expect(opts[0]).toMatchObject({ behavior: 'auto' });
  });
});
