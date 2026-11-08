// @vitest-environment node
//
// Tenant favicon / home-screen icon (R3 facelift follow-up). The tenant app
// has no manifest or service worker; index.html links the R3 favicon (svg +
// ico) and a 180px apple-touch-icon from public/, which Vite copies to /tenant/.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TENANT = resolve(__dirname, '../..');

describe('tenant icon links', () => {
  const html = readFileSync(join(TENANT, 'index.html'), 'utf8');
  const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);

  it('links the R3 favicon (svg + ico) and apple-touch-icon', () => {
    expect(hrefs).toEqual(expect.arrayContaining([
      '/tenant/favicon.svg', '/tenant/favicon.ico', '/tenant/apple-touch-icon.png',
    ]));
  });

  it('every linked icon exists in public/', () => {
    for (const href of hrefs) {
      expect(href.startsWith('/tenant/')).toBe(true);
      expect(existsSync(join(TENANT, 'public', href.slice('/tenant/'.length))), href).toBe(true);
    }
  });

  it('apple-touch-icon is a 180x180 opaque PNG', () => {
    const buf = readFileSync(join(TENANT, 'public/apple-touch-icon.png'));
    expect(buf.toString('ascii', 12, 16)).toBe('IHDR');
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([180, 180]);
    expect(buf[25]).toBe(2); // colour type RGB: no alpha channel
  });
});
