import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";
import { logger } from "../lib/logger";
import {
  findEocdOffset,
  parseCentralDirectory,
  parseLocalHeaderLength,
  readUint32LE,
} from "../lib/zip-internals";

const WHOISDS_BASE_URL = "https://whoisds.com/whois-database/newly-registered-domains/";

/** Per-request timeout for the (multi-MB) NRD archive download. */
const FETCH_TIMEOUT_MS = 30_000;

/** Common homoglyph substitutions for brand matching */
const HOMOGLYPHS: Record<string, string[]> = {
  l: ["1", "i"],
  o: ["0"],
  i: ["1", "l"],
  a: ["4", "@"],
  e: ["3"],
  s: ["5", "$"],
};

/** YYYY-MM-DD for `n` days before today, in UTC. */
function utcDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Build the WhoisDS free-tier NRD download URL for a given day.
 *
 * PRODUCTION FIX (2026-09-11): the path segment is NOT the plain
 * `YYYY-MM-DD.zip` filename. WhoisDS keys the free download on
 * base64("YYYY-MM-DD.zip") with the '=' padding stripped, followed by the
 * literal `/nrd` segment:
 *
 *   https://whoisds.com/whois-database/newly-registered-domains/MjAyNi0wOS0xMC56aXA/nrd
 *
 * The old `.../2026-09-10.zip` form still resolves (the route matches the
 * date segment) but WhoisDS answers it with HTTP 200 and a ZERO-BYTE body —
 * which is exactly the production symptom: `res.ok` was true so the
 * day-before fallback never fired, and every pull died in
 * extractTextFromZip with "empty response body (0 bytes)" until the
 * circuit breaker auto-paused the feed.
 *
 * The encoding matches WhoisDS's own free-download links and the public
 * downloader scripts built against them; it could NOT be verified from the
 * repair session itself (whoisds.com is blocked by that session's egress
 * policy), so the first post-deploy pull is the confirmation — if it still
 * reports zero bytes, the source itself is gone and the feed parks as
 * `auto:upstream_dead` (see the throw at the end of `ingest`).
 *
 * Exported for unit tests — the encoding is the whole bug, so it is
 * asserted directly rather than through a fetch mock.
 */
export function nrdDownloadUrl(date: string): string {
  const infix = btoa(`${date}.zip`).replace(/=+$/, "");
  return `${WHOISDS_BASE_URL}${infix}/nrd`;
}

/**
 * Decompress an entire in-memory buffer via the Workers-native
 * DecompressionStream. `deflate-raw` = a bare DEFLATE stream (what ZIP
 * entries hold); `gzip` = a gzip container.
 */
async function inflateAll(bytes: Uint8Array<ArrayBuffer>, format: "deflate-raw" | "gzip"): Promise<Uint8Array> {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  // Do NOT await write() before reading: for multi-MB inputs the writable
  // applies backpressure until the readable is drained, so awaiting here
  // would deadlock. Kick off write+close, then pull the output.
  void writer.write(bytes);
  void writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); total += value.length; }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

/** True if the buffer's first non-whitespace byte is '<' (HTML/XML error page). */
function looksLikeHtml(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  return bytes[i] === 0x3c;
}

/**
 * Extract the domain-list text from a WhoisDS NRD download.
 *
 * The archive is parsed via its END-OF-CENTRAL-DIRECTORY record, not the
 * local file header. This is the fix for the production
 * "unsupported compression" death-loop: WhoisDS writes the ZIP in a
 * streaming mode that sets general-purpose bit 3 (data descriptor), so the
 * LOCAL header reports compressedSize=0 and can misframe the method byte —
 * the old local-header reader either sliced zero bytes (silent empty pull)
 * or read a bogus method and bailed with "unsupported compression". The
 * central directory always carries the authoritative method + compressed
 * size, so we read from there.
 *
 * Throws a PRECISE error on any genuine failure (unknown container, HTML
 * error page, unsupported ZIP method, ZIP64, truncation) so runFeed stamps
 * the circuit breaker instead of the feed silently succeeding with 0 rows.
 */
