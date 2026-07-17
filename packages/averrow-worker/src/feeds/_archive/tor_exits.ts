import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** TorProject — Active Tor exit node list */
export const tor_exits: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl);
    if (!res.ok) throw new Error(`Tor Exits HTTP ${res.status}`);

    const text = await res.text();
    const lines = text.split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#") && IP_RE.test(l));

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = lines.slice(0, 2000);

    for (const ip of items) {
      try {
        if (await isDuplicate(ctx.env, "ip", ip)) { itemsDuplicate++; continue; }

        await insertThreat(ctx.env.DB, {
          id: threatId("tor_exits", "ip", ip),
          type: "reputation",
          title: `Tor Exit: ${ip}`,
          description: `Active Tor exit node. Traffic from this IP may be anonymized.`,
          severity: "medium",
          confidence: 0.95,
          source: "tor_exits",
          source_ref: ip,
          ioc_type: "ip",
          ioc_value: ip,
          ip_address: ip,
          tags: ["tor", "exit-node", "anonymizer"],
          metadata: {},
          created_by: "tor_exits",
        });
        await markSeen(ctx.env, "ip", ip);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
