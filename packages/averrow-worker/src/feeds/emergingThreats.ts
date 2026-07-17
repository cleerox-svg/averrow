import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";

const ET_URL = "https://rules.emergingthreats.net/blockrules/compromised-ips.txt";
const MAX_PER_RUN = 500;
const BATCH_SIZE = 50;
const IP_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Emerging Threats (Proofpoint ET) — Compromised IP blocklist.
 *
 * Well-curated list of actively compromised hosts from Proofpoint's
 * Emerging Threats project. Different sources than CINS Army or Blocklist.de.
 *
 * Schedule: every 12 hours. No API key required.
 */
export const emerging_threats: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const db = ctx.env.DB;
    const url = ctx.feedUrl || ET_URL;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "Averrow-ThreatIntel/1.0" },
    });
    if (!res.ok) throw new Error(`Emerging Threats HTTP ${res.status}`);

    const text = await res.text();
    const allIps = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && IP_REGEX.test(l));

    const uniqueIps = [...new Set(allIps)];
    const toProcess = uniqueIps.slice(0, MAX_PER_RUN);

    let itemsNew = 0;
    let firstError: string | null = null;

    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const stmts = batch.map((ip) =>
        db.prepare(
          `INSERT OR IGNORE INTO threats
            (id, source_feed, threat_type, malicious_url, malicious_domain,
             ip_address, ioc_value, severity, confidence_score, status,
             title, first_seen, last_seen, created_at)
           VALUES (?, 'emerging_threats', 'malicious_ip', NULL, NULL,
                   ?, ?, 'medium', 75, 'active',
                   'Compromised Host (Emerging Threats)',
                   datetime('now'), datetime('now'), datetime('now'))`,
        ).bind(threatId("emerging_threats", "ip", ip), ip, ip),
      );

      try {
        const results = await db.batch(stmts);
        itemsNew += results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
      } catch (e) {
        if (!firstError) firstError = String(e);
      }
    }

    // Update last_seen for existing IPs
    if (itemsNew < toProcess.length) {
      const updateBatch = toProcess.slice(0, Math.min(toProcess.length, 200));
      const updateStmts = updateBatch.map((ip) =>
        db.prepare(
          `UPDATE threats SET last_seen = datetime('now')
           WHERE ip_address = ? AND source_feed = 'emerging_threats'`,
        ).bind(ip),
      );
      try {
        await db.batch(updateStmts);
      } catch { /* non-fatal */ }
    }

    // KV dedup cache
    const kvPromises = toProcess.slice(0, 200).map((ip) =>
      ctx.env.CACHE.put(`dedup:ip:${ip}`, "1", { expirationTtl: 86400 }).catch(() => {}),
    );
    await Promise.all(kvPromises);

    return {
      itemsFetched: uniqueIps.length,
      itemsNew,
      itemsDuplicate: toProcess.length - itemsNew,
      itemsError: firstError ? 1 : 0,
    };
  },
};
