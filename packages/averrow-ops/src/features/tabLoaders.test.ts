// Console / Explorer tab chunk registries: which pane `?tab=` preloads, that
// bad input never throws at boot, and that the lazy components share the very
// same factory (so the preloaded module is the one rendered).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loaded, lazyArgs } = vi.hoisted(() => ({
  loaded: [] as string[],
  lazyArgs: [] as Array<() => Promise<unknown>>,
}));

const MOCKS: Array<[string, string, Record<string, unknown>]> = [
  ['@/features/alerts/Alerts', 'alerts', { Alerts: () => null }],
  ['@/features/threats/Threats', 'threats', { Threats: () => null }],
  ['@/features/takedowns/Takedowns', 'takedowns', { Takedowns: () => null }],
  ['@/features/admin-incidents/Incidents', 'incidents', { AdminIncidents: () => null }],
  ['@/features/brands/Brands', 'brands', { BrandsV3: () => null }],
  ['@/features/threat-actors/ThreatActors', 'actors', { ThreatActors: () => null }],
  ['@/features/campaigns/Campaigns', 'campaigns', { Campaigns: () => null }],
  ['@/features/providers/Providers', 'providers', { Providers: () => null }],
];

function registerMocks() {
  for (const [path, name, exports] of MOCKS) {
    vi.doMock(path, () => { loaded.push(name); return exports; });
  }
}

// Capture every React.lazy(factory) so we can assert identity with the registry.
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, lazy: (f: () => Promise<{ default: never }>) => { lazyArgs.push(f); return actual.lazy(f); } };
});

const PROTO_KEYS = ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'];
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => { vi.resetModules(); registerMocks(); loaded.length = 0; lazyArgs.length = 0; });

describe('console tab preloader', () => {
  const cases: Array<[string | null, string]> = [
    ['alerts', 'alerts'],
    ['threats', 'threats'],
    ['incidents', 'incidents'],
    ['takedowns', 'takedowns'],
    [null, 'alerts'],
    ['', 'alerts'],
    ['signals', 'alerts'], // legacy alias
    ['bogus', 'alerts'],
  ];
  it.each(cases)('?tab=%s loads only the %s pane', async (tab, pane) => {
    const { preloadConsoleTab } = await import('@/features/console/tabLoaders');
    preloadConsoleTab(tab);
    await settle();
    expect(loaded).toEqual([pane]);
  });

  // Regression: `tab in LOADERS` accepted Object.prototype keys and threw a
  // TypeError at App module evaluation (blank app on ?tab=toString).
  it.each(PROTO_KEYS)('?tab=%s (prototype key) falls back to alerts without throwing', async (tab) => {
    const { preloadConsoleTab } = await import('@/features/console/tabLoaders');
    expect(() => preloadConsoleTab(tab)).not.toThrow();
    await settle();
    expect(loaded).toEqual(['alerts']);
  });

  it('swallows a rejected chunk import', async () => {
    vi.doMock('@/features/alerts/Alerts', () => { throw new Error('chunk 404'); });
    const { preloadConsoleTab } = await import('@/features/console/tabLoaders');
    expect(() => preloadConsoleTab('alerts')).not.toThrow();
    await settle();
    vi.doUnmock('@/features/alerts/Alerts');
  });

  it('Console.tsx lazy panes use the registry factories', async () => {
    const loaders = await import('@/features/console/tabLoaders');
    await import('@/features/console/Console');
    for (const f of [loaders.loadAlerts, loaders.loadThreats, loaders.loadTakedowns, loaders.loadIncidents]) {
      expect(lazyArgs).toContain(f);
    }
  });
});

describe('explore tab preloader', () => {
  const cases: Array<[string | null, string]> = [
    ['brands', 'brands'],
    ['actors', 'actors'],
    ['campaigns', 'campaigns'],
    ['providers', 'providers'],
    [null, 'brands'],
    ['', 'brands'],
    ['bogus', 'brands'],
  ];
  it.each(cases)('?tab=%s loads only the %s pane', async (tab, pane) => {
    const { preloadExploreTab } = await import('@/features/explore/tabLoaders');
    preloadExploreTab(tab);
    await settle();
    expect(loaded).toEqual([pane]);
  });

  it.each(PROTO_KEYS)('?tab=%s (prototype key) falls back to brands without throwing', async (tab) => {
    const { preloadExploreTab } = await import('@/features/explore/tabLoaders');
    expect(() => preloadExploreTab(tab)).not.toThrow();
    await settle();
    expect(loaded).toEqual(['brands']);
  });

  it('ExploreWorkspace lazy panes use the registry factories', async () => {
    const loaders = await import('@/features/explore/tabLoaders');
    await import('@/features/explore/ExploreWorkspace');
    for (const f of [loaders.loadBrands, loaders.loadThreatActors, loaders.loadCampaigns, loaders.loadProviders]) {
      expect(lazyArgs).toContain(f);
    }
  });
});
