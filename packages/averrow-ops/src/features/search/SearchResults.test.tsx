// Tests for the persistent /search results page (T3). useGlobalSearch is
// mocked (it has its own test file) so these tests isolate the page's own
// state gating (empty-query / loading / error / no-results / populated)
// and its use of the shared SEARCH_GROUPS routing table for result rows
// and "view all" links. Query string is driven via window.history.pushState
// + the real BrowserRouter from renderWithProviders (see Leads.test.tsx for
// the same pattern), so useSearchParams behaves exactly as it does at runtime.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { SearchResults } from './SearchResults';

const mocks = vi.hoisted(() => ({
  useGlobalSearch: vi.fn(),
}));

vi.mock('@/hooks/useGlobalSearch', () => ({
  useGlobalSearch: mocks.useGlobalSearch,
}));

const EMPTY_RESULTS = {
  brands: [],
  threatActors: [],
  providers: [],
  campaigns: [],
  appStore: [],
  isLoading: false,
  isError: false,
};

const POPULATED_RESULTS = {
  brands: [{ type: 'brand' as const, id: 'b1', label: 'Acme Corp', sublabel: 'acme.com' }],
  threatActors: [{ type: 'threat_actor' as const, id: 't1', label: 'APT-Acme', sublabel: 'CN' }],
  providers: [],
  campaigns: [],
  appStore: [],
  isLoading: false,
  isError: false,
};

function navigateTo(path: string) {
  window.history.pushState({}, '', path);
}

describe('SearchResults — state gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty-query prompt when there is no q param', () => {
    navigateTo('/search');
    mocks.useGlobalSearch.mockReturnValue(EMPTY_RESULTS);
    renderWithProviders(<SearchResults />);

    expect(screen.getByText('Start typing to search')).toBeInTheDocument();
  });

  it('shows the empty-query prompt when q is under 2 characters', () => {
    navigateTo('/search?q=a');
    mocks.useGlobalSearch.mockReturnValue(EMPTY_RESULTS);
    renderWithProviders(<SearchResults />);

    expect(screen.getByText('Start typing to search')).toBeInTheDocument();
  });

  it('shows the loading state once q clears the 2-char gate and the hook is fetching', () => {
    navigateTo('/search?q=ac');
    mocks.useGlobalSearch.mockReturnValue({ ...EMPTY_RESULTS, isLoading: true });
    renderWithProviders(<SearchResults />);

    expect(screen.getByText('Searching…')).toBeInTheDocument();
    expect(screen.queryByText('Start typing to search')).not.toBeInTheDocument();
  });

  it('shows the error state when useGlobalSearch reports isError, taking precedence over no-results', () => {
    navigateTo('/search?q=ac');
    mocks.useGlobalSearch.mockReturnValue({ ...EMPTY_RESULTS, isError: true });
    renderWithProviders(<SearchResults />);

    expect(screen.getByText('Search failed')).toBeInTheDocument();
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
  });

  it('shows the no-results state, echoing the term, when the query is genuinely empty (not loading, not erroring)', () => {
    navigateTo('/search?q=zzz');
    mocks.useGlobalSearch.mockReturnValue(EMPTY_RESULTS);
    renderWithProviders(<SearchResults />);

    expect(screen.getByText('No results for “zzz”')).toBeInTheDocument();
  });

  it('renders populated group sections when results exist, omitting empty groups', () => {
    navigateTo('/search?q=ac');
    mocks.useGlobalSearch.mockReturnValue(POPULATED_RESULTS);
    renderWithProviders(<SearchResults />);

    expect(screen.getByText('BRANDS')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('THREAT ACTORS')).toBeInTheDocument();
    expect(screen.getByText('APT-Acme')).toBeInTheDocument();

    // Empty groups (providers, campaigns, apps) render no heading at all.
    expect(screen.queryByText('PROVIDERS')).not.toBeInTheDocument();
    expect(screen.queryByText('CAMPAIGNS')).not.toBeInTheDocument();
    expect(screen.queryByText('APPS')).not.toBeInTheDocument();

    expect(screen.queryByText('Start typing to search')).not.toBeInTheDocument();
    expect(screen.queryByText('Searching…')).not.toBeInTheDocument();
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
  });
});

describe('SearchResults — row navigation via the shared routing table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateTo('/search?q=ac');
    mocks.useGlobalSearch.mockReturnValue(POPULATED_RESULTS);
  });

  it('a brand result row links to /brands/:id', () => {
    renderWithProviders(<SearchResults />);
    const row = screen.getByRole('link', { name: /Acme Corp/ });
    expect(row).toHaveAttribute('href', '/brands/b1');
  });

  it('a threat_actor result row links to /threat-actors?focus=:id', () => {
    renderWithProviders(<SearchResults />);
    const row = screen.getByRole('link', { name: /APT-Acme/ });
    expect(row).toHaveAttribute('href', '/threat-actors?focus=t1');
  });

  it('the brand group\'s "view all" link carries the query to /brands?q=', () => {
    renderWithProviders(<SearchResults />);
    const viewAll = screen.getByRole('link', { name: 'View all in brands →' });
    expect(viewAll).toHaveAttribute('href', '/brands?q=ac');
  });

  it('the threat actor group\'s "view all" link carries the query to /threat-actors?q=', () => {
    renderWithProviders(<SearchResults />);
    const viewAll = screen.getByRole('link', { name: 'View all in threat actors →' });
    expect(viewAll).toHaveAttribute('href', '/threat-actors?q=ac');
  });
});
