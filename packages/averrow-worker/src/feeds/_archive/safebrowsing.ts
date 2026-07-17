import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat, recordFeedApiCall, markFeedQuotaExhausted } from "../lib/feedRunner";

/** Google Safe Browsing — Threat list updates (API key required) */
export const safebrowsing: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    if (!ctx.apiKey) throw new Error("Google Safe Browsing requires an API key");

    const url = `${ctx.feedUrl}?key=${ctx.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ctx.headers },
      body: JSON.stringify({
        client: { clientId: "trust-radar", clientVersion: "1.0" },
        listUpdateRequests: [
          { threatType: "MALWARE", platformType: "ANY_PLATFORM", threatEntryType: "URL" },
          { threatType: "SOCIAL_ENGINEERING", platformType: "ANY_PLATFORM", threatEntryType: "URL" },
          { threatType: "UNWANTED_SOFTWARE", platformType: "ANY_PLATFORM", threatEntryType: "URL" },
        ],
      }),
    });
    if (res.status === 429) {
      await markFeedQuotaExhausted(ctx.env, "google_safebrowsing", 10000);
      throw new Error("Safe Browsing: Daily API quota exceeded (HTTP 429). Free tier: 10,000/day.");
    }
    if (res.status === 400) throw new Error("Safe Browsing: Bad request — check API key and request format (HTTP 400)");
    if (res.status === 403) throw new Error("Safe Browsing: Invalid or unauthorized API key (HTTP 403)");
    if (!res.ok) throw new Error(`Safe Browsing HTTP ${res.status}`);
    await recordFeedApiCall(ctx.env, "google_safebrowsing");

    const body = await res.json() as {
      listUpdateResponses?: Array<{
        threatType: string;
        additions?: Array<{
          rawHashes?: { prefixSize: number; rawHashes: string };
          rawIndices?: { indices: number[] };
        }>;
        newClientState?: string;
        responseType?: string;
      }>;
    };

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const responses = body.listUpdateResponses ?? [];

    for (const listUpdate of responses) {
      try {
        const threatType = listUpdate.threatType;
        const type = threatType === "SOCIAL_ENGINEERING" ? "phishing" : "malware";
        const severity = threatType === "MALWARE" ? "critical" : "high";
        const key = `${threatType}:${listUpdate.newClientState ?? "update"}`;

        if (await isDuplicate(ctx.env, "domain", key)) { itemsDuplicate++; continue; }

        await insertThreat(ctx.env.DB, {
          id: threatId("safebrowsing", "domain", key),
          type,
          title: `Safe Browsing: ${threatType} list update`,
          description: `Google Safe Browsing ${threatType} threat list updated. ${listUpdate.additions?.length ?? 0} additions.`,
          severity,
          confidence: 0.95,
          source: "safebrowsing",
          source_ref: listUpdate.newClientState ?? threatType,
          ioc_type: "domain",
          ioc_value: key,
          tags: ["google", "safebrowsing", threatType.toLowerCase().replace(/_/g, "-")],
          metadata: {
            response_type: listUpdate.responseType,
            additions_count: listUpdate.additions?.length ?? 0,
            client_state: listUpdate.newClientState,
          },
          created_by: "safebrowsing",
        });
        await markSeen(ctx.env, "domain", key);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: responses.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
