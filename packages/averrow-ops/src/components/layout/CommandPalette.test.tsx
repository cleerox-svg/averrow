// Tests for CommandPalette's data-search integration (T3/T4): the
// type -> route mapping for each entity type, the "view all results"
// trailer, and the query-length gate that keeps data groups hidden
// under 2 characters. useGlobalSearch is mocked (it has its own test
// file) so these tests isolate the palette's own routing/rendering
// logic. Frozen-component rule doesn't apply here — CommandPalette
// isn't in the frozen list.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { CommandPalette } from './CommandPalette';

const mocks = vi.hoisted(() => ({
  useGlobalSearch: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/hooks/useGlobalSearch', () => ({
  useGlobalSearch: mocks.useGlobalSearch,
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

// jsdom doesn't implement scrollIntoView; the palette calls it on the
// active row every time the selection changes (see the `active`/`open`
// effect in CommandPalette.tsx).
Element.prototype.scrollIntoView = vi.fn();

const SEARCH_INPUT_PLACEHOLDER = /search pages/i;

const RESULTS = {
  brands: [{ type: 'brand' as const, id: 'b1', label: 'Acme Corp', sublabel: 'acme.com' }],
  threatActors: [{ type: 'threat_actor' as const, id: 't1', label: 'APT-Acme', sublabel: 'CN' }],
  providers: [{ type: 'provider' as const, id: 'p1', label: 'CloudCo', sublabel: 'AS123' }],
  campaigns: [{ type: 'campaign' as const, id: 'c1', label: 'Op Acme', sublabel: 'active' }],
  // app_store's `id` is the OWNING BRAND id (not the listing PK) — see
  // handlers/search.ts / the DATA_GROUPS comment in CommandPalette.tsx.
  appStore: [{ type: 'app_store' as const, id: 'b7', label: 'Acme Wallet', sublabel: 'Acme Inc.' }],
  isLoading: false,
};

async function typeQuery(text: string) {
  const input = screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER);
  await userEvent.type(input, text);
}

describe('CommandPalette — data search routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useGlobalSearch.mockReturnValue(RESULTS);
  });

  it('does not render any data group while the trimmed query is under 2 characters', async () => {
    const onClose = vi.fn();
    renderWithProviders(<CommandPalette open onClose={onClose} commands={[]} />);
    await typeQuery('a');

    expect(screen.queryByText('BRANDS')).not.toBeInTheDocument();
    expect(screen.queryByText('THREAT ACTORS')).not.toBeInTheDocument();
    expect(screen.queryByText('PROVIDERS')).not.toBeInTheDocument();
    expect(screen.queryByText('CAMPAIGNS')).not.toBeInTheDocument();
    expect(screen.queryByText('APPS')).not.toBeInTheDocument();
  });

  it('renders data groups once the trimmed query reaches 2 characters', async () => {
    const onClose = vi.fn();
    renderWithProviders(<CommandPalette open onClose={onClose} commands={[]} />);
    await typeQuery('ac');

    expect(screen.getByText('BRANDS')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('THREAT ACTORS')).toBeInTheDocument();
    expect(screen.getByText('PROVIDERS')).toBeInTheDocument();
    expect(screen.getByText('CAMPAIGNS')).toBeInTheDocument();
    expect(screen.getByText('APPS')).toBeInTheDocument();
    expect(screen.getByText('Acme Wallet')).toBeInTheDocument();
  });

  it('routes a brand row to /brands/:id and closes the palette', async () => {
    const onClose = vi.fn();
    renderWithProviders(<CommandPalette open onClose={onClose} commands={[]} />);
    await typeQuery('ac');

    await userEvent.click(screen.getByText('Acme Corp'));

    expect(mocks.navigate).toHaveBeenCalledWith('/brands/b1');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('routes a threat_actor row to /threat-actors?focus=:id', async () => {
    renderWithProviders(<CommandPalette open onClose={vi.fn()} commands={[]} />);
    await typeQuery('ac');

    await userEvent.click(screen.getByText('APT-Acme'));

    expect(mocks.navigate).toHaveBeenCalledWith('/threat-actors?focus=t1');
  });

  it('routes a provider row to /providers?focus=:id', async () => {
    renderWithProviders(<CommandPalette open onClose={vi.fn()} commands={[]} />);
    await typeQuery('ac');

    await userEvent.click(screen.getByText('CloudCo'));

    expect(mocks.navigate).toHaveBeenCalledWith('/providers?focus=p1');
  });

  it('routes a campaign row to /campaigns/:id', async () => {
    renderWithProviders(<CommandPalette open onClose={vi.fn()} commands={[]} />);
    await typeQuery('ac');

    await userEvent.click(screen.getByText('Op Acme'));

    expect(mocks.navigate).toHaveBeenCalledWith('/campaigns/c1');
  });

  it('routes an app_store row to the /apps overview (no working per-brand apps destination yet)', async () => {
    renderWithProviders(<CommandPalette open onClose={vi.fn()} commands={[]} />);
    await typeQuery('ac');

    await userEvent.click(screen.getByText('Acme Wallet'));

    // No per-listing detail page, and BrandDetail has no 'apps' tab (so
    // /brands/:id?tab=apps silently falls back to Surface), so an app hit
    // routes to the cross-brand /apps overview — the honest working landing.
    expect(mocks.navigate).toHaveBeenCalledWith('/apps');
  });

  it('routes "View all results" carrying the current query as ?q= (not the bare list route)', async () => {
    renderWithProviders(<CommandPalette open onClose={vi.fn()} commands={[]} />);
    await typeQuery('ac');

    const viewAllBrands = screen.getAllByText('View all results for “ac”')[0];
    await userEvent.click(viewAllBrands);

    // First data-group's "view all" trailer now carries the query through —
    // /brands?q=ac, not the bare /brands — so the list page can seed its
    // own search state from ?q= (Tier-2; see the DATA_GROUPS comment in
    // CommandPalette.tsx and Brands.tsx/BrandsGrid.tsx).
    expect(mocks.navigate).toHaveBeenCalledWith('/brands?q=ac');
  });

  it('renders a "view all" trailer per group, each pointing at its own list route with the query attached', async () => {
    renderWithProviders(<CommandPalette open onClose={vi.fn()} commands={[]} />);
    await typeQuery('ac');

    const viewAllRows = screen.getAllByText('View all results for “ac”');
    expect(viewAllRows).toHaveLength(5); // one per DATA_GROUPS entry, including APPS

    await userEvent.click(viewAllRows[1]); // threat actors
    expect(mocks.navigate).toHaveBeenCalledWith('/threat-actors?q=ac');

    await userEvent.click(viewAllRows[2]); // providers
    expect(mocks.navigate).toHaveBeenLastCalledWith('/providers?q=ac');

    await userEvent.click(viewAllRows[3]); // campaigns
    expect(mocks.navigate).toHaveBeenLastCalledWith('/campaigns?q=ac');

    // apps' "view all" goes to the cross-brand /apps overview — it has no
    // ?q= reader and is deliberately not query-scoped (see DATA_GROUPS).
    await userEvent.click(viewAllRows[4]); // apps
    expect(mocks.navigate).toHaveBeenLastCalledWith('/apps');
  });

  it('URL-encodes special characters in the carried query', async () => {
    renderWithProviders(<CommandPalette open onClose={vi.fn()} commands={[]} />);
    await typeQuery('a&b');

    const viewAllBrands = screen.getAllByText('View all results for “a&b”')[0];
    await userEvent.click(viewAllBrands);

    expect(mocks.navigate).toHaveBeenCalledWith('/brands?q=a%26b');
  });

  it('omits a group entirely when it has no results, rather than rendering an empty heading', async () => {
    mocks.useGlobalSearch.mockReturnValue({
      brands: [],
      threatActors: RESULTS.threatActors,
      providers: [],
      campaigns: [],
      appStore: [],
      isLoading: false,
    });
    renderWithProviders(<CommandPalette open onClose={vi.fn()} commands={[]} />);
    await typeQuery('ac');

    expect(screen.queryByText('BRANDS')).not.toBeInTheDocument();
    expect(screen.getByText('THREAT ACTORS')).toBeInTheDocument();
    expect(screen.queryByText('PROVIDERS')).not.toBeInTheDocument();
    expect(screen.queryByText('CAMPAIGNS')).not.toBeInTheDocument();
    expect(screen.queryByText('APPS')).not.toBeInTheDocument();
  });

  it('renders nothing when the palette is closed', () => {
    renderWithProviders(<CommandPalette open={false} onClose={vi.fn()} commands={[]} />);
    expect(screen.queryByPlaceholderText(SEARCH_INPUT_PLACEHOLDER)).not.toBeInTheDocument();
  });
});
