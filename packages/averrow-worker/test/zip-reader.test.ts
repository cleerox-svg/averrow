/**
 * Smoke tests for the minimal ZIP reader. Constructs tiny in-memory
 * ZIP archives and verifies central-directory parsing + entry
 * streaming round-trips correctly. Doesn't exercise the HTTP Range
 * path against MaxMind — that lives in integration tests against
 * a real archive when ops bandwidth is available.
 */
import { describe, it, expect } from 'vitest';
import { HttpZipReader } from '../src/lib/zip-reader';

// Build a "stored" (compression method 0) single-entry ZIP from a
// filename + payload. Simplest valid archive — lets us test
// central-directory parsing without DEFLATE.
function buildStoredZip(name: string, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const lfh = new Uint8Array(30 + nameBytes.length);
  // PK\x03\x04
  lfh[0] = 0x50; lfh[1] = 0x4b; lfh[2] = 0x03; lfh[3] = 0x04;
  // version needed
  lfh[4] = 20; lfh[5] = 0;
  // gp flag
  lfh[6] = 0; lfh[7] = 0;
  // compression method 0 (stored)
  lfh[8] = 0; lfh[9] = 0;
  // mod time/date
  lfh[10] = 0; lfh[11] = 0; lfh[12] = 0; lfh[13] = 0;
  // CRC-32 (we don't validate)
  lfh[14] = 0; lfh[15] = 0; lfh[16] = 0; lfh[17] = 0;
  // compressed size
  const cs = payload.length;
  lfh[18] = cs & 0xff; lfh[19] = (cs >>> 8) & 0xff; lfh[20] = (cs >>> 16) & 0xff; lfh[21] = (cs >>> 24) & 0xff;
  // uncompressed size
  lfh[22] = cs & 0xff; lfh[23] = (cs >>> 8) & 0xff; lfh[24] = (cs >>> 16) & 0xff; lfh[25] = (cs >>> 24) & 0xff;
  // filename length
  lfh[26] = nameBytes.length & 0xff; lfh[27] = (nameBytes.length >>> 8) & 0xff;
  // extra length
  lfh[28] = 0; lfh[29] = 0;
  lfh.set(nameBytes, 30);

  const cdh = new Uint8Array(46 + nameBytes.length);
  // PK\x01\x02
  cdh[0] = 0x50; cdh[1] = 0x4b; cdh[2] = 0x01; cdh[3] = 0x02;
  cdh[4] = 20; cdh[5] = 0; cdh[6] = 20; cdh[7] = 0;
  cdh[8] = 0; cdh[9] = 0; cdh[10] = 0; cdh[11] = 0;  // method 0
  cdh[12] = 0; cdh[13] = 0; cdh[14] = 0; cdh[15] = 0;
  cdh[16] = 0; cdh[17] = 0; cdh[18] = 0; cdh[19] = 0; // crc
  cdh[20] = cs & 0xff; cdh[21] = (cs >>> 8) & 0xff; cdh[22] = (cs >>> 16) & 0xff; cdh[23] = (cs >>> 24) & 0xff;
  cdh[24] = cs & 0xff; cdh[25] = (cs >>> 8) & 0xff; cdh[26] = (cs >>> 16) & 0xff; cdh[27] = (cs >>> 24) & 0xff;
  cdh[28] = nameBytes.length & 0xff; cdh[29] = (nameBytes.length >>> 8) & 0xff;
  cdh[30] = 0; cdh[31] = 0; // extra
  cdh[32] = 0; cdh[33] = 0; // comment
  cdh[34] = 0; cdh[35] = 0; // disk
  cdh[36] = 0; cdh[37] = 0; // internal attrs
  cdh[38] = 0; cdh[39] = 0; cdh[40] = 0; cdh[41] = 0; // external attrs
  // local header offset = 0
  cdh[42] = 0; cdh[43] = 0; cdh[44] = 0; cdh[45] = 0;
  cdh.set(nameBytes, 46);

  const lfhStart = 0;
  const dataStart = lfh.length;
  const cdhStart = dataStart + payload.length;
  const eocdStart = cdhStart + cdh.length;

  const eocd = new Uint8Array(22);
  eocd[0] = 0x50; eocd[1] = 0x4b; eocd[2] = 0x05; eocd[3] = 0x06;
  eocd[4] = 0; eocd[5] = 0; // disk
  eocd[6] = 0; eocd[7] = 0; // disk start
  eocd[8] = 1; eocd[9] = 0; // entries on disk
  eocd[10] = 1; eocd[11] = 0; // total entries
  // central dir size
  const cs2 = cdh.length;
  eocd[12] = cs2 & 0xff; eocd[13] = (cs2 >>> 8) & 0xff; eocd[14] = (cs2 >>> 16) & 0xff; eocd[15] = (cs2 >>> 24) & 0xff;
  // central dir offset
  eocd[16] = cdhStart & 0xff; eocd[17] = (cdhStart >>> 8) & 0xff; eocd[18] = (cdhStart >>> 16) & 0xff; eocd[19] = (cdhStart >>> 24) & 0xff;
  eocd[20] = 0; eocd[21] = 0; // comment len

  const out = new Uint8Array(eocdStart + eocd.length);
  out.set(lfh, lfhStart);
  out.set(payload, dataStart);
  out.set(cdh, cdhStart);
  out.set(eocd, eocdStart);
  return out;
}

