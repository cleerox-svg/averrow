import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";

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
 * wildcard_domains list (bare domains, one per line).
 *
 * Ingest uses chunked bulk INSERT OR IGNORE (bulkInsertThreats) rather
 * than the per-row isDuplicate/insert/markSeen loop, which was getting
 * the worker reaped on cold-cache pulls (5k domains × 3 round-trips).
 * Dedup is the deterministic, PER-FEED threatId PK: re-ingesting this
 * feed's own domain is a cheap INSERT OR IGNORE no-op. A domain that also
 * appears in another feed intentionally records a separate per-source row
 * (corroboration) — unlike the old shared-KV pre-check, which cross-
 * suppressed distinct feeds' rows for the same domain.
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

    // Parse → validate → dedupe within the payload, all in memory before
    // touching D1.
    const seen = new Set<string>();
    const rows: ThreatRow[] = [];
    for (const line of text.split("\n")) {
      const domain = line.trim().toLowerCase();
      if (!domain || domain.startsWith("#") || !DOMAIN_RE.test(domain)) continue;
      if (seen.has(domain)) continue;
      seen.add(domain);
      rows.push({
        id: threatId("scam_blocklist", "domain", domain),
        source_feed: "scam_blocklist",
        threat_type: "phishing",
        malicious_url: null,
        malicious_domain: domain,
        ioc_value: domain,
        severity: "medium",
        confidence_score: 70,
      });
      if (rows.length >= MAX_ITEMS) break;
    }

    const { itemsNew, itemsDuplicate, itemsError } = await bulkInsertThreats(ctx.env.DB, rows);
    return { itemsFetched: rows.length, itemsNew, itemsDuplicate, itemsError };
  },
};
