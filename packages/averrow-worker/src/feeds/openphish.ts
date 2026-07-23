import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId, extractDomain } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";

/** OpenPhish Community — Active phishing URLs (plaintext feed, no auth) */
export const openphish: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`OpenPhish HTTP ${res.status}`);

    const text = await res.text();

    // Parse → dedupe within the payload → bulk insert. No per-row KV
    // round-trips (see lib/feedRunner bulkInsertThreats).
    const seen = new Set<string>();
    const rows: ThreatRow[] = [];
    for (const line of text.split("\n")) {
      const url = line.trim();
      if (!url.startsWith("http") || seen.has(url)) continue;
      seen.add(url);
      rows.push({
        id: threatId("openphish", "url", url),
        source_feed: "openphish",
        threat_type: "phishing",
        malicious_url: url,
        malicious_domain: extractDomain(url),
        ioc_value: url,
        severity: "high",
        confidence_score: 85,
      });
      if (rows.length >= 2000) break;
    }

    const { itemsNew, itemsDuplicate, itemsError } = await bulkInsertThreats(ctx.env.DB, rows);
    return { itemsFetched: rows.length, itemsNew, itemsDuplicate, itemsError };
  },
};
