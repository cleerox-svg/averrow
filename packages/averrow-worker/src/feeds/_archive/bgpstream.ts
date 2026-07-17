import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/** BGPStream — BGP hijack and route leak detection */
export const bgpstream: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl, {
      headers: { Accept: "application/json", ...ctx.headers },
    });
    if (!res.ok) throw new Error(`BGPStream HTTP ${res.status}`);

    const data = await res.json() as {
      data?: Array<{
        id: number;
        event_type: string; // "moas", "submoas", "defcon", "edges"
        prefix?: string;
        detected_as_path?: string;
        expected_as_path?: string;
        as_number?: number;
        as_name?: string;
        country?: string;
        start_time?: string;
        duration?: number;
        summary?: string;
      }>;
    };

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = (data.data ?? []).slice(0, 300);

    for (const event of items) {
      try {
        const key = `${event.id ?? ""}:${event.prefix ?? ""}:${event.event_type}`;
        if (await isDuplicate(ctx.env, "ip", key)) { itemsDuplicate++; continue; }

        const severity = event.event_type === "defcon" ? "critical"
          : event.event_type === "moas" ? "high" : "medium";

        await insertThreat(ctx.env.DB, {
          id: threatId("bgpstream", "ip", key),
          type: "reputation",
          title: `BGPStream: ${event.event_type.toUpperCase()} — ${event.prefix ?? "N/A"}`,
          description: `BGP ${event.event_type} event for prefix ${event.prefix ?? "N/A"}. AS${event.as_number ?? "?"} (${event.as_name ?? "unknown"})${event.summary ? `. ${event.summary}` : ""}`,
          severity,
          confidence: 0.85,
          source: "bgpstream",
          source_ref: String(event.id ?? key),
          ioc_type: "ip",
          ioc_value: event.prefix ?? key,
          ip_address: event.prefix?.split("/")[0],
          country_code: event.country,
          tags: ["bgp", event.event_type, "routing", "hijack"],
          metadata: {
            event_type: event.event_type,
            prefix: event.prefix,
            as_number: event.as_number,
            as_name: event.as_name,
            detected_path: event.detected_as_path,
            expected_path: event.expected_as_path,
            start_time: event.start_time,
            duration: event.duration,
          },
          created_by: "bgpstream",
        });
        await markSeen(ctx.env, "ip", key);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
