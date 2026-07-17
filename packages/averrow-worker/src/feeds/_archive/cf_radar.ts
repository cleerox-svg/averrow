import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat, recordFeedApiCall } from "../lib/feedRunner";

const BASE = "https://api.cloudflare.com/client/v4/radar/attacks/layer3";

/**
 * Cloudflare Radar — L3/L7 attack trend intelligence
 *
 * Calls multiple Radar summary endpoints:
 *   /summary/protocol  — attack distribution by protocol (TCP, UDP, GRE, ICMP)
 *   /summary/vector    — attack distribution by vector (DNS, SYN, NTP, etc.)
 *   /top/locations/origin — top origin countries of attacks
 */
export const cf_radar: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
      ...ctx.headers,
    };

    const dateParam = "dateRange=7d&format=json";
    const today = new Date().toISOString().slice(0, 10);

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    let totalFetched = 0;

    // ── 1. Protocol summary (TCP, UDP, GRE, ICMP distribution) ─────
    try {
      const protoRes = await fetch(`${BASE}/summary/protocol?${dateParam}`, { headers });
      if (protoRes.status === 429) throw new Error("CF Radar: API rate limit exceeded (HTTP 429)");
      if (protoRes.status === 401 || protoRes.status === 403) {
        throw new Error("CF Radar: Invalid or unauthorized API token (HTTP " + protoRes.status + ")");
      }
      if (!protoRes.ok) throw new Error(`CF Radar /summary/protocol HTTP ${protoRes.status}`);
      await recordFeedApiCall(ctx.env, "cf_radar");

      const protoBody = await protoRes.json() as CFRadarSummaryResponse;
      const protocols = protoBody.result?.summary_0 ?? {};

      for (const [protocol, pctStr] of Object.entries(protocols)) {
        const pct = parseFloat(pctStr);
        if (isNaN(pct)) continue;
        totalFetched++;

        const key = `cf-radar:proto:${protocol}:${today}`;
        if (await isDuplicate(ctx.env, "domain", key)) { itemsDuplicate++; continue; }

        await insertThreat(ctx.env.DB, {
          id: threatId("cf_radar", "domain", key),
          type: "reputation",
          title: `CF Radar: ${protocol} attacks (${pct.toFixed(1)}% of L3 traffic)`,
          description: `Cloudflare Radar: ${protocol} accounts for ${pct.toFixed(1)}% of layer 3 attack traffic over the past 7 days.`,
          severity: pct > 40 ? "high" : pct > 15 ? "medium" : "low",
          confidence: 0.9,
          source: "cf_radar",
          source_ref: key,
          ioc_type: "domain",
          ioc_value: protocol,
          tags: ["cloudflare", "radar", "l3-attack", "protocol", protocol.toLowerCase()],
          metadata: { dimension: "protocol", name: protocol, percentage: pct, date: today },
          created_by: "cf_radar",
        });
        await markSeen(ctx.env, "domain", key);
        itemsNew++;
      }
    } catch (err) {
      if (err instanceof Error && (err.message.includes("401") || err.message.includes("403"))) throw err;
      itemsError++;
    }

    // ── 2. Attack vector summary (SYN flood, DNS amp, NTP, etc.) ───
    try {
      const vecRes = await fetch(`${BASE}/summary/vector?${dateParam}`, { headers });
      if (vecRes.status === 429) throw new Error("CF Radar: API rate limit exceeded (HTTP 429)");
      if (vecRes.ok) {
        await recordFeedApiCall(ctx.env, "cf_radar");
        const vecBody = await vecRes.json() as CFRadarSummaryResponse;
        const vectors = vecBody.result?.summary_0 ?? {};

        for (const [vector, pctStr] of Object.entries(vectors)) {
          const pct = parseFloat(pctStr);
          if (isNaN(pct)) continue;
          totalFetched++;

          const key = `cf-radar:vector:${vector}:${today}`;
          if (await isDuplicate(ctx.env, "domain", key)) { itemsDuplicate++; continue; }

          await insertThreat(ctx.env.DB, {
            id: threatId("cf_radar", "domain", key),
            type: "reputation",
            title: `CF Radar: ${vector} attack vector (${pct.toFixed(1)}%)`,
            description: `Cloudflare Radar: ${vector} represents ${pct.toFixed(1)}% of layer 3 attack vectors over the past 7 days.`,
            severity: pct > 30 ? "high" : pct > 10 ? "medium" : "low",
            confidence: 0.9,
            source: "cf_radar",
            source_ref: key,
            ioc_type: "domain",
            ioc_value: vector,
            tags: ["cloudflare", "radar", "l3-attack", "vector", vector.toLowerCase().replace(/\s+/g, "-")],
            metadata: { dimension: "vector", name: vector, percentage: pct, date: today },
            created_by: "cf_radar",
          });
          await markSeen(ctx.env, "domain", key);
          itemsNew++;
        }
      }
    } catch { itemsError++; }

    // ── 3. Top origin locations of attacks ──────────────────────────
    try {
      const locRes = await fetch(`${BASE}/top/locations/origin?${dateParam}&limit=10`, { headers });
      if (locRes.status === 429) throw new Error("CF Radar: API rate limit exceeded (HTTP 429)");
      if (locRes.ok) {
        await recordFeedApiCall(ctx.env, "cf_radar");
        const locBody = await locRes.json() as CFRadarTopResponse;
        const locations = locBody.result?.top_0 ?? [];

        for (const loc of locations) {
          totalFetched++;
          const key = `cf-radar:origin:${loc.clientCountryAlpha2}:${today}`;
          if (await isDuplicate(ctx.env, "domain", key)) { itemsDuplicate++; continue; }

          await insertThreat(ctx.env.DB, {
            id: threatId("cf_radar", "domain", key),
            type: "reputation",
            title: `CF Radar: Top attack origin — ${loc.clientCountryName} (${parseFloat(loc.value).toFixed(1)}%)`,
            description: `Cloudflare Radar: ${loc.clientCountryName} (${loc.clientCountryAlpha2}) is a top source of L3 attack traffic at ${parseFloat(loc.value).toFixed(1)}% over the past 7 days.`,
            severity: parseFloat(loc.value) > 20 ? "high" : "medium",
            confidence: 0.85,
            source: "cf_radar",
            source_ref: key,
            ioc_type: "domain",
            ioc_value: loc.clientCountryAlpha2,
            country_code: loc.clientCountryAlpha2,
            tags: ["cloudflare", "radar", "attack-origin", loc.clientCountryAlpha2.toLowerCase()],
            metadata: { dimension: "origin_location", country: loc.clientCountryName, country_code: loc.clientCountryAlpha2, percentage: parseFloat(loc.value), date: today },
            created_by: "cf_radar",
          });
          await markSeen(ctx.env, "domain", key);
          itemsNew++;
        }
      }
    } catch { itemsError++; }

    return { itemsFetched: totalFetched, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};

// ─── Response types matching actual CF Radar API ────────────────

interface CFRadarSummaryResponse {
  result?: {
    meta?: { dateRange: Array<{ startTime: string; endTime: string }>; normalization: string };
    summary_0?: Record<string, string>; // e.g. {"TCP": "70.5", "UDP": "20.1", "GRE": "5.2"}
  };
  success?: boolean;
}

interface CFRadarTopResponse {
  result?: {
    meta?: { dateRange: Array<{ startTime: string; endTime: string }> };
    top_0?: Array<{
      clientCountryAlpha2: string;
      clientCountryName: string;
      value: string;
    }>;
  };
  success?: boolean;
}
