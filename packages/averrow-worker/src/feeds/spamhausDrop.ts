import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { dedupeBy, parseDropV4Json } from "../lib/spamhaus-drop-json";

/**
 * drop_v4.json (NDJSON + trailing metadata line). The text files
 * (drop.txt) are slated for deprecation by Spamhaus, and edrop.txt has been
 * a comment-only stub since eDROP was merged into DROP on 2024-04-10, so
 * it is no longer fetched. IPv4 only, as before (drop_v6.json is a
 * follow-up — threats.ip_address has never carried v6 DROP ranges).
 */
export const DROP_V4_URL = "https://www.spamhaus.org/drop/drop_v4.json";
const FETCH_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 50;

/**
 * Spamhaus DROP — Hijacked network ranges (CIDR blocks).
 *
 * These are entire network ranges allocated to spammers or hijacked for
 * malware/botnet operations. Gold-standard network-level blocklist.
 *
 * Licence: free for any business, "when used in a product, credit must be
 * given to The Spamhaus Project, and the date and © text should remain with
 * the file and data" (spamhaus.org/blocklists/do-not-route-or-peer/). The
 * credit lives on the feed_configs row (migration 0327). Spamhaus's DROP
 * terms §3.2 also forbid the Spamhaus name in marketing material.
 *
 * Schedule: daily (feed_configs interval). No API key required. Spamhaus
 * asks for at most one automated download per hour.
 */
export const spamhaus_drop: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const db = ctx.env.DB;

    const res = await fetch(DROP_V4_URL, {
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`spamhaus_drop: HTTP ${res.status} fetching drop_v4.json`);

    const parsed = parseDropV4Json(await res.text());
    if (parsed.records.length === 0) {
      throw new Error(`spamhaus_drop: drop_v4.json parsed 0 records (${parsed.malformed} malformed lines)`);
    }

    // Deduplicate by CIDR
    const unique = dedupeBy(parsed.records, (e) => e.cidr);

    const warnings: string[] = [];
    if (parsed.malformed > 0) warnings.push(`${parsed.malformed} malformed/non-IPv4 lines skipped`);
    if (!parsed.metadata) warnings.push("metadata line missing");
    // Completeness uses the PRE-dedupe parsed count: metadata.records counts
    // lines, and the live list carries a duplicate CIDR (1759 lines, 1758
    // unique), which made the deduped count warn on every pull.
    else if (parsed.metadata.records !== null && parsed.records.length < parsed.metadata.records) {
      warnings.push(`parsed ${parsed.records.length} of ${parsed.metadata.records} records`);
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
      ...(warnings.length > 0 ? { warning: `spamhaus_drop: ${warnings.join("; ")}` } : {}),
    };
  },
};
