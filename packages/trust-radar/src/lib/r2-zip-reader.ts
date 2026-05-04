// R2-backed ZIP reader. Mirrors the public surface of HttpZipReader
// (open / listEntries / findEntry / streamEntry) but pulls the
// archive bytes from a Cloudflare R2 bucket instead of an HTTP
// endpoint with Range support.
//
// Use case: operator-uploaded MaxMind GeoLite2-City CSV archives
// staged in `GEOIP_STAGING`. Lets us bootstrap geo_ip_ranges without
// burning the daily MaxMind download quota — the operator downloads
// the zip via their browser session (no API quota), uploads to R2,
// then triggers `POST /api/admin/geoip/import-from-r2`.
//
// All ZIP parsing primitives (EOCD scan, central directory parse,
// local-header decoding) are shared with HttpZipReader via
// zip-internals.ts so any future ZIP-spec fix lands in one place.

import {
  type ZipEntry,
  findEocdOffset,
  parseCentralDirectory,
  parseLocalHeaderLength,
} from "./zip-internals";

export type { ZipEntry };

/** Subset of R2Bucket we use — keeps tests easy to mock. */
export interface R2BucketLike {
  head(key: string): Promise<{ size: number } | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<R2ObjectBodyLike | null>;
}

/** Subset of R2ObjectBody we use. The `body` type is intentionally
 *  loose — Cloudflare's R2ObjectBody.body is `ReadableStream<any>`
 *  shape and DecompressionStream consumes BufferSource, not the
 *  narrower Uint8Array. Keeping it `ReadableStream` (no generic)
 *  matches both the runtime and the Cloudflare type signature. */
export interface R2ObjectBodyLike {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export class R2ZipReader {
  private totalSize = 0;
  private entries: ZipEntry[] = [];

  constructor(
    private bucket: R2BucketLike,
    private key: string,
  ) {}

  /**
   * Fetch the EOCD + central directory and populate the entry list.
   * Idempotent — calling open() twice repeats the network work but
   * doesn't corrupt state.
   */
  async open(): Promise<void> {
    const headRes = await this.bucket.head(this.key);
    if (!headRes) {
      throw new Error(`R2 object not found: ${this.key}`);
    }
    if (!headRes.size || headRes.size < 22) {
      throw new Error(`Invalid R2 object size for ${this.key}: ${headRes.size}`);
    }
    this.totalSize = headRes.size;

    // Range-read the last 64KB to find the EOCD. ZIP comment is
    // capped at 64KB so this is enough.
    const tailLen = Math.min(64 * 1024, this.totalSize);
    const tailStart = this.totalSize - tailLen;
    const tail = await this.fetchRange(tailStart, tailLen, "tail");

    const eocdRel = findEocdOffset(tail);
    if (eocdRel === -1) {
      throw new Error(`EOCD signature not found in last 64KB of R2 object ${this.key}`);
    }

    // EOCD layout — central dir size at +12, offset at +16
    const cdirSize =
      (tail[eocdRel + 12] ?? 0) |
      ((tail[eocdRel + 13] ?? 0) << 8) |
      ((tail[eocdRel + 14] ?? 0) << 16) |
      ((tail[eocdRel + 15] ?? 0) << 24);
    const cdirOffset =
      ((tail[eocdRel + 16] ?? 0) |
        ((tail[eocdRel + 17] ?? 0) << 8) |
        ((tail[eocdRel + 18] ?? 0) << 16) |
        ((tail[eocdRel + 19] ?? 0) << 24)) >>>
      0;

    if (cdirOffset >= this.totalSize || cdirSize === 0) {
      throw new Error(
        `Invalid central directory offset/size: ${cdirOffset}/${cdirSize} (totalSize=${this.totalSize})`,
      );
    }

    const cdir = await this.fetchRange(cdirOffset, cdirSize, "cdir");
    this.entries = parseCentralDirectory(cdir);
    if (this.entries.length === 0) {
      throw new Error(`Central directory parsed to zero entries for R2 object ${this.key}`);
    }
  }

  /** All entries in this archive. */
  listEntries(): ZipEntry[] {
    return this.entries.slice();
  }

  /**
   * Match by full path OR basename. MaxMind nests CSVs under a
   * dated subdirectory (`GeoLite2-City-CSV_YYYYMMDD/...`), so
   * matching by basename lets callers ask for the well-known
   * filename without knowing the release date.
   */
  findEntry(nameOrBasename: string): ZipEntry | null {
    return (
      this.entries.find(
        (e) => e.name === nameOrBasename || e.name.endsWith("/" + nameOrBasename),
      ) ?? null
    );
  }

  /**
   * Stream the (decompressed) bytes of a single entry. Returns a
   * ReadableStream<Uint8Array> the caller consumes via TextDecoder
   * or pipeThrough. The stream is one-shot — call streamEntry()
   * again if you need a second pass.
   */
  async streamEntry(entry: ZipEntry): Promise<ReadableStream<Uint8Array>> {
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      throw new Error(
        `Entry ${entry.name}: compression method ${entry.compressionMethod} not supported (need 0 or 8)`,
      );
    }

    // Re-read the local file header at the entry's offset to compute
    // the actual data offset. The local header has its own filename/
    // extra-field lengths that CAN differ from the central directory's,
    // so trusting the central directory's lengths here would mis-frame
    // the data start.
    const LFH_PROBE_BYTES = 30 + 1024;
    const lfhLen = Math.min(
      LFH_PROBE_BYTES,
      this.totalSize - entry.localHeaderOffset,
    );
    const lfh = await this.fetchRange(
      entry.localHeaderOffset,
      lfhLen,
      `lfh:${entry.name}`,
    );
    const headerLen = parseLocalHeaderLength(lfh, entry.name, LFH_PROBE_BYTES);
    const dataOffset = entry.localHeaderOffset + headerLen;

    // Stream the entry body. R2's get() body is a ReadableStream so
    // we never buffer the entry whole.
    const dataRes = await this.bucket.get(this.key, {
      range: { offset: dataOffset, length: entry.compressedSize },
    });
    if (!dataRes) {
      throw new Error(`R2 range fetch returned null for ${entry.name}`);
    }
    // R2's body is a stream of bytes; the type variance between
    // R2ObjectBody.body and DecompressionStream's expected input
    // requires double-casting. Functionally identical to fetch's
    // Response.body.pipeThrough() in zip-reader.ts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bodyStream = dataRes.body as any;
    if (entry.compressionMethod === 0) {
      return bodyStream as ReadableStream<Uint8Array>;
    }
    // ZIP uses raw DEFLATE (no zlib header) — DecompressionStream
    // supports this natively as 'deflate-raw'.
    return bodyStream.pipeThrough(new DecompressionStream("deflate-raw")) as ReadableStream<Uint8Array>;
  }

  /** Helper: range-read into a Uint8Array (buffered). */
  private async fetchRange(
    offset: number,
    length: number,
    label: string,
  ): Promise<Uint8Array> {
    const res = await this.bucket.get(this.key, { range: { offset, length } });
    if (!res) {
      throw new Error(`R2 range fetch ${label} returned null for ${this.key} @ ${offset}+${length}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}
