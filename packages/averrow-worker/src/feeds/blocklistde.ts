import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";

const BLOCKLIST_URL = "https://lists.blocklist.de/lists/all.txt";
const MAX_NEW_PER_RUN = 500;
const BATCH_SIZE = 50;

/**
 * Blocklist.de — Community-driven IP blocklist.
 *
 * Fetches the combined "all attacks" list (~20K IPs) covering SSH, FTP, mail,
 * and web server attacks. Updated every 12 hours by the source.
 *
 * IPs are inserted as "malicious_infrastructure" threats so NEXUS can correlate
 * them with brand-targeted phishing/malware domains sharing the same infrastructure.
 *
 * Schedule: every 12 hours. No API key required.
 */
export const blocklist_de: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const db = ctx.env.DB;
    const url = ctx.feedUrl || BLOCKLIST_URL;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "Averrow-ThreatIntel/1.0" },
    });
    if (!res.ok) throw new Error(`Blocklist.de HTTP ${res.status}`);

    const text = await res.text();
    const allIps = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(l));

    // Deduplicate within the fetched list
    const uniqueIps = [...new Set(allIps)];

    // Process up to MAX_NEW_PER_RUN new IPs per run (skip already-seen via INSERT OR IGNORE)
    const toProcess = uniqueIps.slice(0, MAX_NEW_PER_RUN);

    let itemsNew = 0;
    let firstError: string | null = null;

    // Batch insert using INSERT OR IGNORE for dedup
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const stmts = batch.map((ip) =>
        db.prepare(
          `INSERT OR IGNORE INTO threats
            (id, source_feed, threat_type, malicious_url, malicious_domain,
             ip_address, ioc_value, severity, confidence_score, status,
             first_seen, last_seen, created_at)
           VALUES (?, 'blocklist_de', 'malicious_ip', NULL, NULL,
                   ?, ?, 'medium', 70, 'active',
                   datetime('now'), datetime('now'), datetime('now'))`,
        ).bind(threatId("blocklist_de", "ip", ip), ip, ip),
      );

      try {
        const results = await db.batch(stmts);
        const batchNew = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
        itemsNew += batchNew;
      } catch (e) {
        if (!firstError) firstError = String(e);
      }
    }

    // Update last_seen for IPs that already exist (batch in chunks)
    // Only update if we had duplicates (saves writes)
    if (itemsNew < toProcess.length) {
      const updateBatch = toProcess.slice(0, Math.min(toProcess.length, 200));
      const updateStmts = updateBatch.map((ip) =>
        db.prepare(
          `UPDATE threats SET last_seen = datetime('now')
           WHERE ip_address = ? AND source_feed = 'blocklist_de'`,
        ).bind(ip),
      );
      try {
        await db.batch(updateStmts);
      } catch { /* non-fatal — last_seen update is best-effort */ }
    }

    // Mark processed IPs in KV dedup cache (fire-and-forget)
    const kvPromises = toProcess.slice(0, Math.min(toProcess.length, 200)).map((ip) => {
      const key = `dedup:ip:${ip}`;
      return ctx.env.CACHE.put(key, "1", { expirationTtl: 86400 }).catch(() => {});
    });
    await Promise.all(kvPromises);

    return {
      itemsFetched: uniqueIps.length,
      itemsNew,
      itemsDuplicate: toProcess.length - itemsNew,
      itemsError: firstError ? 1 : 0,
    };
  },
};
