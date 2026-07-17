import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/** PhishTank Community — Verified phishing URLs (bulk download) */
export const phishtank: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const feedUrl = "http://data.phishtank.com/data/online-valid.json";
    let res: Response;
    try {
      res = await fetch(feedUrl, {
        headers: { "User-Agent": "Averrow-ThreatIntel/1.0 (contact: support@averrow.com)" },
        signal: AbortSignal.timeout(60000),
      });
    } catch (fetchErr) {
      console.error(`[phishtank] fetch error:`, fetchErr instanceof Error ? fetchErr.message : String(fetchErr));
      throw new Error(`PhishTank fetch failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[phishtank] HTTP ${res.status}: ${body.slice(0, 200)}`);
      throw new Error(`PhishTank HTTP ${res.status}: ${body.slice(0, 100)}`);
    }

    // Guard: PhishTank returns a JPEG captcha/block page instead of JSON when blocked
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json") && !contentType.includes("text")) {
      console.error(`[phishtank] unexpected content-type: ${contentType} — likely blocked/captcha`);
      throw new Error(`PhishTank returned non-JSON content-type: ${contentType}`);
    }

    // Additional guard: check first bytes for image magic bytes
    const rawText = await res.text();
    if (rawText.length > 0 && !rawText.trimStart().startsWith("[") && !rawText.trimStart().startsWith("{")) {
      console.error(`[phishtank] response body does not look like JSON (starts with: ${rawText.slice(0, 20)})`);
      throw new Error("PhishTank response is not JSON — possible captcha or block page");
    }

    const data = JSON.parse(rawText) as Array<{
      phish_id: number; url: string; phish_detail_url?: string;
      submission_time?: string; verified?: string; target?: string;
    }>;
    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    const items = (Array.isArray(data) ? data : []).slice(0, 2000);

    for (const entry of items) {
      try {
        if (await isDuplicate(ctx.env, "url", entry.url)) { itemsDuplicate++; continue; }

        const domain = extractDomain(entry.url);

        await insertThreat(ctx.env.DB, {
          id: threatId("phishtank", "url", entry.url),
          source_feed: "phishtank",
          threat_type: "phishing",
          malicious_url: entry.url,
          malicious_domain: domain,
          ioc_value: entry.url,
          severity: "high",
          confidence_score: entry.verified === "yes" ? 95 : 70,
        });
        await markSeen(ctx.env, "url", entry.url);
        itemsNew++;
      } catch (e) {
        itemsError++;
        if (itemsError <= 3) console.error(`[phishtank] item error: ${e}`);
      }
    }

    return { itemsFetched: items.length, itemsNew, itemsDuplicate, itemsError };
  },
};
