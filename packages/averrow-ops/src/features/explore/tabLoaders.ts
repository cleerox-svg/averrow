// Light-weight registry of the Explorer tab chunk factories (see
// features/console/tabLoaders.ts for the rationale).

export const loadBrands = () => import('@/features/brands/Brands').then(m => ({ default: m.BrandsV3 }));
export const loadThreatActors = () => import('@/features/threat-actors/ThreatActors').then(m => ({ default: m.ThreatActors }));
export const loadCampaigns = () => import('@/features/campaigns/Campaigns').then(m => ({ default: m.Campaigns }));
export const loadProviders = () => import('@/features/providers/Providers').then(m => ({ default: m.Providers }));

const LOADERS: Record<string, () => Promise<unknown>> = {
  brands: loadBrands,
  actors: loadThreatActors,
  campaigns: loadCampaigns,
  providers: loadProviders,
};

/** Start loading the pane for `?tab=` (default: brands). */
export function preloadExploreTab(tab: string | null): void {
  const key = tab && Object.hasOwn(LOADERS, tab) ? tab : 'brands';
  void LOADERS[key]().catch(() => undefined);
}
