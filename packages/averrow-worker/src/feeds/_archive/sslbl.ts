import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/** abuse.ch SSL Blocklist — Malicious SSL certificates */
export const sslbl: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl);
    if (!res.ok) throw new Error(`SSLBL HTTP ${res.status}`);

    const text = await res.text();
    const lines = text.split("\n").filter(l => l.trim() && !l.startsWith("#"));

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = lines.slice(0, 500);

    for (const line of items) {
      try {
        // CSV format: timestamp,sha1,reason
        const parts = line.split(",");
        if (parts.length < 3) continue;

        const [timestamp, sha1, reason] = parts.map(p => p.trim());
        if (!sha1 || sha1.length !== 40) continue;

        if (await isDuplicate(ctx.env, "hash", sha1)) { itemsDuplicate++; continue; }

        const reasonLower = reason?.toLowerCase() ?? "";
        const severity = reasonLower.includes("c2") || reasonLower.includes("botnet") ? "critical" : "high";

        await insertThreat(ctx.env.DB, {
          id: threatId("sslbl", "hash", sha1),
          type: reasonLower.includes("c2") ? "c2" : "malware",
          title: `SSLBL: ${sha1.slice(0, 12)}… — ${reason}`,
          description: `Malicious SSL certificate (SHA1: ${sha1}). Reason: ${reason}`,
          severity,
          confidence: 0.9,
          source: "sslbl",
          source_ref: sha1,
          ioc_type: "hash",
          ioc_value: sha1,
          tags: ["ssl", "certificate", ...(reason ? [reasonLower.replace(/\s+/g, "-")] : [])],
          metadata: { timestamp, sha1, reason },
          created_by: "sslbl",
        });
        await markSeen(ctx.env, "hash", sha1);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
