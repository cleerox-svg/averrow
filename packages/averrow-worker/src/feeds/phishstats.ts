import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/**
 * PhishStats — public phishing URL feed.
 *
 * https://phishstats.info — community-maintained, no auth required.
 * Tier-A volume add: complements openphish / phishtank with a third
 * independent corpus. Score field is 0-10 with their own scaling;
 * we map ≥6 → high severity, ≥3 → medium, lower → low.
 *
 * The default API endpoint serves the last ~500 entries; we cap the
 * SIZE param explicitly to keep the response bounded.
 */
const PHISHSTATS_API = "https://phishstats.info:2096/api/phishing";
const SIZE = 500;

interface PhishStatsRow {
  url?: string;
  ip?: string;
  countrycode?: string;
  score?: number;          // 0-10
  host?: string;
  target?: string | null;
  date?: string;
  id?: string | number;
}

function severityFor(score: number | undefined): "critical" | "high" | "medium" | "low" | "info" {
  if (score === undefined || score === null) return "medium";
  if (score >= 8) return "high";
  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function confidenceFor(score: number | undefined): number {
  // PhishStats score 0-10 → confidence 0-100. Cap floor at 50 since
  // every entry has already passed their internal phishing filter.
  if (score === undefined || score === null) return 70;
  return Math.min(95, Math.max(50, Math.round(score * 10)));
}

export const phishstats: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const url = (ctx.feedUrl || PHISHSTATS_API) +
      (ctx.feedUrl?.includes("?") ? "&" : "?") +
      `_sort=-date&_size=${SIZE}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Averrow-ThreatIntel/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`PhishStats HTTP ${res.status}`);

    const body = (await res.json()) as PhishStatsRow[];
    if (!Array.isArray(body)) {
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    for (const row of body) {
      if (!row.url || typeof row.url !== "string") continue;
      itemsFetched++;
      try {
        if (await isDuplicate(ctx.env, "url", row.url)) {
          itemsDuplicate++;
          continue;
        }

        const domain = row.host?.toLowerCase() || extractDomain(row.url);

        await insertThreat(ctx.env.DB, {
          id: threatId("phishstats", "url", row.url),
          source_feed: "phishstats",
          threat_type: "phishing",
          malicious_url: row.url,
          malicious_domain: domain,
          ip_address: row.ip ?? null,
          country_code: row.countrycode ?? null,
          ioc_value: row.url,
          severity: severityFor(row.score),
          confidence_score: confidenceFor(row.score),
          status: "active",
        });
        await markSeen(ctx.env, "url", row.url);
        itemsNew++;
      } catch (err) {
        itemsError++;
        console.error(`[phishstats] insert error for ${row.url}:`, err);
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
