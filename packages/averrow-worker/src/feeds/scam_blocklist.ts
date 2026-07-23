import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

const MAX_ITEMS = 5000;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Scam-Blocklist (jarelllama/Scam-Blocklist) — newly-created scam,
 * phishing and fraud domains detected via automated Google-Search
 * sweeps and validated for liveness.
 *
 * This adds a scam/fraud-domain angle distinct from the malware-URL
 * feeds: fake stores, crypto-drainer sites, brand-impersonation shops
 * — high-value for brand/typosquat correlation. We read the plain
 * wildcard_domains list (bare domains, one per line). Overlap with
 * phishing_database / openphish is absorbed by the threatId PK dedup.
 *
 * Format: bare domains, one per line, "#"-prefixed comments.
 * Schedule: daily (the upstream regenerates daily).
 */
export const scam_blocklist: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    if (!ctx.feedUrl) throw new Error("Scam-Blocklist: feed_configs.source_url is empty");
    const res = await fetch(ctx.feedUrl, {
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0" },
    });
    if (!res.ok) throw new Error(`Scam-Blocklist HTTP ${res.status}`);

    const text = await res.text();
    const domains = text
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#") && DOMAIN_RE.test(l))
      .slice(0, MAX_ITEMS);

    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    for (const domain of domains) {
      try {
        if (await isDuplicate(ctx.env, "domain", domain)) {
          itemsDuplicate++;
          continue;
        }

        await insertThreat(ctx.env.DB, {
          id: threatId("scam_blocklist", "domain", domain),
          source_feed: "scam_blocklist",
          threat_type: "phishing",
          malicious_url: null,
          malicious_domain: domain,
          ioc_value: domain,
          severity: "medium",
          confidence_score: 70,
        });
        await markSeen(ctx.env, "domain", domain);
        itemsNew++;
      } catch (err) {
        console.error(`[scam_blocklist] insert error for domain=${domain}: ${err instanceof Error ? err.message : err}`);
        itemsError++;
      }
    }

    return { itemsFetched: domains.length, itemsNew, itemsDuplicate, itemsError };
  },
};
