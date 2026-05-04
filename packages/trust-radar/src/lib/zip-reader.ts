/**
 * Minimal ZIP central-directory reader for HTTP Range-fetched
 * archives. Lets a Worker read MaxMind's GeoLite2-City.zip
 * directly without staging it in R2 first.
 *
 * Most of the parsing logic is shared with `r2-zip-reader.ts` via
 * `zip-internals.ts` — this file owns the HTTP byte-fetch behavior
 * (HEAD + Range requests against `fetch()`).
 *
 * Memory profile (for the Worker scenario)
 * ────────────────────────────────────────
 * - HEAD request: ~few hundred bytes
 * - Range-read last 64KB of archive for EOCD: 64KB
 * - Range-read full central directory: usually <1MB for a few-entry
 *   archive
 * - Per-entry: stream the body through DecompressionStream — never
 *   buffered as a whole
 *
 * Total in-memory peak: ~1-2MB regardless of archive size.
 */

import {
  type ZipEntry,
  findEocdOffset,
  parseCentralDirectory,
  parseLocalHeaderLength,
  readUint32LE,
} from "./zip-internals";

export type { ZipEntry };

/** Serializable snapshot of a `HttpZipReader` after `open()`.
 *  Lets a caller (e.g. a Workflow) hand the state across step
 *  boundaries without re-fetching the central directory. Critical
 *  for upstream rate-limit hygiene: MaxMind has a daily download
 *  quota and every avoided HEAD/Range request preserves it. */
export interface HttpZipMetadata {
  url: string;
  totalSize: number;
  entries: ZipEntry[];
}

/**
 * Reader over an HTTP-accessible ZIP archive that supports Range
 * requests. The MaxMind CDN supports Range — verified against the
 * `geoip_download` endpoint in production.
 */
export class HttpZipReader {
  private url: string;
  private totalSize = 0;
  private entries: ZipEntry[] = [];

  constructor(url: string) {
    this.url = url;
  }

  /**
   * Construct a reader from a previously-captured `toMetadata()`
   * snapshot. Skips `open()` entirely — useful between Workflow
   * steps where step N has already paid the HTTP cost of finding
   * the central directory and step N+1 just needs to stream more
   * entries from the same archive.
   */
  static fromMetadata(meta: HttpZipMetadata): HttpZipReader {
    const reader = new HttpZipReader(meta.url);
    reader.totalSize = meta.totalSize;
    reader.entries = meta.entries;
    return reader;
  }

  /**
   * Snapshot of the reader's state after `open()`. Pair with
   * `fromMetadata()` to hand the discovered central directory
   * across Workflow steps.
   */
  toMetadata(): HttpZipMetadata {
    return { url: this.url, totalSize: this.totalSize, entries: this.entries.slice() };
  }

