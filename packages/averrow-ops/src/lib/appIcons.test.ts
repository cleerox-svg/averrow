// @vitest-environment node
//
// PWA / notification icons (R3 facelift follow-up). Pins that every icon the
// manifest, index.html and the service worker reference exists in public/
// with the size it declares, that installed-app icons have PNG variants
// (Chrome Android / WebAPK needs PNG), and that the push badge PNG is a
// monochrome silhouette (Android draws the status-bar badge from alpha only).

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const OPS = resolve(__dirname, '../..');
const PUBLIC = join(OPS, 'public');

/** Map a /v2/... URL to its file in public/ (Vite copies public/ to /v2/). */
function publicFile(url: string): string {
  expect(url.startsWith('/v2/')).toBe(true);
  return join(PUBLIC, url.slice('/v2/'.length));
}

interface Png { width: number; height: number; colorType: number; bitDepth: number; idat: Buffer }

function readPng(path: string): Png {
  const buf = readFileSync(path);
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  let off = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (!ihdr) throw new Error(`${path}: no IHDR`);
  return {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8],
    colorType: ihdr[9],
    idat: Buffer.concat(idat),
  };
}

/** Decode an 8-bit RGBA, non-interlaced PNG to raw pixels. */
function decodeRgba(png: Png): Uint8Array {
  expect(png.bitDepth).toBe(8);
  expect(png.colorType).toBe(6);
  const bpp = 4;
  const stride = png.width * bpp;
  const raw = inflateSync(png.idat);
  const out = new Uint8Array(stride * png.height);
  for (let y = 0; y < png.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else expect(filter).toBe(0);
      out[y * stride + x] = (line[x] + pred) & 0xff;
    }
  }
  return out;
}

interface ManifestIcon { src: string; sizes: string; type: string; purpose?: string }
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.json'), 'utf8')) as { icons: ManifestIcon[] };

describe('manifest icons', () => {
  it('every icon exists on disk, and PNGs have the declared size', () => {
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const file = publicFile(icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      if (icon.type === 'image/png') {
        const [w, h] = icon.sizes.split('x').map(Number);
        const png = readPng(file);
        expect([png.width, png.height], icon.src).toEqual([w, h]);
      }
    }
  });

  it('lists PNG any 192 + 512, a 512 maskable PNG and a monochrome badge, PNGs before SVGs', () => {
    const has = (sizes: string, purpose: string) =>
      manifest.icons.some((i) => i.type === 'image/png' && i.sizes === sizes && (i.purpose ?? 'any') === purpose);
    expect(has('192x192', 'any')).toBe(true);
    expect(has('512x512', 'any')).toBe(true);
    expect(has('512x512', 'maskable')).toBe(true);
    expect(manifest.icons.some((i) => i.type === 'image/png' && i.purpose === 'monochrome')).toBe(true);
    const lastPng = manifest.icons.map((i) => i.type).lastIndexOf('image/png');
    const firstSvg = manifest.icons.map((i) => i.type).indexOf('image/svg+xml');
    expect(firstSvg === -1 || lastPng < firstSvg).toBe(true);
  });

  it('the maskable and apple-touch icons are opaque (no transparent corners)', () => {
    for (const name of ['icon-512-maskable.png', 'apple-touch-icon.png']) {
      const png = readPng(join(PUBLIC, name));
      // Colour type 2 = RGB (no alpha channel); 6 = RGBA would need a pixel scan.
      expect(png.colorType, name).toBe(2);
    }
    expect(readPng(join(PUBLIC, 'apple-touch-icon.png'))).toMatchObject({ width: 180, height: 180 });
  });
});

describe('index.html icon links', () => {
  it('apple-touch-icon is the 180px PNG and favicon links (svg + ico) resolve', () => {
    const html = readFileSync(join(OPS, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="apple-touch-icon" href="/v2/apple-touch-icon.png" />');
    const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(expect.arrayContaining(['/v2/favicon.svg', '/v2/favicon.ico']));
    for (const href of hrefs) expect(existsSync(publicFile(href)), href).toBe(true);
  });
});

describe('service worker', () => {
  const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');

  it('every precached static file exists in public/', () => {
    const block = /const SHELL_PRECACHE = \[([\s\S]*?)\];/.exec(sw);
    expect(block).not.toBeNull();
    const urls = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(urls).toEqual(expect.arrayContaining(['/v2/icon-192.png', '/v2/notification-badge.png']));
    for (const url of urls) {
      if (url === '/v2/' || url === '/v2/index.html') continue; // built by Vite, not in public/
      expect(existsSync(publicFile(url)), url).toBe(true);
    }
  });

  it('push notifications use the PNG icon and PNG badge', () => {
    expect(sw).toContain("icon: '/v2/icon-192.png'");
    expect(sw).toContain("badge: '/v2/notification-badge.png'");
  });
});

describe('notification badge', () => {
  it('is a 96x96 white-on-transparent silhouette', () => {
    const png = readPng(join(PUBLIC, 'notification-badge.png'));
    expect([png.width, png.height]).toEqual([96, 96]);
    const px = decodeRgba(png);
    let opaque = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      opaque++;
      expect([px[i], px[i + 1], px[i + 2]]).toEqual([255, 255, 255]);
    }
    // The mark is actually drawn (not an empty image).
    expect(opaque).toBeGreaterThan(96 * 96 * 0.15);
  });
});
