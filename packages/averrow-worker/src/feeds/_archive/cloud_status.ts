import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/** Cloud Provider Status — Google Cloud incident feed */
export const cloud_status: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl, {
      headers: { Accept: "application/json", ...ctx.headers },
    });
    if (!res.ok) throw new Error(`Cloud Status HTTP ${res.status}`);

    // Google Cloud Status returns a flat array of incidents
    const data = await res.json() as Array<{
      id?: string;
      number?: number;
      begin?: string;
      end?: string;
      external_desc?: string;
      service_name?: string;
      severity?: string;       // "low", "medium", "high"
      status_impact?: string;  // "SERVICE_DISRUPTION", "SERVICE_OUTAGE", etc.
      most_recent_update?: { text?: string; when?: string };
    }>;

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = (Array.isArray(data) ? data : []).slice(0, 100);

    for (const incident of items) {
      try {
        const key = incident.id ?? `${incident.number ?? ""}:${(incident.external_desc ?? "").slice(0, 180)}`;
        if (!key) continue;
        if (await isDuplicate(ctx.env, "domain", key)) { itemsDuplicate++; continue; }

        const severity = incident.severity === "high" || incident.status_impact === "SERVICE_OUTAGE" ? "high" : "medium";

        await insertThreat(ctx.env.DB, {
          id: threatId("cloud_status", "domain", key),
          type: "reputation",
          title: `Cloud Status: ${incident.service_name ?? "GCP"} — ${(incident.external_desc ?? "Incident").slice(0, 80)}`,
          description: incident.external_desc ?? incident.most_recent_update?.text ?? "Cloud provider incident",
          severity,
          confidence: 0.99,
          source: "cloud_status",
          source_ref: key,
          ioc_type: "domain",
          ioc_value: incident.service_name ?? "gcp",
          tags: [
            "cloud", "outage", "availability",
            ...(incident.service_name ? [incident.service_name.toLowerCase().replace(/\s+/g, "-")] : []),
          ],
          metadata: {
            service: incident.service_name,
            severity: incident.severity,
            status_impact: incident.status_impact,
            begin: incident.begin,
            end: incident.end,
          },
          created_by: "cloud_status",
        });
        await markSeen(ctx.env, "domain", key);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