  /**
   * Fetch the EOCD + central directory and populate the entry list.
   * Idempotent — calling open() twice repeats the network work but
   * doesn't corrupt state.
   */
  async open(): Promise<void> {
    // HEAD to determine file size. MaxMind redirects to a CDN URL
    // that returns the size on HEAD.
    const headRes = await fetch(this.url, { method: 'HEAD' });
    if (!headRes.ok) {
      throw new Error(`HEAD ${this.url} → ${headRes.status}`);
    }
    const len = parseInt(headRes.headers.get('content-length') ?? '0', 10);
    if (!len || len < 22) {
      throw new Error(`Invalid content-length: ${len}`);
    }
    this.totalSize = len;

    // Range-read the last 64KB to find the EOCD. ZIP comment is
    // capped at 64KB so this is enough.
    const tailStart = Math.max(0, this.totalSize - 64 * 1024);
    const tailRes = await fetch(this.url, {
      headers: { Range: `bytes=${tailStart}-${this.totalSize - 1}` },
    });
    if (!tailRes.ok) {
      throw new Error(
        `Range tail ${this.url} → ${tailRes.status}; this CDN may not support Range requests`,
      );
    }
    const tail = new Uint8Array(await tailRes.arrayBuffer());

    const eocdRel = findEocdOffset(tail);
    if (eocdRel === -1) throw new Error('EOCD signature not found in last 64KB');

    const cdirSize = readUint32LE(tail, eocdRel + 12);
    const cdirOffset = readUint32LE(tail, eocdRel + 16);

    if (cdirOffset >= this.totalSize || cdirSize === 0) {
      throw new Error(
        `Invalid central directory offset/size: ${cdirOffset}/${cdirSize} (totalSize=${this.totalSize})`,
      );
    }

    // Range-read the central directory itself.
    const cdirRes = await fetch(this.url, {
      headers: { Range: `bytes=${cdirOffset}-${cdirOffset + cdirSize - 1}` },
    });
    if (!cdirRes.ok) {
      throw new Error(`Range cdir ${this.url} → ${cdirRes.status}`);
    }
    const cdir = new Uint8Array(await cdirRes.arrayBuffer());
    this.entries = parseCentralDirectory(cdir);
    if (this.entries.length === 0) {
      throw new Error('Central directory parsed to zero entries');
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
        (e) => e.name === nameOrBasename || e.name.endsWith('/' + nameOrBasename),
      ) ?? null
    );
  }

  /**
   * Stream the (decompressed) bytes of a single entry. Returns a
   * ReadableStream<Uint8Array> the caller consumes via TextDecoder
   * or pipeThrough. The stream is one-shot — call streamEntry()
   * again if you need a second pass.
   *
   * Memory: zero buffering of the entry body. Bytes flow through
   * fetch → DecompressionStream → caller's reader. Worker memory
   * stays flat regardless of entry size.
   */
  async streamEntry(entry: ZipEntry): Promise<ReadableStream<Uint8Array>> {
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      throw new Error(
        `Entry ${entry.name}: compression method ${entry.compressionMethod} not supported (need 0 or 8)`,
      );
    }

    // Re-read the local file header to compute the actual data
    // offset. The local header has its own filename/extra-field
    // lengths that CAN differ from the central directory's, so
    // trusting the central directory's lengths here would mis-frame
    // the data start by tens of bytes.
    //
    // We optimistically pull the LFH plus a few hundred bytes of
    // worst-case filename + extra. 30 + 1024 = 1054 bytes covers
    // any realistic entry; if that's ever short parseLocalHeaderLength
    // throws with a clear message.
    const LFH_PROBE_BYTES = 30 + 1024;
    const lfhEnd = Math.min(
      this.totalSize - 1,
      entry.localHeaderOffset + LFH_PROBE_BYTES - 1,
    );
    const lfhRes = await fetch(this.url, {
      headers: {
        Range: `bytes=${entry.localHeaderOffset}-${lfhEnd}`,
      },
    });
    if (!lfhRes.ok) {
      throw new Error(`Range lfh ${entry.name} → ${lfhRes.status}`);
    }
    const lfh = new Uint8Array(await lfhRes.arrayBuffer());
    const headerLen = parseLocalHeaderLength(lfh, entry.name, LFH_PROBE_BYTES);
    const dataOffset = entry.localHeaderOffset + headerLen;
    const dataEnd = dataOffset + entry.compressedSize - 1;

    // Stream the entry body. fetch's body is a ReadableStream so
    // we never buffer it whole.
    const dataRes = await fetch(this.url, {
      headers: { Range: `bytes=${dataOffset}-${dataEnd}` },
    });
    if (!dataRes.ok || !dataRes.body) {
      throw new Error(`Range entry ${entry.name} → ${dataRes.status}`);
    }
    if (entry.compressionMethod === 0) {
      return dataRes.body;
    }
    // ZIP uses raw DEFLATE (no zlib header) — DecompressionStream
    // supports this natively as 'deflate-raw'.
    return dataRes.body.pipeThrough(new DecompressionStream('deflate-raw'));
  }
}
