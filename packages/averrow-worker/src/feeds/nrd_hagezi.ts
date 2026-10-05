import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";
import { logger } from "../lib/logger";

/**
 * NRD Feed — Newly Registered Domains via Hagezi's NRD 7-day list.
 *
 * Source: https://raw.githubusercontent.com/hagezi/nrd/main/domains/nrd7.txt
 * (GPL-3.0, data from Stamus Labs, regenerated daily ~06–07 UTC). ~3.1M
 * domains for the trailing 7 days (~443K/day, ~175K/day .com), ~51 MB plain
 * text (~17 MB gzip on the wire). Replaced the WhoisDS free daily ZIP on
 * 2026-10-05: WhoisDS's free tier turned out to be a uniform random 70K
 * sample of each day (prod nrd_domains held exactly 69,999 / 70,000 rows
 * per day), and every one of a 108-domain sample of those rows is present
 * in this list.
 *
 * The list is a ROLLING 7-day window with no per-domain dates, so each run
 * DIFFS today's list against the previous run's snapshot:
 *
 *   1. Conditional GET (`If-None-Match` = the snapshot's stored ETag). 304,
 *      or a `# Version:` header equal to the snapshot's, is a no-op — the
 *      feed is scheduled every 2h but the list changes once a day.
 *   2. Today's body (streamed, never materialised) and the snapshot (R2,
 *      gzip, streamed) are read as two sorted line iterators and
 *      merge-diffed; a domain present today but not in the snapshot is new.
 *      Both lists are in byte (LC_ALL=C) order, which matches JS `<` on
 *      ASCII; an out-of-order line is a format change and throws.
 *   3. New domains are flushed every NRD_FLUSH_EVERY into nrd_domains
 *      (storeNrdReference), brand-matched, and the matches inserted via
 *      bulkInsertThreats in the same flush — so memory stays bounded even
 *      if a generic brand keyword matches a large share of the day.
 *   4. Every today-line that is old (in the snapshot) or was actually
 *      flushed is gzip-streamed into the NEW snapshot as it is read. A new
 *      domain beyond the per-run cap (NRD_MAX_NEW_PER_RUN) is left OUT of
 *      the snapshot, so the next run sees it as new again: the cap DEFERS,
 *      never drops, and successive runs converge. A run that deferred
 *      anything stores no etag/version on the snapshot, so the next 2-hourly
 *      run re-diffs instead of short-circuiting on an unchanged list.
 *   5. The snapshot is PUT to R2 only after every D1 write succeeded, so a
 *      failed run leaves the old snapshot and the retry re-diffs (INSERT OR
 *      IGNORE + deterministic threatId make that idempotent).
 *
 * Daily archive (tiered retention, owner decision 2026-10-05): nrd_domains
 * keeps only ~30 days hot in D1 (lib/nrd-retention.ts), so every domain this
 * run FLUSHED (inserted — never a deferred/capped one) is also gzip-streamed
 * into an archive object in the NRD_ARCHIVE R2 bucket, at
 * `daily/<registered_date>/<version|unversioned>-<first domain>.txt.gz`
 * (nrdArchiveKey). It is PUT after every D1 write succeeded and BEFORE the
 * snapshot put: a failed archive put throws, the snapshot does not advance,
 * and the next run re-diffs, re-inserts (INSERT OR IGNORE) and rewrites the
 * same key. The first domain in the key keeps a deferral catch-up run on the
 * same list version from overwriting the previous run's object, while a
 * retry of the same set overwrites itself idempotently. Zero inserted → no
 * object. NRD_ARCHIVE unbound (staging/dev) → `nrd_hagezi_archive_unbound`
 * warning and the run continues. Bootstrap archives nothing.
 *
 * First run (no snapshot): write the snapshot only and insert nothing, so
 * the 3.1M-row window isn't dumped into D1 in one pull; the next daily list
 * then yields just the new day.
 *
 * `registered_date` is a "first listed" approximation — (list
 * `# Last modified` date − 1 day), or UTC yesterday without the header —
 * not a WHOIS creation date. Both nrd_domains readers (lib/phantom-matcher.ts,
 * lib/lookalike-nrd-matcher.ts) cursor on `created_at`; the lookalike
 * matcher reads `registered_date` only to stamp `first_seen` and to apply
 * its 30-day claim window. It is also the archive object's date partition.
 *
 * Snapshot lives in the GEOIP_STAGING R2 bucket under NRD_SNAPSHOT_KEY. The
 * GeoIP workflow only ever deletes its own staging key there, never lists
 * or sweeps the bucket.
 */

