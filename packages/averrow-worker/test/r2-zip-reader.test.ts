/**
 * Smoke tests for R2ZipReader. Mirrors the shape of zip-reader.test.ts
 * but exercises the R2 byte-source path instead of HTTP fetch().
 *
 * These tests construct tiny in-memory ZIPs and serve them through a
 * fake R2 bucket (size + range get). The same `buildStoredZip`
 * helper from the HTTP test file would be ideal but lives outside
 * this module's import surface — duplicated locally to keep the
 * test self-contained.
 */
import { describe, it, expect } from "vitest";
import { R2ZipReader, type R2BucketLike } from "../src/lib/r2-zip-reader";

// Build a "stored" (compression method 0) single-entry ZIP from a
// filename + payload. Same shape as the HTTP test file's helper.
function buildStoredZip(name: string, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const lfh = new Uint8Array(30 + nameBytes.length);
  lfh[0] = 0x50; lfh[1] = 0x4b; lfh[2] = 0x03; lfh[3] = 0x04;
  lfh[4] = 20; lfh[5] = 0;
  lfh[6] = 0; lfh[7] = 0;
  lfh[8] = 0; lfh[9] = 0;
  lfh[10] = 0; lfh[11] = 0; lfh[12] = 0; lfh[13] = 0;
  lfh[14] = 0; lfh[15] = 0; lfh[16] = 0; lfh[17] = 0;
  const cs = payload.length;
  lfh[18] = cs & 0xff; lfh[19] = (cs >>> 8) & 0xff; lfh[20] = (cs >>> 16) & 0xff; lfh[21] = (cs >>> 24) & 0xff;
  lfh[22] = cs & 0xff; lfh[23] = (cs >>> 8) & 0xff; lfh[24] = (cs >>> 16) & 0xff; lfh[25] = (cs >>> 24) & 0xff;
  lfh[26] = nameBytes.length & 0xff; lfh[27] = (nameBytes.length >>> 8) & 0xff;
  lfh[28] = 0; lfh[29] = 0;
  lfh.set(nameBytes, 30);

  const cdh = new Uint8Array(46 + nameBytes.length);
  cdh[0] = 0x50; cdh[1] = 0x4b; cdh[2] = 0x01; cdh[3] = 0x02;
  cdh[4] = 20; cdh[5] = 0; cdh[6] = 20; cdh[7] = 0;
  cdh[8] = 0; cdh[9] = 0; cdh[10] = 0; cdh[11] = 0;
  cdh[12] = 0; cdh[13] = 0; cdh[14] = 0; cdh[15] = 0;
  cdh[16] = 0; cdh[17] = 0; cdh[18] = 0; cdh[19] = 0;
  cdh[20] = cs & 0xff; cdh[21] = (cs >>> 8) & 0xff; cdh[22] = (cs >>> 16) & 0xff; cdh[23] = (cs >>> 24) & 0xff;
  cdh[24] = cs & 0xff; cdh[25] = (cs >>> 8) & 0xff; cdh[26] = (cs >>> 16) & 0xff; cdh[27] = (cs >>> 24) & 0xff;
  cdh[28] = nameBytes.length & 0xff; cdh[29] = (nameBytes.length >>> 8) & 0xff;
  cdh[30] = 0; cdh[31] = 0; cdh[32] = 0; cdh[33] = 0;
  cdh[34] = 0; cdh[35] = 0; cdh[36] = 0; cdh[37] = 0;
  cdh[38] = 0; cdh[39] = 0; cdh[40] = 0; cdh[41] = 0;
  cdh[42] = 0; cdh[43] = 0; cdh[44] = 0; cdh[45] = 0;
  cdh.set(nameBytes, 46);

  const dataStart = lfh.length;
  const cdhStart = dataStart + payload.length;
  const eocdStart = cdhStart + cdh.length;

  const eocd = new Uint8Array(22);
  eocd[0] = 0x50; eocd[1] = 0x4b; eocd[2] = 0x05; eocd[3] = 0x06;
  eocd[4] = 0; eocd[5] = 0; eocd[6] = 0; eocd[7] = 0;
  eocd[8] = 1; eocd[9] = 0; eocd[10] = 1; eocd[11] = 0;
  const cs2 = cdh.length;
  eocd[12] = cs2 & 0xff; eocd[13] = (cs2 >>> 8) & 0xff; eocd[14] = (cs2 >>> 16) & 0xff; eocd[15] = (cs2 >>> 24) & 0xff;
  eocd[16] = cdhStart & 0xff; eocd[17] = (cdhStart >>> 8) & 0xff; eocd[18] = (cdhStart >>> 16) & 0xff; eocd[19] = (cdhStart >>> 24) & 0xff;
  eocd[20] = 0; eocd[21] = 0;

  const out = new Uint8Array(eocdStart + eocd.length);
  out.set(lfh, 0);
  out.set(payload, dataStart);
  out.set(cdh, cdhStart);
  out.set(eocd, eocdStart);
  return out;
}

