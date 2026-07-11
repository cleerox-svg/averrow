// Persistent, shareable /search results page.
//
// The ⌘K command palette (components/layout/CommandPalette.tsx) is an
// ephemeral overlay capped at 5 rows/group. This page renders the same
// grouped /api/search results (via useGlobalSearch) behind a real URL —
// ?q= is the sole source of truth, so the page is bookmarkable/shareable
// and survives closing the palette.
//
// Routing per result row and each group's "view all" link come from the
// shared features/search/searchRouting.ts table so this page and the
// palette can't diverge on where a given result type navigates.

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search as SearchIcon, Loader2, AlertTriangle } from 'lucide-react';
import { Card, PageHeader, EmptyState, DataRow } from '@/design-system/components';
import { useGlobalSearch, type SearchResult } from '@/hooks/useGlobalSearch';
import { SEARCH_GROUPS } from './searchRouting';

function ResultRow({ result, to }: { result: SearchResult; to: string }) {
  return (
    <Link to={to} style={{ display: 'block', textDecoration: 'none' }}>
      <DataRow className="px-3 py-2.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div
            className="font-mono text-[13px] font-bold truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {result.label}
          </div>
          {result.sublabel && (
            <div
              className="font-mono text-[11px] truncate mt-0.5"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {result.sublabel}
            </div>
          )}
        </div>
      </DataRow>
    </Link>
  );
}

export function SearchResults() {
  const [searchParams] = useSearchParams();
  const q = (searchParams.get('q') ?? '').trim();

  const { brands, threatActors, providers, campaigns, appStore, isLoading, isError } = useGlobalSearch(q);

  const groupResults: Record<string, SearchResult[]> = {
    brand: brands,
    threat_actor: threatActors,
    provider: providers,
    campaign: campaigns,
    app_store: appStore,
  };

  const totalResults = useMemo(
    () => brands.length + threatActors.length + providers.length + campaigns.length + appStore.length,
    [brands, threatActors, providers, campaigns, appStore],
  );

  const showEmptyQuery = q.length < 2;
  const showLoading = !showEmptyQuery && isLoading;
  // Genuine fetch/backend failure (useGlobalSearch's isError) is distinct
  // from "no matches" — takes precedence over the no-results state so a
  // 500 doesn't masquerade as "nothing found for that term".
  const showError = !showEmptyQuery && !isLoading && isError;
  const showNoResults = !showEmptyQuery && !isLoading && !isError && totalResults === 0;

  return (
    <div className="animate-fade-in space-y-8">
      <PageHeader
        title="Search"
        subtitle={q ? `Results for “${q}”` : 'Search brands, threat actors, providers, campaigns, and apps'}
      />

      {showEmptyQuery && (
        <Card variant="base" padding="0">
          <EmptyState
            icon={<SearchIcon />}
            title="Start typing to search"
            subtitle="Use ⌘K / Ctrl-K to search from anywhere, or add ?q= to this page's URL to share a search."
            variant="clean"
          />
        </Card>
      )}

      {showLoading && (
        <Card variant="base" padding="0">
          <div
            className="flex items-center justify-center gap-2 py-16 font-mono text-[12px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <Loader2 size={14} strokeWidth={2} className="animate-spin" />
            Searching…
          </div>
        </Card>
      )}

      {showError && (
        <Card variant="base" padding="0">
          <EmptyState
            icon={<AlertTriangle />}
            title="Search failed"
            subtitle="Something went wrong loading results. Try again in a moment."
            variant="error"
          />
        </Card>
      )}

      {showNoResults && (
        <Card variant="base" padding="0">
          <EmptyState
            icon={<SearchIcon />}
            title={`No results for “${q}”`}
            subtitle="Try a different term, or check spelling — brand, domain, actor, provider, and campaign names all match."
            variant="clean"
          />
        </Card>
      )}

      {!showEmptyQuery && !showLoading && !showError && totalResults > 0 && (
        <div className="space-y-6">
          {SEARCH_GROUPS.map(group => {
            const rows = groupResults[group.type] ?? [];
            if (rows.length === 0) return null;
            const Icon = group.icon;
            return (
              <section key={group.type}>
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon size={14} strokeWidth={2} style={{ color: 'var(--text-tertiary)' }} />
                    <span
                      className="font-mono text-[11px] font-bold uppercase tracking-widest"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {group.heading}
                    </span>
                    <span
                      className="font-mono text-[10px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {rows.length}
                    </span>
                  </div>
                  <Link
                    to={group.viewAllTo(q)}
                    className="font-mono text-[10px] font-bold uppercase tracking-wide"
                    style={{ color: 'var(--amber)' }}
                  >
                    View all in {group.heading.toLowerCase()} →
                  </Link>
                </div>
                <Card variant="base" padding="0">
                  {rows.map(result => (
                    <ResultRow key={`${group.type}:${result.id}`} result={result} to={group.routeFor(result.id)} />
                  ))}
                </Card>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
