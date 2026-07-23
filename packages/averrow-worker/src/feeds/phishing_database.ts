import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";

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
 * dead phishtank feed.
 *
 * Ingest uses chunked bulk INSERT OR IGNORE (bulkInsertThreats), not the
 * per-row isDuplicate/insert/markSeen loop — no cold-cache reap risk.
 * Dedup is the deterministic, PER-FEED threatId PK: re-ingesting this
 * feed's own domain is a cheap no-op; a domain shared with another feed
 * records a separate per-source corroborating row (the old shared-KV
 * pre-check cross-suppressed those).
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

    const seen = new Set<string>();
    const rows: ThreatRow[] = [];
    for (const line of text.split("\n")) {
      const domain = line.trim().toLowerCase();
      if (!domain || domain.startsWith("#") || !DOMAIN_RE.test(domain)) continue;
      if (seen.has(domain)) continue;
      seen.add(domain);
      rows.push({
        id: threatId("phishing_database", "domain", domain),
        source_feed: "phishing_database",
        threat_type: "phishing",
        malicious_url: null,
        malicious_domain: domain,
        ioc_value: domain,
        severity: "high",
        confidence_score: 80,
      });
      if (rows.length >= MAX_ITEMS) break;
    }

    const { itemsNew, itemsDuplicate, itemsError } = await bulkInsertThreats(ctx.env.DB, rows);
    return { itemsFetched: rows.length, itemsNew, itemsDuplicate, itemsError };
  },
};