export const NRD_HAGEZI_URL = "https://raw.githubusercontent.com/hagezi/nrd/main/domains/nrd7.txt";

/** R2 key (GEOIP_STAGING bucket) of the previous run's gzip'd domain list. */
export const NRD_SNAPSHOT_KEY = "nrd/hagezi-nrd7.txt.gz";

/** Key prefix of the daily archive objects in the NRD_ARCHIVE R2 bucket. */
export const NRD_ARCHIVE_PREFIX = "daily/";

/** Replace anything outside [A-Za-z0-9._-] so a key part never adds a
 *  path segment or an awkward character to the R2 key. */
function archiveKeyPart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * R2 key (NRD_ARCHIVE bucket) of one run's archived domains:
 * `daily/<registered_date>/<version or "unversioned">-<first domain>.txt.gz`.
 */
export function nrdArchiveKey(registeredDate: string, version: string | null, firstDomain: string): string {
  const v = version ? archiveKeyPart(version) : "unversioned";
  return `${NRD_ARCHIVE_PREFIX}${archiveKeyPart(registeredDate)}/${v}-${archiveKeyPart(firstDomain)}.txt.gz`;
}

/** Max new domains inserted + matched per run (~2.3 days of list growth).
 *  The rest are deferred to the next run (kept out of the snapshot). */
export const NRD_MAX_NEW_PER_RUN = 1_000_000;

/** Timeout for the response HEADERS. The body has its own idle timeout,
 *  because the body is read across D1 flushes that can take minutes in
 *  total — a whole-request AbortSignal.timeout would abort it mid-diff. */
const FETCH_HEADERS_TIMEOUT_MS = 60_000;

/** Abort the body if no chunk arrives for this long. */
const BODY_IDLE_TIMEOUT_MS = 60_000;

/** Characters buffered before a write into the snapshot CompressionStream. */
const SNAPSHOT_WRITE_CHARS = 64 * 1024;

/** Common homoglyph substitutions for brand matching */
const HOMOGLYPHS: Record<string, string[]> = {
  l: ["1", "i"],
  o: ["0"],
  i: ["1", "l"],
  a: ["4", "@"],
  e: ["3"],
  s: ["5", "$"],
};

/**
 * Domains per INSERT statement in storeNrdReference. The rows travel as ONE
 * JSON-array bind expanded server-side by `json_each(?)`, so each statement
 * binds exactly 2 parameters regardless of row count — D1 caps a statement
 * at 100 bound parameters (the old `VALUES (?, ?)×500` form bound 1000 and
 * every pull died with "too many SQL variables at offset 418"). 1000 NRDs
 * ≈ 25–30 KB of JSON: far under D1's 2 MB value cap and its 100 KB SQL-text
 * cap (the JSON is a bound value, not SQL text).
 */
export const NRD_DOMAINS_PER_STATEMENT = 1000;

/**
 * Statements per `db.batch()` call. One batch = one D1 round-trip (one
 * subrequest) and one implicit transaction: 20 × 1000 = 20K rows/call, so a
 * ~443K-domain day is ~23 calls.
 */
export const NRD_STATEMENTS_PER_BATCH = 20;

/** New domains buffered before a storeNrdReference + brand-match flush:
 *  exactly one db.batch() call per flush. */
export const NRD_FLUSH_EVERY = NRD_DOMAINS_PER_STATEMENT * NRD_STATEMENTS_PER_BATCH;

export interface NrdIngestOptions {
  /** Override NRD_MAX_NEW_PER_RUN (tests). */
  maxNewPerRun?: number;
  /** Override NRD_FLUSH_EVERY (tests). */
  flushEvery?: number;
}

type BrandKeyword = { id: string; domain: string; needles: string[] };

export const nrd_hagezi: FeedModule = {
  ingest: (ctx) => ingestNrdHagezi(ctx),
};

const NOOP: FeedResult = { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };

