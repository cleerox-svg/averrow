import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

// Cap per pull. The NEW-today list is normally a few thousand fresh
// domains; the bound protects the worker budget if the upstream has a
// blow-out day.
const MAX_ITEMS = 3000;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Phishing.Database (Phishing-Database/Phishing.Database) — PyFunceble-
 * validated phishing domains.
 *
 * We pull the NEW-today list (the freshly-added, still-active domains)
 * rather than the multi-million-row ACTIVE dump, which is too large to
 * fetch every tick. This complements openphish/phishdestroy (which are
 * URL feeds) with clean DOMAIN-level phishing signal and de-risks the
 * dead phishtank feed. Overlap is absorbed by the threatId PK dedup.
 *
 * Format: bare domains, one per line, "#"-prefixed comments.
 * Schedule: daily (the upstream regenerates the NEW-today list daily).
 */
export const phishing_database: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    if (!ctx.feedUrl) throw new Error("Phishing.Database: feed_configs.source_url is empty");
    const res = await fetch(ctx.feedUrl, {
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0" },
    });
    if (!res.ok) throw new Error(`Phishing.Database HTTP ${res.status}`);

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
          id: threatId("phishing_database", "domain", domain),
          source_feed: "phishing_database",
          threat_type: "phishing",
          malicious_url: null,
          malicious_domain: domain,
          ioc_value: domain,
          severity: "high",
          confidence_score: 80,
        });
        await markSeen(ctx.env, "domain", domain);
        itemsNew++;
      } catch (err) {
        console.error(`[phishing_database] insert error for domain=${domain}: ${err instanceof Error ? err.message : err}`);
        itemsError++;
      }
    }

    return { itemsFetched: domains.length, itemsNew, itemsDuplicate, itemsError };
  },
};
