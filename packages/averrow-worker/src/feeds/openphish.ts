import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/** OpenPhish Community — Active phishing URLs (plaintext feed, no auth) */
export const openphish: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`OpenPhish HTTP ${res.status}`);

    const text = await res.text();
    const urls = text
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.startsWith("http"))
      .slice(0, 2000);

    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;

    for (const url of urls) {
      try {
        if (await isDuplicate(ctx.env, "url", url)) { itemsDuplicate++; continue; }

        const domain = extractDomain(url);

        await insertThreat(ctx.env.DB, {
          id: threatId("openphish", "url", url),
          source_feed: "openphish",
          threat_type: "phishing",
          malicious_url: url,
          malicious_domain: domain,
          ioc_value: url,
          severity: "high",
          confidence_score: 85,
        });
        await markSeen(ctx.env, "url", url);
        itemsNew++;
      } catch { itemsError++; }
    }

    return { itemsFetched: urls.length, itemsNew, itemsDuplicate, itemsError };
  },
};
