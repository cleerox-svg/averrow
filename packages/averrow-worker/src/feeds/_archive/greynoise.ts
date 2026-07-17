import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat, recordFeedApiCall, markFeedQuotaExhausted } from "../lib/feedRunner";

/** GreyNoise — Internet scanner and mass exploitation detection (API key required) */
export const greynoise: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    if (!ctx.apiKey) throw new Error("GreyNoise requires an API key");

    const res = await fetch(ctx.feedUrl, {
      headers: {
        key: ctx.apiKey,
        Accept: "application/json",
        ...ctx.headers,
      },
    });
    if (res.status === 429) {
      // Community tier: 50 req/day
      await markFeedQuotaExhausted(ctx.env, "greynoise", 50);
      throw new Error("GreyNoise: Daily API quota exceeded (HTTP 429). Community tier: 50 req/day.");
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("GreyNoise: Invalid or unauthorized API key (HTTP " + res.status + ")");
    }
    if (!res.ok) throw new Error(`GreyNoise HTTP ${res.status}`);
    await recordFeedApiCall(ctx.env, "greynoise");

    const body = await res.json() as {
      data?: Array<{
        ip: string;
        classification: string; // "malicious", "benign", "unknown"
        noise: boolean;
        riot: boolean;
        name?: string;
        last_seen?: string;
        first_seen?: string;
        tags?: string[];
        cve?: string[];
        metadata?: {
          country?: string;
          country_code?: string;
          asn?: string;
          org?: string;
          os?: string;
        };
        raw_data?: {
          scan?: Array<{ port: number; protocol: string }>;
        };
      }>;
      count?: number;
    };

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = (body.data ?? []).slice(0, 500);

    for (const entry of items) {
      try {
        if (entry.classification !== "malicious") continue;
        if (await isDuplicate(ctx.env, "ip", entry.ip)) { itemsDuplicate++; continue; }

        const hasCVEs = entry.cve && entry.cve.length > 0;
        const severity = hasCVEs ? "critical" : "high";

        await insertThreat(ctx.env.DB, {
          id: threatId("greynoise", "ip", entry.ip),
          type: "malware",
          title: `GreyNoise: ${entry.ip}${entry.name ? ` (${entry.name})` : ""}`,
          description: `Malicious scanner/exploiter. ${hasCVEs ? `CVEs: ${entry.cve!.join(", ")}. ` : ""}${entry.tags?.length ? `Tags: ${entry.tags.join(", ")}` : ""}`,
          severity,
          confidence: 0.9,
          source: "greynoise",
          source_ref: entry.ip,
          ioc_type: "ip",
          ioc_value: entry.ip,
          ip_address: entry.ip,
          country_code: entry.metadata?.country_code,
          tags: [
            "greynoise", "scanner",
            ...(entry.tags ?? []).map(t => t.toLowerCase()),
            ...(entry.cve ?? []).map(c => c.toLowerCase()),
          ],
          metadata: {
            classification: entry.classification,
            noise: entry.noise,
            riot: entry.riot,
            name: entry.name,
            first_seen: entry.first_seen,
            last_seen: entry.last_seen,
            asn: entry.metadata?.asn,
            org: entry.metadata?.org,
            os: entry.metadata?.os,
            scanned_ports: entry.raw_data?.scan?.map(s => `${s.port}/${s.protocol}`),
          },
          created_by: "greynoise",
        });
        await markSeen(ctx.env, "ip", entry.ip);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
