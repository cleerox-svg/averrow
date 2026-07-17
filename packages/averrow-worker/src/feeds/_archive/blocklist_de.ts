import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** blocklist.de — Fail2Ban-aggregated attack IPs */
export const blocklist_de: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl);
    if (!res.ok) throw new Error(`blocklist.de HTTP ${res.status}`);

    const text = await res.text();
    const lines = text.split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#") && IP_RE.test(l));

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = lines.slice(0, 1000);

    for (const ip of items) {
      try {
        if (await isDuplicate(ctx.env, "ip", ip)) { itemsDuplicate++; continue; }

        await insertThreat(ctx.env.DB, {
          id: threatId("blocklist_de", "ip", ip),
          type: "reputation",
          title: `blocklist.de: ${ip}`,
          description: `IP reported for brute-force / abuse attacks by blocklist.de network.`,
          severity: "medium",
          confidence: 0.8,
          source: "blocklist_de",
          source_ref: ip,
          ioc_type: "ip",
          ioc_value: ip,
          ip_address: ip,
          tags: ["blocklist", "brute-force", "fail2ban"],
          metadata: {},
          created_by: "blocklist_de",
        });
        await markSeen(ctx.env, "ip", ip);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
