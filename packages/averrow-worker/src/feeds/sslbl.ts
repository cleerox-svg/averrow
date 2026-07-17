import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

const SSLBL_CSV_URL = "https://sslbl.abuse.ch/blacklist/sslblacklist.csv";
const SSLBL_IP_URL = "https://sslbl.abuse.ch/blacklist/sslipblacklist.csv";

/**
 * Abuse.ch SSLBL — SSL certificates associated with malware and botnets.
 * Also fetches IP blacklist for enrichment.
 * Schedule: daily.
 */
export const sslbl: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0, itemsFetched = 0;

    // 1. Fetch SSL certificate blacklist
    const certUrl = ctx.feedUrl || SSLBL_CSV_URL;
    const certRes = await fetch(certUrl, { signal: AbortSignal.timeout(30_000) });
    if (!certRes.ok) throw new Error(`SSLBL cert HTTP ${certRes.status}`);

    const certText = await certRes.text();
    const certLines = certText.split("\n").filter((l) => l.trim() && !l.startsWith("#"));

    const certItems = certLines.slice(0, 500);
    itemsFetched += certItems.length;

    for (const line of certItems) {
      // CSV: listing_date, sha1, listing_reason
      const parts = line.split(",").map((s) => s.trim());
      if (parts.length < 3) continue;

      const sha1 = parts[1]!;
      const reason = parts.slice(2).join(","); // reason may contain commas

      if (!sha1 || sha1.length !== 40) continue;

      try {
        if (await isDuplicate(ctx.env, "sha1", sha1)) { itemsDuplicate++; continue; }

        const threatType = classifyReason(reason);

        await insertThreat(ctx.env.DB, {
          id: threatId("sslbl", "sha1", sha1),
          source_feed: "sslbl",
          threat_type: threatType,
          malicious_url: null,
          malicious_domain: null,
          ioc_value: sha1,
          severity: threatType === "c2" ? "high" : "medium",
          confidence_score: 80,
        });
        await markSeen(ctx.env, "sha1", sha1);
        itemsNew++;
      } catch { itemsError++; }
    }

    // 2. Fetch IP blacklist for enrichment
    try {
      const ipRes = await fetch(SSLBL_IP_URL, { signal: AbortSignal.timeout(30_000) });
      if (ipRes.ok) {
        const ipText = await ipRes.text();
        const ipLines = ipText.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
        let enriched = 0;

        for (const line of ipLines) {
          const parts = line.split(",").map((s) => s.trim());
          // CSV: listing_date, ip, dst_port, listing_reason
          const ip = parts[1]?.trim();
          if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) continue;

          const existing = await ctx.env.DB.prepare(
            "SELECT id, confidence_score FROM threats WHERE ip_address = ? LIMIT 1"
          ).bind(ip).first<{ id: string; confidence_score: number | null }>();

          if (existing) {
            const newScore = Math.max(existing.confidence_score ?? 0, 85);
            await ctx.env.DB.prepare(
              "UPDATE threats SET confidence_score = ?, last_seen = datetime('now') WHERE id = ?"
            ).bind(newScore, existing.id).run();
            enriched++;
          }
        }
      }
    } catch (err) {
      console.warn(`[sslbl] IP blacklist fetch failed (non-fatal): ${err}`);
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};

function classifyReason(reason: string): ThreatRow["threat_type"] {
  const r = reason.toLowerCase();
  if (r.includes("c&c") || r.includes("c2")) return "c2";
  if (r.includes("dridex") || r.includes("emotet") || r.includes("qakbot") || r.includes("botnet")) return "botnet";
  return "malicious_ssl";
}
