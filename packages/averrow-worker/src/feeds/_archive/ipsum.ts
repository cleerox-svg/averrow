import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** IPsum — Aggregated threat intelligence IP reputation feed */
export const ipsum: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl);
    if (!res.ok) throw new Error(`IPsum HTTP ${res.status}`);

    const text = await res.text();
    const lines = text.split("\n").filter(l => l.trim() && !l.startsWith("#"));

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = lines.slice(0, 1000);

    for (const line of items) {
      try {
        // Format: IP<tab>score (score = number of blocklists that list it)
        const [ip, scoreStr] = line.split(/\s+/);
        if (!ip || !IP_RE.test(ip)) continue;

        const score = parseInt(scoreStr ?? "1", 10);
        if (await isDuplicate(ctx.env, "ip", ip)) { itemsDuplicate++; continue; }

        const severity = score >= 8 ? "critical" : score >= 5 ? "high" : score >= 3 ? "medium" : "low";

        await insertThreat(ctx.env.DB, {
          id: threatId("ipsum", "ip", ip),
          type: "reputation",
          title: `IPsum: ${ip} (score ${score})`,
          description: `IP listed on ${score} threat intelligence blocklist(s).`,
          severity,
          confidence: Math.min(0.5 + score * 0.06, 0.98),
          source: "ipsum",
          source_ref: ip,
          ioc_type: "ip",
          ioc_value: ip,
          ip_address: ip,
          tags: ["reputation", "blocklist", "aggregated"],
          metadata: { blocklist_count: score },
          created_by: "ipsum",
        });
        await markSeen(ctx.env, "ip", ip);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