/** Feed body, with test-tunable limits. */
export async function ingestNrdHagezi(ctx: FeedContext, opts: NrdIngestOptions = {}): Promise<FeedResult> {
  const maxNew = opts.maxNewPerRun ?? NRD_MAX_NEW_PER_RUN;
  const flushEvery = opts.flushEvery ?? NRD_FLUSH_EVERY;
  const bucket = ctx.env.GEOIP_STAGING;
  if (!bucket) {
    throw new Error(
      `NRD Hagezi: GEOIP_STAGING (R2) binding not configured — the diff snapshot is stored at ${NRD_SNAPSHOT_KEY} in that bucket`,
    );
  }

  const prevHead = await bucket.head(NRD_SNAPSHOT_KEY);
  const prevMeta = prevHead?.customMetadata ?? {};

  const res = await fetchList(prevHead ? prevMeta.etag : undefined);
  if (res.status === 304) {
    await cancelBody(res);
    logger.info("nrd_hagezi_not_modified", { etag: prevMeta.etag ?? null, version: prevMeta.version ?? null });
    return { ...NOOP };
  }
  if (!res.ok) {
    await cancelBody(res);
    throw new Error(`NRD Hagezi: list fetch returned HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error("NRD Hagezi: list response has no body");
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (/text\/html/i.test(contentType)) {
    await cancelBody(res);
    throw new Error(`NRD Hagezi: expected a plain-text domain list, got content-type "${contentType}"`);
  }

  const today = new SortedDomainReader(lineReader(res.body.pipeThrough(new TextDecoderStream()), BODY_IDLE_TIMEOUT_MS), "list");
  let prev: SortedDomainReader | null = null;
  const snapshot = new SnapshotWriter();
  let archive: SnapshotWriter | null = null;

  try {
    const header = await today.readHeader();
    const etag = res.headers.get("etag");

    if (prevHead && header.version !== null && header.version === (prevMeta.version ?? null)) {
      logger.info("nrd_hagezi_same_version", { version: header.version });
      return { ...NOOP };
    }

    const registeredDate = registeredDateFromHeader(header.lastModified);

    // ── Bootstrap: no snapshot → write it, insert nothing. ──
    if (!prevHead) {
      let lines = 0;
      for (let d = await today.next(); d !== null; d = await today.next()) {
        lines++;
        await snapshot.add(d);
      }
      assertListShape(lines, today.contentLines, header);
      await bucket.put(NRD_SNAPSHOT_KEY, await snapshot.finish(), {
        customMetadata: snapshotMetadata(etag, header, 0),
      });
      logger.info("nrd_hagezi_bootstrap", { lines, version: header.version, snapshotKey: NRD_SNAPSHOT_KEY });
      return { itemsFetched: lines, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    const prevObj = await bucket.get(NRD_SNAPSHOT_KEY);
    if (!prevObj) {
      throw new Error(`NRD Hagezi: snapshot ${NRD_SNAPSHOT_KEY} vanished between head() and get() — retry`);
    }
    prev = new SortedDomainReader(
      lineReader(prevObj.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()), 0),
      `snapshot ${NRD_SNAPSHOT_KEY} (delete that R2 object to re-bootstrap)`,
      (err) => {
        logger.error("nrd_hagezi_snapshot_unreadable", {
          key: NRD_SNAPSHOT_KEY,
          error: err instanceof Error ? err.message : String(err),
        });
        // Keep the runtime cause (never upstream text) so a transient R2 read
        // drop isn't mistaken for corruption — deleting a good snapshot loses
        // every domain first listed since it was written.
        const cause = err instanceof Error ? err.message : String(err);
        return new Error(
          `NRD Hagezi: snapshot ${NRD_SNAPSHOT_KEY} could not be decompressed/read (${cause.slice(0, 120)}) — usually transient, the next run retries; only if this repeats across runs (corrupt or not gzip), delete that object from the GEOIP_STAGING R2 bucket to re-bootstrap`,
        );
      },
    );

    const archiveBucket = ctx.env.NRD_ARCHIVE;
    // Only buffer the archive when there is somewhere to put it.
    archive = archiveBucket ? new SnapshotWriter() : null;
    let archiveFirst: string | null = null;
    let archived = 0;

    const matcher = new BrandMatcher(await loadBrandKeywords(ctx.env.DB));
    // Carried across flushes so an in-list repeat split over two chunks is
    // still one threat + one in-payload duplicate.
    const matched = new Set<string>();
    const totals = { matches: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    let pending: string[] = [];
    let lines = 0;
    let newTotal = 0;
    let newInserted = 0;

    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      await storeNrdReference(ctx.env.DB, pending, registeredDate);
      // Archive exactly what was flushed (never a deferred domain).
      if (archive) {
        for (const d of pending) await archive.add(d);
        archiveFirst ??= pending[0]!;
      }
      archived += pending.length;
      if (!matcher.empty) {
        const { rows, inPayloadDuplicates } = matcher.collect(pending, matched);
        // Dedup is the deterministic per-feed threatId PK (INSERT OR IGNORE);
        // bulkInsertThreats bumps brands.threat_count only for rows that
        // landed. No KV dedup keys are read or written by this feed.
        const r = await bulkInsertThreats(ctx.env.DB, rows);
        totals.matches += rows.length;
        totals.itemsNew += r.itemsNew;
        totals.itemsDuplicate += r.itemsDuplicate + inPayloadDuplicates;
        totals.itemsError += r.itemsError;
      }
      pending = [];
    };

    // ── Merge-diff: emit today-lines absent from the snapshot. ──
    let p = await prev.next();
    for (let d = await today.next(); d !== null; d = await today.next()) {
      lines++;
      while (p !== null && p < d) p = await prev.next();
      if (p === d) {
        await snapshot.add(d);
        continue;
      }
      newTotal++;
      // Over the cap: leave it OUT of the new snapshot so the next run sees
      // it as new again (deferred, not dropped).
      if (newInserted >= maxNew) continue;
      newInserted++;
      await snapshot.add(d);
      pending.push(d);
      if (pending.length >= flushEvery) await flush();
    }
    await flush();
    assertListShape(lines, today.contentLines, header);
    const { itemsNew, itemsDuplicate, itemsError } = totals;
    const deferred = newTotal - newInserted;

    if (deferred > 0) {
      logger.warn("nrd_hagezi_deferred", { newTotal, inserted: newInserted, deferred, cap: maxNew });
    }

    // Snapshot advances only when every D1 write landed. A failed threat
    // chunk (bulkInsertThreats reports it as itemsError rather than throwing)
    // must keep the old snapshot, or those matches would never be retried.
    if (itemsError > 0) {
      logger.warn("nrd_hagezi_snapshot_held", { reason: "threat_insert_errors", itemsError, version: header.version });
    } else {
      // Archive BEFORE the snapshot: if this put throws, the snapshot stays
      // put and the next run re-diffs + rewrites the same archive key.
      if (archived > 0) {
        if (archiveBucket && archive && archiveFirst !== null) {
          const archiveKey = nrdArchiveKey(registeredDate, header.version, archiveFirst);
          await archiveBucket.put(archiveKey, await archive.finish(), {
            httpMetadata: { contentType: "application/gzip" },
            customMetadata: {
              count: String(archived),
              version: header.version ?? "unversioned",
              list_modified: header.lastModified ?? "",
              registered_date: registeredDate,
            },
          });
          logger.info("nrd_hagezi_archived", { key: archiveKey, count: archived });
        } else {
          logger.warn("nrd_hagezi_archive_unbound", { domains: archived, registeredDate, version: header.version });
        }
      }
      await bucket.put(NRD_SNAPSHOT_KEY, await snapshot.finish(), {
        customMetadata: snapshotMetadata(etag, header, deferred),
      });
    }

    logger.info("nrd_hagezi_diffed", {
      version: header.version,
      registeredDate,
      lines,
      newTotal,
      newInserted,
      deferred,
      matches: totals.matches,
      itemsNew,
      itemsDuplicate,
      itemsError,
    });

    return { itemsFetched: lines, itemsNew, itemsDuplicate, itemsError };
  } finally {
    snapshot.abort();
    archive?.abort();
    await today.cancel();
    if (prev) await prev.cancel();
  }
}

async function fetchList(etag: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": "Averrow-ThreatIntel/1.0" };
  if (etag) headers["If-None-Match"] = etag;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_HEADERS_TIMEOUT_MS);
  try {
    return await fetch(NRD_HAGEZI_URL, { headers, signal: controller.signal });
  } catch (err) {
    const reason = controller.signal.aborted
      ? `no response within ${FETCH_HEADERS_TIMEOUT_MS / 1000}s`
      : err instanceof Error ? err.message : String(err);
    throw new Error(`NRD Hagezi: list fetch failed — ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

async function cancelBody(res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* already closed */ }
}

async function loadBrandKeywords(db: D1Database): Promise<BrandKeyword[]> {
  const brands = await db.prepare(
    `SELECT b.id, b.name, b.canonical_domain
     FROM brands b
     INNER JOIN monitored_brands mb ON mb.brand_id = b.id
     WHERE mb.status = 'active'`
  ).all<{ id: string; name: string; canonical_domain: string }>();

  // Deduped by brand id (a brand monitored by several tenants appears once
  // per monitored_brands row); homoglyph variants precomputed once per brand.
  const seenBrandIds = new Set<string>();
  const brandKeywords: BrandKeyword[] = [];
  for (const b of brands.results) {
    if (seenBrandIds.has(b.id)) continue;
    seenBrandIds.add(b.id);
    const needles = brandNeedles(b.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    // A keyword under 3 chars can never match.
    if (needles.length === 0) continue;
    brandKeywords.push({ id: b.id, domain: b.canonical_domain.toLowerCase(), needles });
  }
  return brandKeywords;
}

// ─── List header ─────────────────────────────────────────────────────

export interface NrdListHeader {
  version: string | null;
  /** Raw `# Last modified:` value, e.g. "05 Oct 2026 06:11 UTC". */
  lastModified: string | null;
  /** `# Number of entries:` value. */
  entries: number | null;
}

function parseHeaderLine(line: string, h: NrdListHeader): void {
  const m = /^#\s*([^:]+):\s*(.*)$/.exec(line);
  if (!m) return;
  const key = m[1]!.trim().toLowerCase();
  const value = m[2]!.trim();
  if (key === "version") h.version = value || null;
  else if (key === "last modified") h.lastModified = value || null;
  else if (key === "number of entries") {
    const n = Number(value.replace(/[,_\s]/g, ""));
    h.entries = Number.isFinite(n) ? n : null;
  }
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * registered_date for rows from this list: the list's `Last modified` UTC
 * date minus one day (the list is regenerated each morning from the previous
 * day's registrations), else UTC yesterday. Exported for tests.
 */
export function registeredDateFromHeader(lastModified: string | null, now: Date = new Date()): string {
  const m = lastModified ? /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/.exec(lastModified.trim()) : null;
  const month = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
  const base = m && month !== undefined
    ? new Date(Date.UTC(Number(m[3]), month, Number(m[1])))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  base.setUTCDate(base.getUTCDate() - 1);
  return base.toISOString().slice(0, 10);
}

/**
 * Snapshot customMetadata. When the run deferred domains (per-run cap), the
 * etag/version are deliberately omitted: the snapshot is then NOT a complete
 * image of that list version, so the next run must neither send
 * If-None-Match nor take the same-version shortcut — it re-diffs and picks
 * up the deferred domains.
 */
function snapshotMetadata(etag: string | null, header: NrdListHeader, deferred: number): Record<string, string> {
  const meta: Record<string, string> = {};
  if (deferred === 0) {
    if (etag) meta.etag = etag;
    if (header.version) meta.version = header.version;
  } else {
    meta.deferred = String(deferred);
  }
  if (header.lastModified) meta.list_modified = header.lastModified;
  return meta;
}

/**
 * Integrity checks once the whole list has been read. An empty list never
 * succeeds silently, and a body shorter than its own `Number of entries`
 * header (a truncated download) fails before the snapshot is replaced.
 *
 * Wording is deliberate (and never includes upstream text): none of these match autoPauseFeed's permanent-error
 * taxonomy (lib/feedRunner.ts — 404/410, "upstream archived", "no longer
 * publishes", "Gone", "served no data on N consecutive days"). An empty or
 * short list from a daily-regenerated GitHub file is a bad build, not a dead
 * source, so it stays `auto:consecutive_failures` and the 4h sweep revives it.
 */
function assertListShape(lines: number, contentLines: number, header: NrdListHeader): void {
  if (lines === 0) {
    throw new Error(
      `NRD Hagezi: list contained zero domains (version ${header.version ?? "unknown"}) — refusing to treat an empty list as success`,
    );
  }
  // Compared against RAW non-comment, non-blank lines (not the post-filter
  // domain count), so an entry the domain filter skips can't trip it.
  if (header.entries !== null && header.entries !== contentLines) {
    throw new Error(
      `NRD Hagezi: list body has ${contentLines} entries but its header declares ${header.entries} — truncated or malformed download`,
    );
  }
}

// ─── Streaming line readers ──────────────────────────────────────────

interface LineReader {
  next(): Promise<string | null>;
  cancel(): Promise<void>;
}

/** Split a text stream into lines without buffering it whole. `idleMs` > 0
 *  aborts when no chunk arrives within that window. */
function lineReader(stream: ReadableStream<string>, idleMs: number): LineReader {
  const reader = stream.getReader();
  let buf = "";
  let lines: string[] = [];
  let idx = 0;
  let done = false;

  const read = async (): Promise<ReadableStreamReadResult<string>> => {
    if (idleMs <= 0) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`NRD Hagezi: list body stalled — no data for ${idleMs / 1000}s`)),
        idleMs,
      );
    });
    try {
      return await Promise.race([reader.read(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async next() {
      for (;;) {
        if (idx < lines.length) return lines[idx++]!;
        if (done) {
          if (buf.length > 0) { const last = buf; buf = ""; return last; }
          return null;
        }
        const { done: d, value } = await read();
        if (d) { done = true; continue; }
        buf += value;
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        lines = parts;
        idx = 0;
      }
    },
    async cancel() {
      try { await reader.cancel(); } catch { /* already closed/errored */ }
    },
  };
}

/**
 * Yields normalised domains (trimmed, lowercased, must contain a '.') in
 * non-decreasing order; skips `#` comment and blank lines. Throws on an
 * out-of-order line — the merge-diff is only correct over sorted input — or
 * on an HTML/markup first line. Equal adjacent lines are allowed (counted as
 * in-payload duplicates downstream).
 */
class SortedDomainReader {
  private last: string | null = null;
  private pendingFirst: string | null = null;
  private seenContent = false;
  /** Raw non-comment, non-blank lines seen (before the '.' filter). */
  contentLines = 0;

  /**
   * `label` must be FIXED text — it goes into thrown messages, which
   * autoPauseFeed pattern-matches; upstream content is only ever logged.
   * `onReadError` maps a stream read failure to a precise error.
   */
  constructor(
    private readonly lines: LineReader,
    private readonly label: string,
    private readonly onReadError?: (err: unknown) => Error,
  ) {}

  private async readLine(): Promise<string | null> {
    if (!this.onReadError) return this.lines.next();
    try {
      return await this.lines.next();
    } catch (err) {
      throw this.onReadError(err);
    }
  }

  /** Consume leading `#` lines; stops at (and buffers) the first other line. */
  async readHeader(): Promise<NrdListHeader> {
    const h: NrdListHeader = { version: null, lastModified: null, entries: null };
    for (let raw = await this.readLine(); raw !== null; raw = await this.readLine()) {
      const line = raw.trim();
      if (line === "") continue;
      if (line.startsWith("#")) { parseHeaderLine(line, h); continue; }
      this.pendingFirst = raw;
      break;
    }
    return h;
  }

  async next(): Promise<string | null> {
    for (;;) {
      let raw: string | null;
      if (this.pendingFirst !== null) { raw = this.pendingFirst; this.pendingFirst = null; }
      else raw = await this.readLine();
      if (raw === null) return null;
      const line = raw.trim().toLowerCase();
      if (line === "" || line.startsWith("#")) continue;
      this.contentLines++;
      if (!this.seenContent) {
        this.seenContent = true;
        if (line.startsWith("<")) {
          logger.error("nrd_hagezi_html_body", { source: this.label, snippet: raw.trim().slice(0, 200) });
          throw new Error(`NRD Hagezi: ${this.label} is HTML/markup, not a domain list`);
        }
      }
      if (!line.includes(".")) continue;
      if (this.last !== null && line < this.last) {
        logger.error("nrd_hagezi_out_of_order", {
          source: this.label,
          line: line.slice(0, 200),
          previous: this.last.slice(0, 200),
          lineIndex: this.contentLines,
        });
        throw new Error(
          `NRD Hagezi: ${this.label} is not sorted — source format changed; the merge-diff requires byte-sorted input`,
        );
      }
      this.last = line;
      return line;
    }
  }

  cancel(): Promise<void> {
    return this.lines.cancel();
  }
}

/**
 * Streams lines into a gzip CompressionStream (used for both the diff
 * snapshot and the daily archive object), draining its readable
 * concurrently (awaiting write() without a reader deadlocks on backpressure)
 * into in-memory chunks; `finish()` returns them as a Blob for the R2 put.
 * Peak is still ~2× the ~17 MB gzip (the Blob copies its parts).
 */
class SnapshotWriter {
  private readonly cs = new CompressionStream("gzip");
  private readonly writer = this.cs.writable.getWriter();
  private readonly encoder = new TextEncoder();
  private readonly chunks: Array<Uint8Array<ArrayBuffer>> = [];
  private readonly drained: Promise<void>;
  private buf = "";
  private finished = false;

  constructor() {
    const reader = this.cs.readable.getReader();
    this.drained = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        // Always a plain ArrayBuffer in practice; the guard satisfies the
        // BlobPart type without copying (SharedArrayBuffer → copy).
        if (value) this.chunks.push(isArrayBufferBacked(value) ? value : new Uint8Array(value));
      }
    })();
    // Abort path rejects `drained`; observe it so it is never unhandled.
    this.drained.catch(() => undefined);
  }

  async add(domain: string): Promise<void> {
    this.buf += domain + "\n";
    if (this.buf.length >= SNAPSHOT_WRITE_CHARS) {
      const out = this.buf;
      this.buf = "";
      await this.writer.write(this.encoder.encode(out));
    }
  }

  async finish(): Promise<Blob> {
    if (this.buf.length > 0) {
      await this.writer.write(this.encoder.encode(this.buf));
      this.buf = "";
    }
    await this.writer.close();
    await this.drained;
    this.finished = true;
    const out = new Blob(this.chunks);
    this.chunks.length = 0;
    return out;
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.writer.abort().catch(() => undefined);
  }
}

function isArrayBufferBacked(u: Uint8Array): u is Uint8Array<ArrayBuffer> {
  return u.buffer instanceof ArrayBuffer;
}

// ─── Brand matching ─────────────────────────────────────────────────

/**
 * Needle-indexed brand matcher. Semantics are identical to the naive
 * domains × brands × needles `includes` scan (pinned by a property test):
 * for each domain the LOWEST-index brand (in `brandKeywords` order) with a
 * needle that is a substring of the domain wins, except that a brand never
 * matches its own canonical domain (which then falls through to the next
 * brand). Instead of scanning every brand, each domain's substrings of every
 * distinct needle length are looked up in a Map<needle, brandIndex[]>, so the
 * cost is ~O(domain length × distinct needle lengths), independent of the
 * brand count.
 */
class BrandMatcher {
  private readonly index = new Map<string, number[]>();
  private readonly lengths: number[];
  /** Brands holding an empty needle (`includes("")` is always true). */
  private readonly always: number[] = [];

  constructor(private readonly brands: BrandKeyword[]) {
    const lengths = new Set<number>();
    brands.forEach((b, bi) => {
      for (const n of b.needles) {
        if (n.length === 0) {
          if (this.always[this.always.length - 1] !== bi) this.always.push(bi);
          continue;
        }
        let list = this.index.get(n);
        if (!list) { list = []; this.index.set(n, list); }
        // Brands are visited in ascending order, so lists stay sorted.
        if (list[list.length - 1] !== bi) list.push(bi);
        lengths.add(n.length);
      }
    });
    this.lengths = [...lengths].sort((a, b) => a - b);
  }

  get empty(): boolean {
    return this.brands.length === 0;
  }

  /** Index of the winning brand for `domain`, or -1. */
  private bestBrand(domain: string): number {
    let best = Number.MAX_SAFE_INTEGER;
    const consider = (list: number[]): void => {
      for (const bi of list) {
        if (bi >= best) return;
        if (this.brands[bi]!.domain !== domain) { best = bi; return; }
      }
    };
    consider(this.always);
    for (const len of this.lengths) {
      if (len > domain.length) break;
      for (let i = 0; i + len <= domain.length; i++) {
        const list = this.index.get(domain.substring(i, i + len));
        if (list) consider(list);
        if (best === 0) return 0;
      }
    }
    return best === Number.MAX_SAFE_INTEGER ? -1 : best;
  }

  collect(domains: string[], matched: Set<string>): { rows: ThreatRow[]; inPayloadDuplicates: number } {
    const rows: ThreatRow[] = [];
    let inPayloadDuplicates = 0;
    for (const domain of domains) {
      const bi = this.bestBrand(domain);
      if (bi < 0) continue;
      if (matched.has(domain)) { inPayloadDuplicates++; continue; }
      matched.add(domain);
      rows.push({
        id: threatId("nrd_hagezi", "domain", domain),
        source_feed: "nrd_hagezi",
        threat_type: "typosquatting",
        malicious_url: null,
        malicious_domain: domain,
        target_brand_id: this.brands[bi]!.id,
        ioc_value: domain,
        severity: "medium",
        confidence_score: 60,
      });
    }
    return { rows, inPayloadDuplicates };
  }
}

/**
 * Pure domain × brand match pass — no I/O. One row per distinct matched
 * domain: the FIRST brand (in `brandKeywords` order) whose needles hit wins,
 * a brand's own canonical domain never matches that brand, and a domain
 * repeated in the list counts as an in-payload duplicate. Pass `matched` to
 * carry the seen-set across chunks of one run (the feed does).
 *
 * Exported for unit tests.
 */
export function collectBrandMatchRows(
  domains: string[],
  brandKeywords: Array<{ id: string; domain: string; needles: string[] }>,
  matched: Set<string> = new Set<string>(),
): { rows: ThreatRow[]; inPayloadDuplicates: number } {
  return new BrandMatcher(brandKeywords).collect(domains, matched);
}

/**
 * Store NRDs in the reference table for later analysis (phantom matcher,
 * infrastructure correlation). INSERT OR IGNORE keeps re-runs (and in-list
 * duplicates) idempotent: the first registered_date written for a domain
 * wins.
 *
 * Exported for the D1 bind-limit regression test.
 */
export async function storeNrdReference(db: D1Database, domains: string[], date: string): Promise<void> {
  // Ensure reference table exists
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS nrd_domains (
      domain TEXT PRIMARY KEY,
      registered_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      brand_matched INTEGER DEFAULT 0
    )
  `).run();

  // json_each yields rows in array order, so in-statement duplicates resolve
  // first-wins under OR IGNORE — identical to the old multi-row VALUES list.
  const insertSql =
    `INSERT OR IGNORE INTO nrd_domains (domain, registered_date)
     SELECT value, ? FROM json_each(?)`;

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < domains.length; i += NRD_DOMAINS_PER_STATEMENT) {
    const chunk = domains.slice(i, i + NRD_DOMAINS_PER_STATEMENT);
    stmts.push(db.prepare(insertSql).bind(date, JSON.stringify(chunk)));
  }
  for (let i = 0; i < stmts.length; i += NRD_STATEMENTS_PER_BATCH) {
    await db.batch(stmts.slice(i, i + NRD_STATEMENTS_PER_BATCH));
  }

  logger.info("nrd_reference_stored", { domains: domains.length, date, statements: stmts.length });
}

/**
 * Every substring that counts as a brand hit: the keyword itself followed by
 * its homoglyph variants. Empty for keywords under 3 chars (false-positive
 * guard). Computed once per brand per run.
 */
function brandNeedles(keyword: string): string[] {
  if (keyword.length < 3) return [];
  return [keyword, ...generateHomoglyphVariants(keyword)];
}

/** Generate simple homoglyph variants of a keyword */
function generateHomoglyphVariants(keyword: string): string[] {
  const variants: string[] = [];
  for (let i = 0; i < keyword.length; i++) {
    const char = keyword[i]!;
    const subs = HOMOGLYPHS[char];
    if (subs) {
      for (const sub of subs) {
        variants.push(keyword.slice(0, i) + sub + keyword.slice(i + 1));
      }
    }
  }
  return variants;
}
