import type { FeedModule, FeedContext, FeedResult } from "./types";

const TOR_EXIT_URL = "https://check.torproject.org/torbulkexitlist";
const BATCH_SIZE = 50;
const IP_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Tor Exit Nodes — Current Tor network exit node IPs from torproject.org.
 *
 * Maintains a lookup table (tor_exit_nodes) for cross-referencing with
 * existing threats. Does NOT create threat records — Tor exit nodes are
 * legitimate infrastructure, but attacks originating from them warrant flagging.
 *
 * Schedule: daily at 04:00. No API key required.
 */
export const tor_exit_nodes: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const db = ctx.env.DB;
    const url = ctx.feedUrl || TOR_EXIT_URL;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "Averrow-ThreatIntel/1.0" },
    });
    if (!res.ok) throw new Error(`Tor Exit Nodes HTTP ${res.status}`);

    const text = await res.text();
    const allIps = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && IP_REGEX.test(l));

    const uniqueIps = [...new Set(allIps)];

    // Truncate and reload — point-in-time snapshot
    await db.prepare("DELETE FROM tor_exit_nodes").run();

    let itemsNew = 0;
    let firstError: string | null = null;

    for (let i = 0; i < uniqueIps.length; i += BATCH_SIZE) {
      const batch = uniqueIps.slice(i, i + BATCH_SIZE);
      const stmts = batch.map((ip) =>
        db.prepare(
          `INSERT OR IGNORE INTO tor_exit_nodes (ip_address, last_seen, source)
           VALUES (?, datetime('now'), 'torproject')`,
        ).bind(ip),
      );

      try {
        const results = await db.batch(stmts);
        itemsNew += results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
      } catch (e) {
        if (!firstError) firstError = String(e);
      }
    }

    // Tag existing threats that originate from Tor exit nodes
    let taggedCount = 0;
    try {
      const tagResult = await db.prepare(
        `UPDATE threats SET tags = json_insert(COALESCE(tags, '[]'), '$[#]', 'tor_exit_node')
         WHERE ip_address IN (SELECT ip_address FROM tor_exit_nodes)
         AND (tags IS NULL OR tags NOT LIKE '%tor_exit_node%')`,
      ).run();
      taggedCount = tagResult.meta.changes ?? 0;
    } catch { /* non-fatal tagging */ }

    if (taggedCount > 0) {
      try {
        await db.prepare(
          `INSERT INTO agent_outputs (id, agent_id, type, summary, created_at)
           VALUES (?, 'sentinel', 'diagnostic', ?, datetime('now'))`,
        ).bind(
          `diag_tor_tagged_${Date.now()}`,
          `[tor] Tagged ${taggedCount} threats as originating from Tor exit nodes`,
        ).run();
      } catch { /* non-fatal */ }
    }

    return {
      itemsFetched: uniqueIps.length,
      itemsNew,
      itemsDuplicate: 0,
      itemsError: firstError ? 1 : 0,
    };
  },
};
