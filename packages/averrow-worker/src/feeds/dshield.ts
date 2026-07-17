import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

const DSHIELD_URL = "https://isc.sans.edu/api/topips/records/100?json";

/**
 * SANS DShield — Top attacking IPs from Internet Storm Center honeypots.
 * Enriches existing threats with known-attacker data and adds new scanning threats.
 * Schedule: every 6 hours.
 */
export const dshield: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const url = ctx.feedUrl || DSHIELD_URL;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json", "User-Agent": "Averrow-ThreatIntel/1.0" },
    });
    if (!res.ok) throw new Error(`DShield HTTP ${res.status}`);

    const data = await res.json() as Array<Record<string, unknown>>;
    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;

    for (const entry of data) {
      const ip = String(entry.source ?? entry.ip ?? "").trim();
      if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) continue;

      try {
        // Check if this IP exists in any existing threat
        const existing = await ctx.env.DB.prepare(
          "SELECT id, confidence_score FROM threats WHERE ip_address = ? LIMIT 1"
        ).bind(ip).first<{ id: string; confidence_score: number | null }>();

        if (existing) {
          // Enrich: known attacker → boost confidence
          const newScore = Math.max(existing.confidence_score ?? 0, 85);
          await ctx.env.DB.prepare(
            "UPDATE threats SET confidence_score = ?, last_seen = datetime('now') WHERE id = ?"
          ).bind(newScore, existing.id).run();
          itemsDuplicate++; // Count as enrichment, not new
          continue;
        }

        if (await isDuplicate(ctx.env, "ip", ip)) { itemsDuplicate++; continue; }

        await insertThreat(ctx.env.DB, {
          id: threatId("dshield", "ip", ip),
          source_feed: "dshield",
          threat_type: "scanning",
          malicious_url: null,
          malicious_domain: null,
          ip_address: ip,
          ioc_value: ip,
          severity: "medium",
          confidence_score: 70,
        });
        await markSeen(ctx.env, "ip", ip);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: data.length, itemsNew, itemsDuplicate, itemsError };
  },
};
