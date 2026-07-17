import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Spamhaus DROP — Don't Route Or Peer list */
export const spamhaus: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl);
    if (!res.ok) throw new Error(`Spamhaus HTTP ${res.status}`);

    const text = await res.text();
    const lines = text.split("\n").filter(l => l.trim() && !l.startsWith(";"));

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = lines.slice(0, 1000);

    for (const line of items) {
      try {
        // Format: CIDR ; SBL_ID
        const [cidr, sblId] = line.split(";").map(s => s.trim());
        if (!cidr) continue;

        const ip = cidr.split("/")[0];
        if (!ip || !IP_RE.test(ip)) continue;

        if (await isDuplicate(ctx.env, "ip", cidr)) { itemsDuplicate++; continue; }

        await insertThreat(ctx.env.DB, {
          id: threatId("spamhaus", "ip", cidr),
          type: "reputation",
          title: `Spamhaus DROP: ${cidr}`,
          description: `Network block listed in Spamhaus DROP (Don't Route Or Peer). SBL: ${sblId ?? "N/A"}`,
          severity: "high",
          confidence: 0.95,
          source: "spamhaus",
          source_ref: sblId ?? cidr,
          ioc_type: "ip",
          ioc_value: cidr,
          ip_address: ip,
          tags: ["spamhaus", "drop", "blocklist", "hijacked"],
          metadata: { cidr, sbl_id: sblId },
          created_by: "spamhaus",
        });
        await markSeen(ctx.env, "ip", cidr);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
