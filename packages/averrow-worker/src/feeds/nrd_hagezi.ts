import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";
import { logger } from "../lib/logger";

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
 * Extract text content from a ZIP archive using native DecompressionStream.
 * Reuses the same ZIP parsing pattern as admin.ts extractCsvFromZip.
 */
async function extractTextFromZip(buffer: ArrayBuffer): Promise<string | null> {
  const bytes = new Uint8Array(buffer);

  // Verify ZIP magic bytes (PK\x03\x04)
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    // Not a ZIP — try reading as plain text
    return new TextDecoder().decode(buffer);
  }

  const compressionMethod = bytes[8]! | (bytes[9]! << 8);
  const compressedSize = bytes[18]! | (bytes[19]! << 8) | (bytes[20]! << 16) | (bytes[21]! << 24);
  const fileNameLen = bytes[26]! | (bytes[27]! << 8);
  const extraLen = bytes[28]! | (bytes[29]! << 8);
  const dataOffset = 30 + fileNameLen + extraLen;

  if (compressionMethod === 0) {
    // Stored (no compression)
    return new TextDecoder().decode(bytes.slice(dataOffset, dataOffset + compressedSize));
  }
  if (compressionMethod === 8) {
    // Deflate-raw
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) { result.set(c, offset); offset += c.length; }
    return new TextDecoder().decode(result);
  }

  return null;
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
  const text = await extractTextFromZip(buffer);
  if (!text) {
    throw new Error("NRD WhoisDS: failed to extract domains from ZIP (unsupported compression)");
  }

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