async function extractTextFromZip(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) {
    throw new Error("NRD WhoisDS: empty response body (0 bytes)");
  }

  // gzip container — upstream occasionally serves a .gz, or a proxy hands
  // back a gzip body the runtime didn't transparently decode.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return new TextDecoder().decode(await inflateAll(bytes, "gzip"));
  }

  // ZIP container (PK\x03\x04).
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return await extractFromZipBuffer(bytes);
  }

  // Not a known binary container. An HTML/error page must fail loudly —
  // otherwise `.includes(".")` mines fake domains out of markup.
  if (looksLikeHtml(bytes)) {
    const snippet = new TextDecoder().decode(bytes.slice(0, 200)).replace(/\s+/g, " ").trim();
    throw new Error(`NRD WhoisDS: expected ZIP, got HTML/error page — "${snippet}"`);
  }

  // Otherwise treat it as a plain-text domain list.
  return new TextDecoder().decode(bytes);
}

/**
 * Parse a whole-buffer ZIP via its central directory and return the
 * decompressed text of its largest file entry (NRD archives hold a single
 * domain-list .txt).
 */
async function extractFromZipBuffer(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const eocd = findEocdOffset(bytes);
  if (eocd === -1) {
    throw new Error("NRD WhoisDS: ZIP end-of-central-directory not found (truncated or ZIP64 archive)");
  }
  const cdirSize = readUint32LE(bytes, eocd + 12);
  const cdirOffset = readUint32LE(bytes, eocd + 16);
  // 0xFFFFFFFF sentinels mean the real values live in a ZIP64 EOCD, which
  // DecompressionStream + this reader don't handle — fail precisely.
  if (cdirOffset === 0xffffffff || cdirSize === 0 || cdirOffset + cdirSize > bytes.length) {
    throw new Error(
      `NRD WhoisDS: invalid or ZIP64 central directory (offset=${cdirOffset}, size=${cdirSize}, total=${bytes.length})`,
    );
  }

  const entries = parseCentralDirectory(bytes.subarray(cdirOffset, cdirOffset + cdirSize));
  const files = entries.filter((e) => !e.name.endsWith("/") && e.uncompressedSize > 0);
  if (files.length === 0) {
    throw new Error("NRD WhoisDS: ZIP contained no non-empty file entries");
  }
  const entry = files.reduce((a, b) => (b.uncompressedSize > a.uncompressedSize ? b : a));

  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(
      `NRD WhoisDS: entry "${entry.name}" uses unsupported ZIP compression method ${entry.compressionMethod} (only 0=stored / 8=deflate supported)`,
    );
  }

  // Re-read the LOCAL header to compute the true data offset — its
  // filename/extra lengths can differ from the central directory's.
  const probeEnd = Math.min(bytes.length, entry.localHeaderOffset + 30 + 65535);
  const lfh = bytes.subarray(entry.localHeaderOffset, probeEnd);
  const headerLen = parseLocalHeaderLength(lfh, entry.name, lfh.length);
  const dataStart = entry.localHeaderOffset + headerLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) {
    throw new Error(
      `NRD WhoisDS: entry "${entry.name}" data runs past archive end (start=${dataStart}, size=${entry.compressedSize}, total=${bytes.length})`,
    );
  }
  const data = bytes.subarray(dataStart, dataEnd);

  if (entry.compressionMethod === 0) {
    return new TextDecoder().decode(data);
  }
  return new TextDecoder().decode(await inflateAll(data, "deflate-raw"));
}

/**
 * NRD Feed — Newly Registered Domains via WhoisDS.com.
 *
 * Replaced xRuffKez/Hagezi (EOL Dec 2025) with WhoisDS daily NRD download.
 * Downloads yesterday's archive (see nrdDownloadUrl for the URL shape),
 * falling back to the day before, extracts the domain list, and matches it
 * against monitored brands.
 * Brand-matched domains are inserted as typosquatting threats, collected in
 * memory and flushed via bulkInsertThreats (chunked INSERT OR IGNORE).
 * All NRDs are stored in nrd_domains reference table for later analysis.
 *
 * Schedule: daily (WhoisDS publishes once per day).
 * Volume: 50,000–180,000 domains/day.
 */
