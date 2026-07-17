import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/** SANS Internet Storm Center — Top attacking IPs */
export const sans_isc: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl, {
      headers: { Accept: "application/json", ...ctx.headers },
    });
    if (!res.ok) throw new Error(`SANS ISC HTTP ${res.status}`);

    const data = await res.json() as Array<{
      ip: string;
      count: number;
      attacks: number;
      firstseen?: string;
      lastseen?: string;
      comment?: string;
      network?: string;
      asname?: string;
      ascountry?: string;
    }>;

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = (Array.isArray(data) ? data : []).slice(0, 500);

    for (const entry of items) {
      try {
        if (!entry.ip) continue;
        if (await isDuplicate(ctx.env, "ip", entry.ip)) { itemsDuplicate++; continue; }

        const severity = entry.attacks > 1000 ? "critical" : entry.attacks > 100 ? "high" : "medium";

        await insertThreat(ctx.env.DB, {
          id: threatId("sans_isc", "ip", entry.ip),
          type: "malware",
          title: `SANS ISC: ${entry.ip} (${entry.attacks} attacks)`,
          description: `Top attacking IP reported by SANS ISC. ${entry.count} reports, ${entry.attacks} attacks.${entry.asname ? ` AS: ${entry.asname}` : ""}`,
          severity,
          confidence: 0.85,
          source: "sans_isc",
          source_ref: entry.ip,
          ioc_type: "ip",
          ioc_value: entry.ip,
          ip_address: entry.ip,
          country_code: entry.ascountry,
          tags: ["sans", "isc", "attacking-ip"],
          metadata: {
            count: entry.count,
            attacks: entry.attacks,
            network: entry.network,
            asname: entry.asname,
            firstseen: entry.firstseen,
            lastseen: entry.lastseen,
          },
          created_by: "sans_isc",
        });
        await markSeen(ctx.env, "ip", entry.ip);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
