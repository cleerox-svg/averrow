import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat, recordFeedApiCall, markFeedQuotaExhausted } from "../lib/feedRunner";

/** AbuseIPDB — Crowd-sourced IP abuse reports (API key required) */
export const abuseipdb: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    if (!ctx.apiKey) throw new Error("AbuseIPDB requires an API key");

    // Free tier: confidenceMinimum locked at 100 (default). Add limit param.
    const url = new URL(ctx.feedUrl);
    if (!url.searchParams.has("confidenceMinimum")) {
      url.searchParams.set("confidenceMinimum", "100");
    }
    if (!url.searchParams.has("limit")) {
      url.searchParams.set("limit", "1000");
    }

    const res = await fetch(url.toString(), {
      headers: {
        Key: ctx.apiKey,
        Accept: "application/json",
        ...ctx.headers,
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("AbuseIPDB: Invalid or expired API key (HTTP " + res.status + ")");
    }
    if (res.status === 429) {
      await markFeedQuotaExhausted(ctx.env, "abuseipdb", 1000);
      throw new Error("AbuseIPDB: Daily API quota exceeded (HTTP 429). Free tier: 1,000/day.");
    }
    if (res.status === 402) {
      throw new Error("AbuseIPDB: Feature requires paid plan (HTTP 402)");
    }
    if (!res.ok) throw new Error(`AbuseIPDB HTTP ${res.status}`);
    await recordFeedApiCall(ctx.env, "abuseipdb");

    const body = await res.json() as {
      data: Array<{
        ipAddress: string;
        abuseConfidenceScore: number;
        // Free tier only returns ipAddress, abuseConfidenceScore, lastReportedAt
        // Paid tier also includes: countryCode, isp, domain, totalReports, usageType
        countryCode?: string;
        isp?: string;
        domain?: string;
        totalReports?: number;
        lastReportedAt?: string;
        usageType?: string;
      }>;
    };

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = (body.data ?? []).slice(0, 1000);

    for (const entry of items) {
      try {
        if (await isDuplicate(ctx.env, "ip", entry.ipAddress)) { itemsDuplicate++; continue; }

        const score = entry.abuseConfidenceScore;
        const severity = score >= 90 ? "critical" : score >= 70 ? "high" : score >= 40 ? "medium" : "low";
        const reports = entry.totalReports ?? 0;

        await insertThreat(ctx.env.DB, {
          id: threatId("abuseipdb", "ip", entry.ipAddress),
          type: "reputation",
          title: `AbuseIPDB: ${entry.ipAddress} (${score}% confidence)`,
          description: reports > 0
            ? `${reports} abuse reports. ISP: ${entry.isp ?? "N/A"}. Usage: ${entry.usageType ?? "N/A"}`
            : `Abuse confidence: ${score}%. ISP: ${entry.isp ?? "N/A"}`,
          severity,
          confidence: score / 100,
          source: "abuseipdb",
          source_ref: entry.ipAddress,
          ioc_type: "ip",
          ioc_value: entry.ipAddress,
          ip_address: entry.ipAddress,
          country_code: entry.countryCode,
          domain: entry.domain,
          tags: ["abuseipdb", "reputation", "crowd-sourced"],
          metadata: {
            abuse_confidence: score,
            total_reports: reports,
            isp: entry.isp,
            usage_type: entry.usageType,
            last_reported: entry.lastReportedAt,
          },
          created_by: "abuseipdb",
        });
        await markSeen(ctx.env, "ip", entry.ipAddress);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError, threatsCreated: itemsNew };
  },
};
