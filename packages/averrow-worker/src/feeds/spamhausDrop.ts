import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";

const DROP_URL = "https://www.spamhaus.org/drop/drop.txt";
const EDROP_URL = "https://www.spamhaus.org/drop/edrop.txt";
const BATCH_SIZE = 50;

interface DropEntry {
  cidr: string;
  sblId: string | null;
}

/**
 * Spamhaus DROP + EDROP — Hijacked network ranges (CIDR blocks).
 *
 * These are entire network ranges allocated to spammers or hijacked for
 * malware/botnet operations. Gold-standard network-level blocklist.
 *
 * Schedule: daily at 03:00. No API key required.
 */
export const spamhaus_drop: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const db = ctx.env.DB;

    // Fetch both DROP and EDROP in parallel
    const [dropRes, edropRes] = await Promise.all([
      fetch(DROP_URL, { headers: { "User-Agent": "Averrow-ThreatIntel/1.0" } }),
      fetch(EDROP_URL, { headers: { "User-Agent": "Averrow-ThreatIntel/1.0" } }),
    ]);

    const entries: DropEntry[] = [];

    for (const res of [dropRes, edropRes]) {
      if (!res.ok) continue;
      const text = await res.text();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        // Skip comments (starting with ;) and empty lines
        if (!trimmed || trimmed.startsWith(";")) continue;
        // Format: "CIDR ; SBLnnnnn" or just CIDR
        const parts = trimmed.split(";").map((p) => p.trim());
        const cidr = parts[0];
        if (!cidr || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(cidr)) continue;
        const sblId = parts[1] && /^SBL\d+$/i.test(parts[1]) ? parts[1] : null;
        entries.push({ cidr, sblId });
      }
    }

    // Deduplicate by CIDR
    const seen = new Set<string>();
    const unique: DropEntry[] = [];
    for (const entry of entries) {
      if (!seen.has(entry.cidr)) {
        seen.add(entry.cidr);
        unique.push(entry);
      }
    }

    let itemsNew = 0;
    let firstError: string | null = null;

    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const batch = unique.slice(i, i + BATCH_SIZE);
      const stmts = batch.map(({ cidr, sblId }) =>
        db.prepare(
          `INSERT OR IGNORE INTO threats
            (id, source_feed, threat_type, malicious_url, malicious_domain,
             ip_address, ioc_value, severity, confidence_score, status,
             title, tags, first_seen, last_seen, created_at)
           VALUES (?, 'spamhaus_drop', 'malicious_ip', NULL, NULL,
                   ?, ?, 'high', 98, 'active',
                   'Hijacked Network Range (Spamhaus DROP)',
                   ?, datetime('now'), datetime('now'), datetime('now'))`,
        ).bind(
          threatId("spamhaus_drop", "cidr", cidr),
          cidr,
          cidr,
          sblId ? JSON.stringify([sblId]) : "[]",
        ),
      );

      try {
        const results = await db.batch(stmts);
        itemsNew += results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
      } catch (e) {
        if (!firstError) firstError = String(e);
      }
    }

    // Update last_seen for existing ranges
    if (itemsNew < unique.length) {
      const updateBatch = unique.slice(0, Math.min(unique.length, 200));
      const updateStmts = updateBatch.map(({ cidr }) =>
        db.prepare(
          `UPDATE threats SET last_seen = datetime('now')
           WHERE ip_address = ? AND source_feed = 'spamhaus_drop'`,
        ).bind(cidr),
      );
      try {
        await db.batch(updateStmts);
      } catch { /* non-fatal */ }
    }

    // Cross-reference: check if any existing threat IPs fall within DROP
    // ranges. Pre-PR-AM this looped up to 100 CIDR prefixes per tick, each
    // running its own `WHERE ip_address LIKE ?` scan over the threats table.
    // Diagnostics tagged it at ~42M reads/day — for a purely informational
    // diagnostic that only emits one agent_output row when overlap > 0.
    //
    // PR-AM: batch all prefixes into a single query with OR-LIKE and cap
    // the prefix set at 20 (was 100). Reads ~20× threats per tick instead
    // of 100× sequentially. Result is cached via KV with a 6-hour TTL so
    // the cross-ref only runs ~4× per day even if the spamhaus feed pulls
    // more often. Net: ~95% reduction on this query path.
    let overlapCount = 0;
    try {
      const cacheKey = `spamhaus_drop:overlap_count_24h`;
      // For each CIDR prefix > /24, derive the /24 LIKE pattern.
      // Cap at 20 prefixes (was 100) — diminishing returns past that.
      const prefixes: string[] = [];
      for (const { cidr } of unique.slice(0, 20)) {
        const [network, bits] = cidr.split("/");
        if (!network || !bits) continue;
        const prefix = parseInt(bits, 10);
        if (prefix >= 24) {
          const networkPrefix = network.split(".").slice(0, 3).join(".");
          prefixes.push(`${networkPrefix}.%`);
        }
      }

      if (prefixes.length > 0) {
        const cached = await ctx.env.CACHE.get(cacheKey).catch(() => null);
        if (cached) {
          overlapCount = parseInt(cached, 10) || 0;
        } else {
          // Single batched query with N OR-LIKEs in place of N separate
          // queries. SQLite optimises this into a single index scan over
          // idx_threats_ip when present.
          const orLikes = prefixes.map(() => "ip_address LIKE ?").join(" OR ");
          const sql = `SELECT COUNT(*) AS cnt FROM threats
                       WHERE (${orLikes}) AND source_feed != 'spamhaus_drop'`;
          const result = await db.prepare(sql).bind(...prefixes).first<{ cnt: number }>();
          overlapCount = result?.cnt ?? 0;
          // 6h TTL — spamhaus DROP list changes slowly, threats accrue
          // slowly enough that 6h staleness on a diagnostic counter is fine.
          await ctx.env.CACHE.put(cacheKey, String(overlapCount), { expirationTtl: 6 * 60 * 60 }).catch(() => null);
        }
      }
    } catch { /* non-fatal cross-reference */ }

    if (overlapCount > 0) {
      try {
        await db.prepare(
          `INSERT INTO agent_outputs (id, agent_id, type, summary, created_at)
           VALUES (?, 'sentinel', 'diagnostic', ?, datetime('now'))`,
        ).bind(
          `diag_drop_overlap_${Date.now()}`,
          `[spamhaus-drop] ${overlapCount} threat IPs fall within hijacked network ranges`,
        ).run();
      } catch { /* non-fatal */ }
    }

    return {
      itemsFetched: unique.length,
      itemsNew,
      itemsDuplicate: unique.length - itemsNew,
      itemsError: firstError ? 1 : 0,
    };
  },
};
