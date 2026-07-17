import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat, recordFeedApiCall, markFeedQuotaExhausted } from "../lib/feedRunner";

/** IP Quality Score — Fraud detection and IP reputation (API key required) */
export const ipqs: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    if (!ctx.apiKey) throw new Error("IPQS requires an API key");

    const res = await fetch(ctx.feedUrl.replace("{key}", ctx.apiKey), {
      headers: { Accept: "application/json", ...ctx.headers },
    });
    if (res.status === 429) {
      // Free tier: 5,000/month ≈ 167/day
      await markFeedQuotaExhausted(ctx.env, "ipqs", 167);
      throw new Error("IPQS: Daily API quota exceeded (HTTP 429). Free tier: 5,000/month.");
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("IPQS: Invalid or unauthorized API key (HTTP " + res.status + ")");
    }
    if (!res.ok) throw new Error(`IPQS HTTP ${res.status}`);
    await recordFeedApiCall(ctx.env, "ipqs");

    const body = await res.json() as {
      success: boolean;
      data?: Array<{
        ip?: string;
        url?: string;
        domain?: string;
        fraud_score: number;
        country_code?: string;
        isp?: string;
        vpn?: boolean;
        tor?: boolean;
        proxy?: boolean;
        bot_status?: boolean;
        abuse_velocity?: string;
        recent_abuse?: boolean;
      }>;
    };

    if (!body.success || !body.data) {
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0, threatsCreated: 0 };
    }

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = body.data.slice(0, 500);

    for (const entry of items) {
      try {
        const value = entry.ip ?? entry.url ?? entry.domain;
        if (!value) continue;

        const iocType = entry.ip ? "ip" : entry.url ? "url" : "domain";
        if (await isDuplicate(ctx.env, iocType, value)) { itemsDuplicate++; continue; }

        const score = entry.fraud_score;
        const severity = score >= 90 ? "critical" : score >= 75 ? "high" : score >= 50 ? "medium" : "low";

        const flags: string[] = [];
        if (entry.vpn) flags.push("vpn");
        if (entry.tor) flags.push("tor");
        if (entry.proxy) flags.push("proxy");
        if (entry.bot_status) flags.push("bot");

        await insertThreat(ctx.env.DB, {
          id: threatId("ipqs", iocType, value),
          type: "reputation",
          title: `IPQS: ${value} (fraud score ${score})`,
          description: `Fraud score: ${score}/100. ${flags.length ? `Flags: ${flags.join(", ")}.` : ""} ISP: ${entry.isp ?? "N/A"}`,
          severity,
          confidence: score / 100,
          source: "ipqs",
          source_ref: value,
          ioc_type: iocType,
          ioc_value: value,
          ip_address: entry.ip,
          domain: entry.domain,
          country_code: entry.country_code,
          tags: ["ipqs", "fraud", ...flags],
          metadata: {
            fraud_score: score,
            vpn: entry.vpn,
            tor: entry.tor,
            proxy: entry.proxy,
            bot_status: entry.bot_status,
            abuse_velocity: entry.abuse_velocity,
            recent_abuse: entry.recent_abuse,
            isp: entry.isp,
          },
          created_by: "ipqs",
        });
        await markSeen(ctx.env, iocType, value);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
