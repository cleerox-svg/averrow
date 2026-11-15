import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  currentBuildScript, currentAssets, assetsInHtml, isNewBuildAvailable, UPDATE_CHECK_PARAM,
  UpdateBanner, AppUpdateNotice, reloadToLatest,
  UPDATE_INTERVAL_MS, UPDATE_MIN_GAP_MS,
} from '@averrow/shared/ui';
import { buildMeta } from '../../../../shared/scripts/build-meta';

const page = (script: string, extra = '') =>
  `<!doctype html><html><head><meta name="averrow-build-sha" content="abc"><script type="module" crossorigin src="${script}"></script>${extra}</head><body></body></html>`;
const reply = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }));
const A = '/ops/assets/index-A.js';

describe('isNewBuildAvailable', () => {
  it('true when the shell names a different entry', async () => {
    expect(await isNewBuildAvailable([A], '/ops/', reply(page('/ops/assets/index-NEW.js')))).toBe(true);
  });
  it('false when the shell names the same assets; a different meta sha alone is not an update', async () => {
    const same = page(A).replace('content="abc"', 'content="zzz"');
    expect(await isNewBuildAvailable([A], '/ops/', reply(same))).toBe(false);
  });
  it('catches a CSS-only or chunk-only change', async () => {
    const css = '<link rel="stylesheet" href="/ops/assets/index-NEW.css">';
    expect(await isNewBuildAvailable([A], '/ops/', reply(page(A, css)))).toBe(true);
    const chunk = '<link rel="modulepreload" href="/ops/assets/vendor-NEW.js">';
    expect(await isNewBuildAvailable([A, '/ops/assets/vendor-OLD.js'], '/ops/', reply(page(A, chunk)))).toBe(true);
  });
  it('a page that has preloaded extra lazy chunks is not an update', async () => {
    expect(await isNewBuildAvailable([A, '/ops/assets/lazy-X.js'], '/ops/', reply(page(A)))).toBe(false);
  });
  it('false on any doubt: offline, error status, foreign page, nothing to compare', async () => {
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await isNewBuildAvailable([A], '/ops/', offline)).toBe(false);
    expect(await isNewBuildAvailable([A], '/ops/', reply(page('/ops/assets/index-B.js'), 503))).toBe(false);
    expect(await isNewBuildAvailable([A], '/ops/', reply('<html>captive portal</html>'))).toBe(false);
    expect(await isNewBuildAvailable([], '/ops/', reply(page('/ops/assets/index-B.js')))).toBe(false);
    expect(await isNewBuildAvailable(null, '/ops/', reply(page('/ops/assets/index-B.js')))).toBe(false);
  });
  it('probes the given shell URL from the network, never a cache', async () => {
    const f = reply(page('/tenant/assets/index-A.js'));
    await isNewBuildAvailable(['/tenant/assets/index-A.js'], '/tenant/', f, () => 42);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/tenant/?${UPDATE_CHECK_PARAM}=42`);
    expect(init.cache).toBe('no-store');
  });
});

describe('currentAssets / assetsInHtml', () => {
  it('collects js + css asset paths from the document, ignoring other tags', () => {
    document.head.innerHTML =
      '<script type="module" src="https://x.test/ops/assets/index-Z.js"></script>' +
      '<link rel="stylesheet" href="/ops/assets/index-Z.css"><link rel="preload" href="/ops/assets/font.woff2">' +
      '<link rel="icon" href="/ops/favicon.svg">';
    expect([...currentAssets()].sort()).toEqual(['/ops/assets/index-Z.css', '/ops/assets/index-Z.js']);
    expect(currentBuildScript()).toBe('/ops/assets/index-Z.js');
    document.head.innerHTML = '<script type="module" src="/src/main.tsx"></script>';
    expect(currentAssets().size).toBe(0);
    expect(currentBuildScript()).toBeNull();
    document.head.innerHTML = '';
  });
  it('assetsInHtml finds js and css refs only', () => {
    expect([...assetsInHtml(page(A, '<link href="/ops/assets/a.css"><link href="/ops/assets/f.woff2">'))].sort())
      .toEqual(['/ops/assets/a.css', A]);
  });
});

describe('build meta (sha out of the bundle)', () => {
  it('buildMeta injects sha + built-at as head metas', () => {
    const out = buildMeta({ sha: 'deadbee', builtAt: '2026-11-15T00:00:00.000Z' }).transformIndexHtml.handler('<html></html>');
    expect(out.tags.map((t) => [t.attrs.name, t.attrs.content, t.injectTo])).toEqual([
      ['averrow-build-sha', 'deadbee', 'head'],
      ['averrow-built-at', '2026-11-15T00:00:00.000Z', 'head'],
    ]);
  });
  it.each(['averrow-ops', 'averrow-tenant'])('%s no longer defines the sha or build time into the JS', (pkg) => {
    const cfg = readFileSync(resolve(__dirname, `../../../../${pkg}/vite.config.ts`), 'utf8');
    expect(cfg).not.toMatch(/__BUILD_SHA__|__BUILT_AT__/);
    expect(cfg).toContain('buildMeta(');
  });
});

describe('UpdateBanner', () => {
  it('Reload calls the handler; no dismiss; no positioning or z-index; safe-area padding', () => {
    const onReload = vi.fn();
    render(<UpdateBanner onReload={onReload} />);
    const banner = screen.getByTestId('app-update-banner');
    expect(banner).toHaveTextContent('A new version of Averrow is available.');
    expect(banner.style.position).toBe('');
    expect(banner.style.zIndex).toBe('');
    expect(banner.getAttribute('style')).toContain('safe-area-inset-top');
    expect(banner.getAttribute('style')).toContain('safe-area-inset-left');
    expect(document.documentElement).toHaveAttribute('data-update-banner');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
  });
  it('clears the top-inset flag on unmount', () => {
    const { unmount } = render(<UpdateBanner onReload={vi.fn()} />);
    unmount();
    expect(document.documentElement).not.toHaveAttribute('data-update-banner');
  });
});

describe('AppUpdateNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    document.head.innerHTML = '<script type="module" src="/ops/assets/index-OLD.js"></script>';
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.head.innerHTML = '';
  });

  const setVisibility = (v: 'visible' | 'hidden') =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });

  it('keeps a persistent empty polite live region, and renders nothing / fetches nothing in dev', async () => {
    document.head.innerHTML = '';
    const f = reply(page('/ops/assets/index-NEW.js'));
    vi.stubGlobal('fetch', f);
    render(<AppUpdateNotice shellUrl="/ops/" />);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(f).not.toHaveBeenCalled();
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
  });

  it('renders the banner INTO the live region once a visible check finds a newer build, then stops polling', async () => {
    setVisibility('visible');
    const f = reply(page('/ops/assets/index-OLD.js'));
    vi.stubGlobal('fetch', f);
    render(<AppUpdateNotice shellUrl="/ops/" />);
    const region = screen.getByRole('status');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(f).toHaveBeenCalledTimes(1);
    expect(region).toBeEmptyDOMElement();

    f.mockImplementation(async () => new Response(page('/ops/assets/index-NEW.js')));
    await act(async () => { vi.advanceTimersByTime(UPDATE_MIN_GAP_MS + 1); });
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toContainElement(screen.getByTestId('app-update-banner'));
    const calls = f.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(UPDATE_INTERVAL_MS * 2); window.dispatchEvent(new Event('focus')); });
    expect(f.mock.calls.length).toBe(calls);
  });

  it('a failed lazy chunk (vite:preloadError) raises the same banner', async () => {
    render(<AppUpdateNotice shellUrl="/ops/" />);
    await act(async () => { window.dispatchEvent(new Event('vite:preloadError')); });
    expect(screen.getByTestId('app-update-banner')).toBeInTheDocument();
  });

  it('does not check while the tab is hidden, and honours the minimum gap', async () => {
    const f = reply(page('/ops/assets/index-OLD.js'));
    vi.stubGlobal('fetch', f);
    render(<AppUpdateNotice shellUrl="/ops/" />);
    setVisibility('hidden');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(f).not.toHaveBeenCalled();
    setVisibility('visible');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(f).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(UPDATE_INTERVAL_MS); });
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('reloadToLatest', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts SKIP_WAITING to a waiting worker, then reloads', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ waiting: { postMessage } }) } });
    const reload = vi.fn();
    await reloadToLatest({ reload });
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('just reloads without a service worker (tenant) or when lookup throws', async () => {
    vi.stubGlobal('navigator', {});
    const reload = vi.fn();
    await reloadToLatest({ reload });
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => { throw new Error('x'); } } });
    await reloadToLatest({ reload });
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('ops service worker', () => {
  const sw = readFileSync(resolve(__dirname, '../../../public/sw.js'), 'utf8');
  it('passes the update probe straight to the network', () => {
    expect(sw).toContain(`searchParams.has('${UPDATE_CHECK_PARAM}')`);
  });
  it('accepts SKIP_WAITING as string or { type }', () => {
    expect(sw).toContain("event.data.type === 'SKIP_WAITING'");
  });
});