// Stub fetch impl that serves Range requests against an in-memory
// Uint8Array. Patches the global `fetch` for the duration of a test
// then restores it.
function withMockFetch<T>(
  archive: Uint8Array,
  fn: (zip: HttpZipReader) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { 'content-length': String(archive.length) },
      });
    }
    const range = init?.headers && (init.headers as Record<string, string>)['Range'];
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d+)/);
      if (!m) throw new Error(`bad range: ${range}`);
      const start = parseInt(m[1]!, 10);
      const end = parseInt(m[2]!, 10);
      const slice = archive.slice(start, end + 1);
      return new Response(slice, { status: 206 });
    }
    return new Response(archive, { status: 200 });
  };
  return fn(new HttpZipReader('https://example.invalid/archive.zip')).finally(() => {
    globalThis.fetch = original;
  });
}

describe('HttpZipReader', () => {
  it('parses a single stored entry', async () => {
    const payload = new TextEncoder().encode('hello world');
    const archive = buildStoredZip('test.txt', payload);
    await withMockFetch(archive, async (zip) => {
      await zip.open();
      const entries = zip.listEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe('test.txt');
      expect(entries[0]?.compressionMethod).toBe(0);
      expect(entries[0]?.uncompressedSize).toBe(11);
    });
  });

  it('streams the bytes of a stored entry', async () => {
    const payload = new TextEncoder().encode('hello world');
    const archive = buildStoredZip('test.txt', payload);
    await withMockFetch(archive, async (zip) => {
      await zip.open();
      const entry = zip.findEntry('test.txt')!;
      const stream = await zip.streamEntry(entry);
      const reader = stream.getReader();
      let combined = new Uint8Array(0);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const merged = new Uint8Array(combined.length + value.length);
        merged.set(combined, 0);
        merged.set(value, combined.length);
        combined = merged;
      }
      expect(new TextDecoder().decode(combined)).toBe('hello world');
    });
  });

  it('matches by basename when entry is nested under a directory', async () => {
    const payload = new TextEncoder().encode('nested');
    const archive = buildStoredZip('GeoLite2-City-CSV_20260501/test.txt', payload);
    await withMockFetch(archive, async (zip) => {
      await zip.open();
      const byBasename = zip.findEntry('test.txt');
      expect(byBasename).not.toBeNull();
      expect(byBasename?.name).toBe('GeoLite2-City-CSV_20260501/test.txt');
    });
  });

  it('throws when the archive is invalid', async () => {
    const archive = new Uint8Array(100); // no EOCD
    await expect(
      withMockFetch(archive, async (zip) => {
        await zip.open();
      }),
    ).rejects.toThrow(/EOCD/);
  });
});
