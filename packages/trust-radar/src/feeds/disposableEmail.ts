import type { FeedModule, FeedContext, FeedResult } from "./types";

const DISPOSABLE_URL =
  "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf";
const BATCH_SIZE = 50;

/**
 * Disposable Email Domains — Reference table of throwaway email domains.
 *
 * Loads ~3,500 disposable email domains into a lookup table for
 * cross-referencing in spam trap analysis. Not an ingest feed —
 * does not create threat records.
 *
 * Schedule: weekly (Sundays at 00:00). No API key required.
 */
export const disposable_email: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const db = ctx.env.DB;
    const url = ctx.feedUrl || DISPOSABLE_URL;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "TrustRadar/2.0" },
    });
    if (!res.ok) throw new Error(`Disposable Email Domains HTTP ${res.status}`);

    const text = await res.text();
    const allDomains = text
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#") && l.includes("."));

    const uniqueDomains = [...new Set(allDomains)];

    // Insert-only sync (no truncate). The previous "DELETE FROM … then
    // re-INSERT every row" pattern billed ~2× the full list (delete +
    // insert) on every run — pure write churn since this blocklist only
    // grows in practice. INSERT OR IGNORE writes ONLY genuinely-new
    // domains (existing rows conflict and cost no write), so a steady-state
    // run writes ~0 rows. The upstream list effectively only adds domains;
    // the rare removal of a stale entry is harmless to leave flagged (worst
    // case a throwaway domain stays classified disposable), so we trade
    // exact-mirror semantics for eliminating the truncate churn.
    let itemsNew = 0;
    let firstError: string | null = null;

    for (let i = 0; i < uniqueDomains.length; i += BATCH_SIZE) {
      const batch = uniqueDomains.slice(i, i + BATCH_SIZE);
      const stmts = batch.map((domain) =>
        db.prepare(
          `INSERT OR IGNORE INTO disposable_email_domains (domain, last_updated)
           VALUES (?, datetime('now'))`,
        ).bind(domain),
      );

      try {
        const results = await db.batch(stmts);
        itemsNew += results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
      } catch (e) {
        if (!firstError) firstError = String(e);
      }
    }

    return {
      itemsFetched: uniqueDomains.length,
      itemsNew,
      itemsDuplicate: 0,
      itemsError: firstError ? 1 : 0,
    };
  },
};

/**
 * Check if an email address uses a disposable domain.
 * Queries the disposable_email_domains table with KV caching (24h TTL).
 */
export async function isDisposableEmail(
  db: D1Database,
  cache: KVNamespace,
  email: string,
): Promise<boolean> {
  const atIndex = email.lastIndexOf("@");
  if (atIndex < 0) return false;
  const domain = email.slice(atIndex + 1).toLowerCase().trim();
  if (!domain) return false;

  // Check KV cache first
  const cacheKey = `disposable:${domain}`;
  const cached = await cache.get(cacheKey);
  if (cached !== null) return cached === "1";

  // Query DB
  const row = await db.prepare(
    "SELECT 1 FROM disposable_email_domains WHERE domain = ? LIMIT 1",
  ).bind(domain).first();

  const isDisposable = row !== null;

  // Cache result for 24h
  await cache.put(cacheKey, isDisposable ? "1" : "0", { expirationTtl: 86400 }).catch(() => {});

  return isDisposable;
}
