// Data hook backing the ⌘K command palette's cross-entity search (T3).
// Hits the staff-gated GET /api/search endpoint and returns typed result
// groups (brands / threat actors / providers / campaigns). See
// components/layout/CommandPalette.tsx for the consumer.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type SearchResultType = 'brand' | 'threat_actor' | 'provider' | 'campaign' | 'app_store';

export interface SearchResult {
  type: SearchResultType;
  id: string;
  label: string;
  sublabel: string | null;
}

export interface GlobalSearchResponse {
  brands: SearchResult[];
  threat_actors: SearchResult[];
  providers: SearchResult[];
  campaigns: SearchResult[];
  // Tier-2: app-store impersonation listings (no dedicated detail page —
  // see CommandPalette.tsx's app_store DATA_GROUPS entry for the routing
  // decision).
  app_store: SearchResult[];
}

const EMPTY_RESPONSE: GlobalSearchResponse = {
  brands: [],
  threat_actors: [],
  providers: [],
  campaigns: [],
  app_store: [],
};

// Local debounce helper — mirrors the pattern already used in
// features/brands/components/BrandsGrid.tsx rather than introducing a new
// shared hook for a single call site.
function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Cross-entity search for the command palette. `q` is the raw (un-debounced)
 * query text from the palette input; this hook debounces it ~200ms before
 * it reaches the network and only fires once the trimmed term is at least
 * 2 characters. `staleTime` is aligned to the endpoint's own ~90s server
 * cache window so repeated opens of the palette for the same term don't
 * refetch needlessly.
 */
export function useGlobalSearch(q: string) {
  const trimmed = q.trim();
  const debouncedQ = useDebouncedValue(trimmed, 200);
  const enabled = debouncedQ.length >= 2;

  const query = useQuery({
    queryKey: ['global-search', debouncedQ],
    queryFn: async () => {
      const res = await api.get<GlobalSearchResponse>(
        `/api/search?q=${encodeURIComponent(debouncedQ)}&limit=8`,
      );
      return res.data ?? EMPTY_RESPONSE;
    },
    enabled,
    staleTime: 90_000,
  });

  const data = query.data ?? EMPTY_RESPONSE;

  return {
    brands: data.brands,
    threatActors: data.threat_actors,
    providers: data.providers,
    campaigns: data.campaigns,
    appStore: data.app_store,
    // Only meaningful once the term clears the 2-char gate — a shorter
    // term never fires a request, so it's never "loading".
    isLoading: enabled && query.isFetching,
  };
}