interface FakeR2Object {
  size: number;
  bytes: Uint8Array;
}

/** Fake R2 bucket that serves a single key from an in-memory archive. */
function fakeBucket(key: string, archive: Uint8Array): R2BucketLike {
  const obj: FakeR2Object = { size: archive.length, bytes: archive };
  return {
    async head(k: string) {
      if (k !== key) return null;
      return { size: obj.size };
    },
    async get(k: string, options?: { range?: { offset: number; length: number } }) {
      if (k !== key) return null;
      const range = options?.range;
      const slice = range
        ? archive.slice(range.offset, range.offset + range.length)
        : archive;
      return {
        get body() {
          // ReadableStream of the slice, one chunk.
          return new ReadableStream({
            start(controller) {
              controller.enqueue(slice);
              controller.close();
            },
          }) as ReadableStream;
        },
        async arrayBuffer() {
          return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
        },
      };
    },
  };
}

describe("R2ZipReader", () => {
  it("parses a single stored entry from R2", async () => {
    const payload = new TextEncoder().encode("hello r2");
    const archive = buildStoredZip("test.txt", payload);
    const bucket = fakeBucket("upload.zip", archive);
    const zip = new R2ZipReader(bucket, "upload.zip");
    await zip.open();
    const entries = zip.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("test.txt");
    expect(entries[0]?.compressionMethod).toBe(0);
    expect(entries[0]?.uncompressedSize).toBe(8);
  });

  it("streams the bytes of a stored entry", async () => {
    const payload = new TextEncoder().encode("hello r2");
    const archive = buildStoredZip("test.txt", payload);
    const bucket = fakeBucket("upload.zip", archive);
    const zip = new R2ZipReader(bucket, "upload.zip");
    await zip.open();
    const entry = zip.findEntry("test.txt")!;
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
    expect(new TextDecoder().decode(combined)).toBe("hello r2");
  });

  it("matches by basename when entry is nested under a directory", async () => {
    const payload = new TextEncoder().encode("nested");
    const archive = buildStoredZip("GeoLite2-City-CSV_20260501/GeoLite2-City-Locations-en.csv", payload);
    const bucket = fakeBucket("upload.zip", archive);
    const zip = new R2ZipReader(bucket, "upload.zip");
    await zip.open();
    const byBasename = zip.findEntry("GeoLite2-City-Locations-en.csv");
    expect(byBasename).not.toBeNull();
    expect(byBasename?.name).toBe("GeoLite2-City-CSV_20260501/GeoLite2-City-Locations-en.csv");
  });

  it("throws a clear error when the R2 object is missing", async () => {
    const bucket = fakeBucket("upload.zip", new Uint8Array(100));
    const zip = new R2ZipReader(bucket, "missing.zip");
    await expect(zip.open()).rejects.toThrow(/R2 object not found: missing\.zip/);
  });

  it("throws when the archive is invalid (no EOCD)", async () => {
    const archive = new Uint8Array(100); // no EOCD
    const bucket = fakeBucket("upload.zip", archive);
    const zip = new R2ZipReader(bucket, "upload.zip");
    await expect(zip.open()).rejects.toThrow(/EOCD/);
  });
});
