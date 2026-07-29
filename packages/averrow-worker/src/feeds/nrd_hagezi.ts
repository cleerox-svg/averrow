import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";
import { logger } from "../lib/logger";
import {
  findEocdOffset,
  parseCentralDirectory,
  parseLocalHeaderLength,
  readUint32LE,
} from "../lib/zip-internals";

const WHOISDS_BASE_URL = "https://whoisds.com/whois-database/newly-registered-domains/";

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
 * Get yesterday's date formatted as YYYY-MM-DD for WhoisDS download URL.
 */
function getYesterdayDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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
 * Downloads yesterday's .zip, extracts domain list, matches against monitored brands.
 * Brand-matched domains are inserted as typosquatting threats.
 * All NRDs are stored in nrd_domains reference table for later analysis.
 *
 * Schedule: daily (WhoisDS publishes once per day).
 * Volume: 50,000–180,000 domains/day.
 */
export const nrd_hagezi: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const yesterday = getYesterdayDate();
    const url = `${WHOISDS_BASE_URL}${yesterday}.zip`;
    logger.info("nrd_whoisds_fetch", { url, date: yesterday });

    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "Averrow-ThreatIntel/1.0" },
    });

    if (!res.ok) {
      // WhoisDS may not have yesterday's file yet — try day before yesterday
      const dayBefore = new Date();
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 2);
      const fallbackDate = dayBefore.toISOString().slice(0, 10);
      const fallbackUrl = `${WHOISDS_BASE_URL}${fallbackDate}.zip`;
      logger.info("nrd_whoisds_fallback", { fallbackUrl, originalStatus: res.status });

      const fallbackRes = await fetch(fallbackUrl, {
        signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "Averrow-ThreatIntel/1.0" },
      });
      if (!fallbackRes.ok) {
        throw new Error(`NRD WhoisDS HTTP ${res.status} (yesterday) / ${fallbackRes.status} (day-before)`);
      }

      return await processZip(fallbackRes, ctx, fallbackDate);
    }

    return await processZip(res, ctx, yesterday);
  },
};

async function processZip(res: Response, ctx: FeedContext, date: string): Promise<FeedResult> {
  const buffer = await res.arrayBuffer();
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

  // Build keyword list from brand names
  const brandKeywords = brands.results.map((b) => ({
    id: b.id,
    keyword: b.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
    domain: b.canonical_domain.toLowerCase(),
  }));

  let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;

  for (const domain of domains) {
    for (const brand of brandKeywords) {
      // Skip if domain IS the brand's canonical domain
      if (domain === brand.domain) continue;

      const matches = domainMatchesBrand(domain, brand.keyword);
      if (!matches) continue;

      try {
        if (await isDuplicate(ctx.env, "domain", domain)) { itemsDuplicate++; break; }

        await insertThreat(ctx.env.DB, {
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
        await markSeen(ctx.env, "domain", domain);
        itemsNew++;
        break; // One brand match per domain is enough
      } catch { itemsError++; break; }
    }
  }

  return { itemsFetched: domains.length, itemsNew, itemsDuplicate, itemsError };
}

/**
 * Store all NRDs in reference table for later analysis (infrastructure correlation, etc.).
 * Uses batched inserts with ON CONFLICT DO NOTHING to handle re-runs.
 */
async function storeNrdReference(db: D1Database, domains: string[], date: string): Promise<void> {
  // Ensure reference table exists
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS nrd_domains (
      domain TEXT PRIMARY KEY,
      registered_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      brand_matched INTEGER DEFAULT 0
    )
  `).run();

  // Batch insert in chunks of 500
  const BATCH = 500;
  for (let i = 0; i < domains.length; i += BATCH) {
    const chunk = domains.slice(i, i + BATCH);
    const placeholders = chunk.map(() => "(?, ?)").join(",");
    const binds = chunk.flatMap((d) => [d, date]);

    await db.prepare(
      `INSERT OR IGNORE INTO nrd_domains (domain, registered_date) VALUES ${placeholders}`
    ).bind(...binds).run();
  }

  logger.info("nrd_reference_stored", { domains: domains.length, date });
}

/** Check if a domain contains a brand keyword or common homoglyph variants */
function domainMatchesBrand(domain: string, keyword: string): boolean {
  if (keyword.length < 3) return false; // Avoid false positives on short keywords

  // Direct substring match
  if (domain.includes(keyword)) return true;

  // Homoglyph variant matching
  const variants = generateHomoglyphVariants(keyword);
  for (const variant of variants) {
    if (domain.includes(variant)) return true;
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
