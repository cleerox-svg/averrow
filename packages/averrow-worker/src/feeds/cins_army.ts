import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { diagnosticFetch } from "../lib/feedDiagnostic";

const CINS_URL = "https://cinsscore.com/list/ci-badguys.txt";
const SAMPLE_SIZE = 200;
const BATCH_SIZE = 50;

/**
 * CINS Army — Verified malicious IP addresses from honeypot network.
 * Samples 200 IPs per cycle and batch-inserts them (4 batches of 50).
 * Uses INSERT OR IGNORE so DB-level dedup handles collisions.
 * Schedule: daily.
 */
export const cins_army: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const db = ctx.env.DB;
    const url = ctx.feedUrl || CINS_URL;

    // DB diagnostic: proves ingest() was called
    try {
      await db.prepare(
        "INSERT INTO agent_outputs (id, agent_id, type, summary, created_at) VALUES (?, 'sentinel', 'diagnostic', ?, datetime('now'))"
      ).bind('diag_cins_called_' + Date.now(), `CINS Army ingest() called — url=${url}`).run();
    } catch { /* non-fatal */ }

    const res = await diagnosticFetch(db, "cins_army", url, {
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0" },
    });
    if (!res.ok) throw new Error(`CINS Army HTTP ${res.status}`);

    const text = await res.text();
    const allIps = text.split("\n").map((l) => l.trim()).filter((l) => l && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(l));

    // Sample 200 random IPs from the full list
    const ips = sample(allIps, SAMPLE_SIZE);

    // DB diagnostic: parsed count
    try {
      await db.prepare(
        "INSERT INTO agent_outputs (id, agent_id, type, summary, created_at) VALUES (?, 'sentinel', 'diagnostic', ?, datetime('now'))"
      ).bind('diag_cins_parsed_' + Date.now(), `CINS Army parsed ${allIps.length} IPs, sampled ${ips.length}, first=${ips[0] ?? 'NONE'}, batch inserting...`).run();
    } catch { /* non-fatal */ }

    // Batch INSERT OR IGNORE — 4 batches of 50
    let itemsNew = 0;
    let firstError: string | null = null;

    for (let i = 0; i < ips.length; i += BATCH_SIZE) {
      const batch = ips.slice(i, i + BATCH_SIZE);
      const stmts = batch.map(ip =>
        db.prepare(
          `INSERT OR IGNORE INTO threats
            (id, source_feed, threat_type, malicious_url, malicious_domain,
             ip_address, ioc_value, severity, confidence_score, status,
             first_seen, last_seen, created_at)
           VALUES (?, 'cins_army', 'malicious_ip', NULL, NULL,
                   ?, ?, 'medium', 75, 'active',
                   datetime('now'), datetime('now'), datetime('now'))`
        ).bind(threatId("cins_army", "ip", ip), ip, ip)
      );

      try {
        const results = await db.batch(stmts);
        const batchNew = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
        itemsNew += batchNew;
      } catch (e) {
        if (!firstError) firstError = String(e);
      }
    }

    // Mark sampled IPs as seen in KV (fire-and-forget, non-blocking)
    const kvPromises = ips.slice(0, itemsNew > 0 ? ips.length : 0).map(ip => {
      const key = `dedup:ip:${ip}`;
      return ctx.env.CACHE.put(key, "1", { expirationTtl: 86400 }).catch(() => {});
    });
    await Promise.all(kvPromises);

    // Summary diagnostic to DB
    const summary = `CINS Army done: total_parsed=${allIps.length}, sampled=${ips.length}, inserted=${itemsNew}, ignored=${ips.length - itemsNew}` +
      (firstError ? `, first_error=${firstError.slice(0, 200)}` : '');
    try {
      await db.prepare(
        "INSERT INTO agent_outputs (id, agent_id, type, summary, created_at) VALUES (?, 'sentinel', 'diagnostic', ?, datetime('now'))"
      ).bind('diag_cins_done_' + Date.now(), summary).run();
    } catch { /* non-fatal */ }

    return { itemsFetched: allIps.length, itemsNew, itemsDuplicate: ips.length - itemsNew, itemsError: firstError ? 1 : 0 };
  },
};

/** Fisher-Yates shuffle, return first n elements */
function sample<T>(arr: T[], n: number): T[] {
  const copy = arr.slice();
  const len = copy.length;
  const limit = Math.min(n, len);
  for (let i = 0; i < limit; i++) {
    const j = i + Math.floor(Math.random() * (len - i));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, limit);
}
