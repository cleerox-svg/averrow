// Route + tab chunk preloading at boot: App.preloadRouteForPath maps the
// current URL to the chunk factories that React.lazy also uses, so the page
// downloads in parallel with auth. Module factories below record which chunks
// were actually requested.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loaded } = vi.hoisted(() => ({ loaded: [] as string[] }));

const MOCKS: Array<[string, string, () => Record<string, unknown>]> = [
  ['@/features/home/OverviewV4', 'overview', () => ({ OverviewV4: () => null })],
  ['@/features/observatory-v3/ObservatoryV3', 'observatory', () => ({ ObservatoryV3: () => null })],
  ['@/features/console/Console', 'console', () => ({ Console: () => null })],
  ['@/features/explore/ExploreWorkspace', 'explore', () => ({ ExploreWorkspace: () => null })],
  ['@/features/coverage/CoverageWorkspace', 'coverage', () => ({ CoverageWorkspace: () => null })],
  ['@/features/operations/OperationsWorkspace', 'operations', () => ({ OperationsWorkspace: () => null })],
  ['@/features/governance/GovernanceWorkspace', 'governance', () => ({ GovernanceWorkspace: () => null })],
  ['@/features/brands/BrandDetail', 'brand-detail', () => ({ BrandDetailV3: () => null })],
];

function registerMocks() {
  for (const [path, name, exports] of MOCKS) {
    vi.doMock(path, () => { loaded.push(name); return exports(); });
  }
  vi.doMock('@/features/console/tabLoaders', () => ({
    preloadConsoleTab: (t: string | null) => { loaded.push(`console-tab:${t}`); },
  }));
  vi.doMock('@/features/explore/tabLoaders', () => ({
    preloadExploreTab: (t: string | null) => { loaded.push(`explore-tab:${t}`); },
  }));
}

type PreloadFn = (pathname: string, search: string) => void;

/** Fresh App module (fresh mock-factory run) booted on an unmatched URL, so
 *  `loaded` only reflects the explicit call under test. */
async function freshPreload(): Promise<PreloadFn> {
  vi.resetModules();
  registerMocks();
  window.history.pushState({}, '', '/v2/__nope__');
  const mod = await import('@/App');
  loaded.length = 0;
  return mod.preloadRouteForPath;
}

async function run(pathname: string, search = ''): Promise<string[]> {
  const preload = await freshPreload();
  preload(pathname, search);
  await new Promise(r => setTimeout(r, 0)); // let dynamic imports settle
  return [...loaded].sort();
}

beforeEach(() => { loaded.length = 0; });

describe('preloadRouteForPath', () => {
  it.each([
    ['/', ['overview']],
    ['/observatory', ['observatory']],
    ['/coverage', ['coverage']],
    ['/admin/operations', ['operations']],
    ['/admin/governance', ['governance']],
    ['/brands/brand_123', ['brand-detail']],
  ])('%s loads %j', async (path, expected) => {
    expect(await run(path)).toEqual(expected);
  });

  it('strips the /v2 basename', async () => {
    expect(await run('/v2/observatory')).toEqual(['observatory']);
    expect(await run('/v2/brands/abc')).toEqual(['brand-detail']);
  });

  it('treats /v2 and /v2/ as the home route', async () => {
    expect(await run('/v2')).toEqual(['overview']);
    expect(await run('/v2/')).toEqual(['overview']);
  });

  it('ignores trailing slashes', async () => {
    expect(await run('/coverage/')).toEqual(['coverage']);
    expect(await run('/v2/admin/governance//')).toEqual(['governance']);
  });

  it('does not strip a prefix that merely starts with v2 (/v2evil)', async () => {
    expect(await run('/v2evil')).toEqual([]);
    expect(await run('/v2evil/observatory')).toEqual([]);
  });

  it.each([
    '/nope', '/brands', '/brands/abc/extra', '/settings/profile', '/admin', '/observatory/x', '/login',
  ])('unknown path %s is a no-op', async (path) => {
    expect(await run(path)).toEqual([]);
  });

  it('console loads the workspace chunk plus the tab pane from ?tab=', async () => {
    expect(await run('/console', '?tab=threats')).toEqual(['console', 'console-tab:threats'].sort());
  });

  it('console without ?tab passes null (default pane decided by the registry)', async () => {
    expect(await run('/console')).toEqual(['console', 'console-tab:null'].sort());
  });

  it('console passes the legacy signals alias through to the registry', async () => {
    expect(await run('/v2/console', '?tab=signals')).toEqual(['console', 'console-tab:signals'].sort());
  });

  it('explore loads the workspace chunk plus the tab pane', async () => {
    expect(await run('/explore', '?tab=actors')).toEqual(['explore', 'explore-tab:actors'].sort());
    expect(await run('/explore')).toEqual(['explore', 'explore-tab:null'].sort());
  });

  it('a failing chunk import never throws (rejection swallowed)', async () => {
    const preload = await freshPreload();
    vi.doMock('@/features/coverage/CoverageWorkspace', () => { throw new Error('chunk 404'); });
    expect(() => preload('/coverage', '')).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    vi.doUnmock('@/features/coverage/CoverageWorkspace');
  });
});

describe('preloadRouteForPath with hostile ?tab= values', () => {
  // Uses the real tab registries (not the recording mocks above) so a
  // prototype-key tab exercises the actual lookup that used to throw at boot.
  it.each(['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'])(
    '/console?tab=%s and /explore?tab=%s do not throw', async (tab) => {
      vi.resetModules();
      vi.doUnmock('@/features/console/tabLoaders');
      vi.doUnmock('@/features/explore/tabLoaders');
      for (const [path, mod] of [
        ['@/features/alerts/Alerts', { Alerts: () => null }],
        ['@/features/brands/Brands', { BrandsV3: () => null }],
        ['@/features/console/Console', { Console: () => null }],
        ['@/features/explore/ExploreWorkspace', { ExploreWorkspace: () => null }],
      ] as const) vi.doMock(path, () => mod);
      window.history.pushState({}, '', '/v2/__nope__');
      const { preloadRouteForPath } = await import('@/App');
      expect(() => preloadRouteForPath('/v2/console', `?tab=${tab}`)).not.toThrow();
      expect(() => preloadRouteForPath('/v2/explore', `?tab=${tab}`)).not.toThrow();
      await new Promise(r => setTimeout(r, 0));
    });

  it('booting directly on /v2/console?tab=toString does not break App module evaluation', async () => {
    vi.resetModules();
    vi.doUnmock('@/features/console/tabLoaders');
    window.history.pushState({}, '', '/v2/console?tab=toString');
    await expect(import('@/App')).resolves.toBeDefined();
    await new Promise(r => setTimeout(r, 0));
  });
});
