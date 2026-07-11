// Shared routing table for cross-entity search results.
//
// Single source of truth for "where does a /api/search result of type X
// go when selected" and "where does the group's 'view all' link go". Used
// by both the ephemeral ⌘K command palette (components/layout/CommandPalette.tsx)
// and the persistent /search results page (features/search/SearchResults.tsx)
// so the two surfaces can't drift apart on routing.
//
// /brands, /threat-actors, /providers, /campaigns all read `?q=` (Tier-2 —
// see Brands.tsx/BrandsGrid.tsx, ThreatActors.tsx, Providers.tsx,
// Campaigns.tsx) and seed their list/search state from it, so "view all"
// carries the query through instead of landing on the bare list.
//
// app_store has no working per-brand/per-listing destination yet: there is
// no per-listing view, and BrandDetail's V3_TABS has no 'apps' tab (so
// /brands/:id?tab=apps silently falls back to Surface). Until a real apps
// destination exists, both routeFor and viewAllTo go to the cross-brand
// /apps overview — the honest, working landing. The /api/search result's
// `id` is the owning brand_id (reserved for a future brand-apps deep-link).

import { Building2, Network, Server, Megaphone, Smartphone } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SearchResultType } from '@/hooks/useGlobalSearch';

export interface SearchGroupConfig {
  type: SearchResultType;
  heading: string;
  icon: LucideIcon;
  /** Destination for selecting an individual result row. */
  routeFor: (id: string) => string;
  /** Destination for the group's "view all" row/link, seeded with the query. */
  viewAllTo: (q: string) => string;
}

// Fixed render order BRANDS → THREAT ACTORS → PROVIDERS → CAMPAIGNS → APPS,
// shared by the palette's flat list and the search page's sections.
export const SEARCH_GROUPS: SearchGroupConfig[] = [
  { type: 'brand', heading: 'BRANDS', icon: Building2, routeFor: id => `/brands/${id}`, viewAllTo: q => `/brands?q=${encodeURIComponent(q)}` },
  { type: 'threat_actor', heading: 'THREAT ACTORS', icon: Network, routeFor: id => `/threat-actors?focus=${id}`, viewAllTo: q => `/threat-actors?q=${encodeURIComponent(q)}` },
  { type: 'provider', heading: 'PROVIDERS', icon: Server, routeFor: id => `/providers?focus=${id}`, viewAllTo: q => `/providers?q=${encodeURIComponent(q)}` },
  { type: 'campaign', heading: 'CAMPAIGNS', icon: Megaphone, routeFor: id => `/campaigns/${id}`, viewAllTo: q => `/campaigns?q=${encodeURIComponent(q)}` },
  { type: 'app_store', heading: 'APPS', icon: Smartphone, routeFor: () => '/apps', viewAllTo: () => '/apps' },
];

/** Builds the persistent search-results page URL for a raw query string. */
export function searchPageUrl(q: string): string {
  return `/search?q=${encodeURIComponent(q)}`;
}