export const nrd_hagezi: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    // WhoisDS publishes a day's archive some hours after UTC midnight, so a
    // pull near the rollover legitimately finds yesterday missing. Walk back
    // one more day before giving up.
    //
    // A zero-byte 200 is treated exactly like a non-2xx here: the previous
    // code only fell back on `!res.ok`, so an empty-but-successful response
    // (the symptom of the wrong URL shape above) short-circuited straight
    // into a hard failure with no second attempt.
    const attempts: Array<{ date: string; problem: string }> = [];

    for (const daysAgo of [1, 2]) {
      const date = utcDaysAgo(daysAgo);
      const url = nrdDownloadUrl(date);
      logger.info("nrd_whoisds_fetch", { url, date, daysAgo });

      let res: Response;
      try {
        res = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { "User-Agent": "Averrow-ThreatIntel/1.0" },
        });
      } catch (err) {
        attempts.push({ date, problem: `fetch failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }

      if (!res.ok) {
        attempts.push({ date, problem: `HTTP ${res.status}` });
        continue;
      }

      const buffer = await res.arrayBuffer();
      if (buffer.byteLength === 0) {
        attempts.push({ date, problem: "empty response body (0 bytes)" });
        continue;
      }

      return await processArchive(buffer, ctx, date);
    }

    const detail = attempts.map((a) => `${a.date}: ${a.problem}`).join("; ");

    // Every attempt came back 200-but-empty. That is not a transient blip:
    // the route resolves and the upstream simply has nothing behind it. Say
    // so in the wording autoPauseFeed's permanent-error taxonomy recognises
    // (lib/feedRunner.ts) so the breaker parks the feed as
    // `auto:upstream_dead` — sticky, operator-resumed — instead of
    // `auto:consecutive_failures`, which the 4-hour auto-recovery sweep
    // revives into an endless pause → 5 failures → pause loop. That loop is
    // what produced 6 critical auto-pause alerts and 9 feed-silent alerts in
    // a single day for a feed that had been dead for months.
    if (attempts.every((a) => a.problem.startsWith("empty response body"))) {
      throw new Error(
        `NRD WhoisDS: upstream served no data on ${attempts.length} consecutive days — ${detail}`,
      );
    }

    throw new Error(`NRD WhoisDS: no usable archive — ${detail}`);
  },
};

async function processArchive(buffer: ArrayBuffer, ctx: FeedContext, date: string): Promise<FeedResult> {
  // extractTextFromZip throws a precise Error on any genuine failure
  // (unknown container, HTML error page, unsupported/ZIP64 method,
  // truncation), which runFeed catches to stamp the circuit breaker.
  const text = await extractTextFromZip(buffer);

  const domains = text
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#") && l.includes("."));

  logger.info("nrd_whoisds_parsed", { date, totalDomains: domains.length });

  // Store all NRDs in reference table for later analysis
  await storeNrdReference(ctx.env.DB, domains, date);

  // Fetch monitored brands
  const brands = await ctx.env.DB.prepare(
    `SELECT b.id, b.name, b.canonical_domain
     FROM brands b
     INNER JOIN monitored_brands mb ON mb.brand_id = b.id
     WHERE mb.status = 'active'`
  ).all<{ id: string; name: string; canonical_domain: string }>();

  if (!brands.results.length) {
    return { itemsFetched: domains.length, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
  }

  // Build keyword list from brand names. Deduped by brand id (a brand
  // monitored by several tenants appears once per monitored_brands row) and
  // homoglyph variants precomputed ONCE per brand — the match loop below is
  // domains × brands (~10^5 × ~10^3), so regenerating the variant array per
  // (domain, brand) pair was ~10^8 needless allocations per run. Matching
  // semantics are unchanged: same keyword, same variants, same order.
  const seenBrandIds = new Set<string>();
  const brandKeywords: Array<{ id: string; domain: string; needles: string[] }> = [];
  for (const b of brands.results) {
    if (seenBrandIds.has(b.id)) continue;
    seenBrandIds.add(b.id);
    const needles = brandNeedles(b.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    // A keyword under 3 chars can never match — drop it from the hot loop.
    if (needles.length === 0) continue;
    brandKeywords.push({ id: b.id, domain: b.canonical_domain.toLowerCase(), needles });
  }

  // Match in memory, then flush in bulk. The old loop did, per matched
  // domain and in series: isDuplicate (KV GET) → insertThreat (D1 INSERT +
  // brand-counter UPDATE) → markSeen (KV PUT) — ~4 round trips per match,
  // so a busy day (short keywords + homoglyphs → thousands of matches)
  // burned thousands of serial subrequests. Same pattern as
  // phishing_database / phishdestroy / openphish: dedupe within the payload,
  // then chunked INSERT OR IGNORE via bulkInsertThreats. Dedup is the
  // deterministic per-feed threatId PK (authoritative, no 24h KV TTL), and
  // bulkInsertThreats bumps brands.threat_count only for rows that actually
  // landed (meta.changes > 0) — exactly what insertThreat did per row.
  const { rows, inPayloadDuplicates } = collectBrandMatchRows(domains, brandKeywords);

  // Outbound KV note: this path no longer calls markSeen, so no
  // `dedup:domain:*` key is written. ct_logs (feeds/certstream.ts) still
  // pre-checks those keys, so it will now add its own ct_logs row (with
  // cert columns) for a domain this feed inserted the same day, and
  // brands.threat_count is bumped once per source — intended
  // one-row-per-source corroboration (docs/THREAT_FEEDS.md "Cross-feed note").
  const { itemsNew, itemsDuplicate, itemsError } = await bulkInsertThreats(ctx.env.DB, rows);

  logger.info("nrd_whoisds_matched", { date, matches: rows.length, itemsNew, itemsDuplicate, itemsError });

  return {
    itemsFetched: domains.length,
    itemsNew,
    itemsDuplicate: itemsDuplicate + inPayloadDuplicates,
    itemsError,
  };
}

/**
 * Pure domain × brand match pass — no I/O. One row per distinct matched
 * domain: the FIRST brand (in `brandKeywords` order) whose needles hit wins,
 * a brand's own canonical domain never matches that brand, and a domain
 * repeated in the list counts as an in-payload duplicate (the old loop's
 * KV pre-check caught the repeat after markSeen; here the Set does).
 *
 * Exported for unit tests.
 */
export function collectBrandMatchRows(
  domains: string[],
  brandKeywords: Array<{ id: string; domain: string; needles: string[] }>,
): { rows: ThreatRow[]; inPayloadDuplicates: number } {
  const matched = new Set<string>();
  const rows: ThreatRow[] = [];
  let inPayloadDuplicates = 0;

  for (const domain of domains) {
    for (const brand of brandKeywords) {
      // Skip if domain IS the brand's canonical domain
      if (domain === brand.domain) continue;
      if (!domainMatchesNeedles(domain, brand.needles)) continue;

      if (matched.has(domain)) { inPayloadDuplicates++; break; }
      matched.add(domain);
      rows.push({
        id: threatId("nrd_hagezi", "domain", domain),
        source_feed: "nrd_hagezi",
        threat_type: "typosquatting",
        malicious_url: null,
        malicious_domain: domain,
        target_brand_id: brand.id,
        ioc_value: domain,
        severity: "medium",
        confidence_score: 60,
      });
      break; // One brand match per domain is enough
    }
  }

  return { rows, inPayloadDuplicates };
}

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
 * 180K-domain day is ~9 calls.
 */
export const NRD_STATEMENTS_PER_BATCH = 20;

/**
 * Store all NRDs in reference table for later analysis (infrastructure correlation, etc.).
 * INSERT OR IGNORE keeps re-runs (and in-list duplicates) idempotent: the
 * first registered_date written for a domain wins, exactly as before.
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

/** True if the domain contains any of the brand's needles. */
function domainMatchesNeedles(domain: string, needles: string[]): boolean {
  for (const n of needles) {
    if (domain.includes(n)) return true;
  }
  return false;
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
