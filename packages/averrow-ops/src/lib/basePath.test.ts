import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OPS_BASE_PATH, OPS_SHELL_URL, LEGACY_OPS_BASE_PATH, stripOpsBase } from './basePath';
import { unregisterLegacyServiceWorkers } from './pwa';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('basePath constants', () => {
  it('is /ops, shell URL has the trailing slash', () => {
    expect(OPS_BASE_PATH).toBe('/ops');
    expect(OPS_SHELL_URL).toBe('/ops/');
    expect(LEGACY_OPS_BASE_PATH).toBe('/v2');
  });

  it.each([
    ['/ops', ''], ['/ops/', '/'], ['/ops/feeds', '/feeds'], ['/ops?x=1', '?x=1'], ['/ops#a', '#a'],
    ['/v2/feeds', '/feeds'], ['/v2', ''],
    ['/opsevil', '/opsevil'], ['/opsevil/x', '/opsevil/x'], ['/v2x', '/v2x'], ['/feeds', '/feeds'],
  ])('stripOpsBase(%j) -> %j', (input, out) => {
    expect(stripOpsBase(input)).toBe(out);
  });
});

// Static files cannot import the constant; they must say the same thing.
describe('static files are pinned to the constant', () => {
  it('manifest.json id / start_url / scope', () => {
    const m = JSON.parse(read('public/manifest.json'));
    expect(m.id).toBe(OPS_SHELL_URL);
    expect(m.start_url).toBe(OPS_SHELL_URL);
    expect(m.scope).toBe(OPS_SHELL_URL);
    for (const icon of m.icons) expect(icon.src.startsWith(`${OPS_BASE_PATH}/`)).toBe(true);
  });

  it('sw.js precache, asset rule and notification click paths are under /ops', () => {
    const sw = read('public/sw.js');
    expect(sw).toContain(`'${OPS_SHELL_URL}'`);
    expect(sw).toContain(`'${OPS_BASE_PATH}/index.html'`);
    expect(sw).toContain(`startsWith('${OPS_BASE_PATH}/assets/')`);
    expect(sw).toContain(`icon: '${OPS_BASE_PATH}/icon-192.png'`);
    // Only the legacy in-flight-payload mapping may mention /v2.
    const v2 = sw.split('\n').filter((l) => l.includes('/v2'));
    expect(v2.join('\n')).toMatch(/path === '\/v2'/);
    expect(v2.length).toBeLessThanOrEqual(2);
  });

  it('index.html links', () => {
    const html = read('index.html');
    expect(html).toContain(`href="${OPS_BASE_PATH}/manifest.json"`);
    expect(html).not.toContain('"/v2');
  });

  it('vite.config.ts derives base + outDir from the constant (no literal /v2)', () => {
    const cfg = read('vite.config.ts');
    expect(cfg).toContain('OPS_BASE_PATH');
    expect(cfg).not.toContain('/v2');
  });

  it('pwa.ts registers /ops/sw.js with scope /ops/', () => {
    const src = read('src/lib/pwa.ts');
    expect(src).toContain('`${OPS_BASE_PATH}/sw.js`');
    expect(src).toContain('scope: OPS_SHELL_URL');
  });
});

describe('unregisterLegacyServiceWorkers', () => {
  const origSW = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
  afterEach(() => {
    if (origSW) Object.defineProperty(navigator, 'serviceWorker', origSW);
    else delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  });

  function withRegistrations(regs: Array<{ scope: string; unregister: () => Promise<boolean> }>) {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations: vi.fn(async () => regs) },
    });
  }

  it('unregisters a registration whose scope path is /v2/, leaves the rest alone', async () => {
    const legacy = { scope: `${location.origin}/v2/`, unregister: vi.fn(async () => true) };
    const current = { scope: `${location.origin}/ops/`, unregister: vi.fn(async () => true) };
    const other = { scope: `${location.origin}/v2evil/`, unregister: vi.fn(async () => true) };
    withRegistrations([legacy, current, other]);
    await unregisterLegacyServiceWorkers();
    expect(legacy.unregister).toHaveBeenCalledTimes(1);
    expect(current.unregister).not.toHaveBeenCalled();
    expect(other.unregister).not.toHaveBeenCalled();
  });

  it('never throws (getRegistrations rejects / unregister rejects)', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations: vi.fn(async () => { throw new Error('boom'); }) },
    });
    await expect(unregisterLegacyServiceWorkers()).resolves.toBeUndefined();
    withRegistrations([{ scope: `${location.origin}/v2/`, unregister: vi.fn(async () => { throw new Error('no'); }) }]);
    await expect(unregisterLegacyServiceWorkers()).resolves.toBeUndefined();
  });
});
