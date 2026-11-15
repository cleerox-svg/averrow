import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  currentBuildScript, isNewBuildAvailable, UPDATE_CHECK_PARAM,
  UpdateBanner, AppUpdateNotice, reloadToLatest,
  UPDATE_INTERVAL_MS, UPDATE_MIN_GAP_MS,
} from '@averrow/shared/ui';

const page = (script: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${script}"></script></head><body></body></html>`;
const reply = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }));

describe('isNewBuildAvailable', () => {
  it('true when the shell names a different build', async () => {
    expect(await isNewBuildAvailable('/v2/assets/index-OLD.js', '/v2/', reply(page('/v2/assets/index-NEW.js')))).toBe(true);
  });
  it('false when the shell still names this build', async () => {
    expect(await isNewBuildAvailable('/v2/assets/index-A.js', '/v2/', reply(page('/v2/assets/index-A.js')))).toBe(false);
  });
  it('false on any doubt: offline, error status, foreign page, no current script', async () => {
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await isNewBuildAvailable('/v2/assets/index-A.js', '/v2/', offline)).toBe(false);
    expect(await isNewBuildAvailable('/v2/assets/index-A.js', '/v2/', reply(page('/v2/assets/index-B.js'), 503))).toBe(false);
    expect(await isNewBuildAvailable('/v2/assets/index-A.js', '/v2/', reply('<html>captive portal</html>'))).toBe(false);
    expect(await isNewBuildAvailable(null, '/v2/', reply(page('/v2/assets/index-B.js')))).toBe(false);
  });
  it('probes the given shell URL from the network, never a cache', async () => {
    const f = reply(page('/tenant/assets/index-A.js'));
    await isNewBuildAvailable('/tenant/assets/index-A.js', '/tenant/', f, () => 42);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/tenant/?${UPDATE_CHECK_PARAM}=42`);
    expect(init.cache).toBe('no-store');
  });
});

describe('currentBuildScript', () => {
  it('reads the built entry script pathname; null without one', () => {
    document.head.innerHTML = '<script type="module" src="https://x.test/v2/assets/index-Z.js"></script>';
    expect(currentBuildScript()).toBe('/v2/assets/index-Z.js');
    document.head.innerHTML = '<script type="module" src="/src/main.tsx"></script>';
    expect(currentBuildScript()).toBeNull();
    document.head.innerHTML = '';
  });
});

describe('UpdateBanner', () => {
  it('announces politely and Reload calls the handler', () => {
    const onReload = vi.fn();
    render(<UpdateBanner onReload={onReload} />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('A new version of Averrow is available.');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
  });
});

describe('AppUpdateNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    document.head.innerHTML = '<script type="module" src="/v2/assets/index-OLD.js"></script>';
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.head.innerHTML = '';
  });

  const setVisibility = (v: 'visible' | 'hidden') =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });

  it('renders nothing in dev (no built entry script) and does not fetch', async () => {
    document.head.innerHTML = '';
    const f = reply(page('/v2/assets/index-NEW.js'));
    vi.stubGlobal('fetch', f);
    render(<AppUpdateNotice shellUrl="/v2/" />);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(f).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the banner once a visible check finds a newer build; a same build shows nothing', async () => {
    setVisibility('visible');
    const f = reply(page('/v2/assets/index-OLD.js'));
    vi.stubGlobal('fetch', f);
    render(<AppUpdateNotice shellUrl="/v2/" />);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(f).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();

    f.mockImplementation(async () => new Response(page('/v2/assets/index-NEW.js')));
    await act(async () => { vi.advanceTimersByTime(UPDATE_MIN_GAP_MS + 1); });
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('does not check while the tab is hidden, and honours the minimum gap', async () => {
    const f = reply(page('/v2/assets/index-OLD.js'));
    vi.stubGlobal('fetch', f);
    render(<AppUpdateNotice shellUrl="/v2/" />);
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
