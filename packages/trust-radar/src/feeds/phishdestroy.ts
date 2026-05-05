import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { calculateConfidence, calculateSeverity, reclassifyThreatType } from "../lib/threatScoring";

/**
 * PhishDestroy (destroylist) — Curated phishing & scam domain blocklist.
 * Source: https://github.com/phishdestroy/destroylist
 * Format: JSON array of domain strings.
 * Free, no auth, updated hourly.
 *
 * Implementation note (2026-05-04 rewrite):
 *
 * The previous version called `isDuplicate` (KV GET) + `insertThreat`
 * (D1 INSERT) + `markSeen` (KV PUT) sequentially per domain. With a
 * 5,000-domain payload that's 15,000 sub-requests in series — well
 * past the Cloudflare Worker per-invocation ceiling. Result: every
 * pull was killed mid-loop with no row in feed_pull_history ever
 * advancing past status='partial'. Diagnostics counted 15 orphan
 * pull-history rows in 24h.
 *
 * Fix: build all INSERT OR IGNORE statements upfront and flush via
 * `db.batch()` — the platform standard per CLAUDE.md §8 ("Use
 * ON CONFLICT DO NOTHING — never SELECT then INSERT") and the same
 * pattern cartographer.ts uses for its enrichment writes. We drop
 * the KV dedup entirely; the threats table PK is deterministic
 * (`thr-phishdestroy-<hash>`) and the unique-constraint conflict path
 * gives us correct accounting via `meta.changes`.
 *
 * Per-pull cost: ceil(5000 / 50) = 100 batch round-trips, well under
 * any Worker subrequest ceiling.
 */

const BATCH_CHUNK = 50;
const MAX_DOMAINS_PER_RUN = 5_000;
// Bound the input array before validating. PhishDestroy's snapshot is
// ~144K domains and our shape-validation pass rate is ~2.4%, so the
// MAX_DOMAINS_PER_RUN break below was dead code in practice — every
// pull iterated the full payload (~14s of CPU) and frequently got
// reaped mid-run. Slicing to MAX_INPUT_DOMAINS upfront caps CPU at
// ~5s. PhishDestroy's destroylist is published newest-first, so the
// first 50K covers the recent threat surface; the long tail is older
// domains we've almost always already ingested.
const MAX_INPUT_DOMAINS = 50_000;

export const phishdestroy: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const res = await fetch(ctx.feedUrl);
    if (!res.ok) throw new Error(`PhishDestroy HTTP ${res.status}`);

    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) throw new Error("PhishDestroy: expected JSON array");
    const domains = raw.slice(0, MAX_INPUT_DOMAINS);

    // Trim, validate, dedupe within the payload before touching D1.
    // A single-pass walk through the input is O(n) and runs entirely
    // in memory — no I/O cost compared to the per-row pattern.
    const seenInPayload = new Set<string>();
    const valid: string[] = [];
    for (const d of domains) {
      if (typeof d !== "string") continue;
      const trimmed = d.trim().toLowerCase();
      // Cheap shape filter: must contain a dot, no whitespace, no protocol
      // prefix, no leading wildcard. The wildcard filter mirrors the SQL
      // gate in lib/dns-backfill (`malicious_domain NOT LIKE '*%'`) — the
      // resolver can't process them and downstream cartographer joins
      // would skip them anyway.
      if (trimmed.length < 4) continue;
      if (!trimmed.includes(".")) continue;
      if (/\s/.test(trimmed)) continue;
      if (trimmed.startsWith("*")) continue;
      if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) continue;
      if (seenInPayload.has(trimmed)) continue;
      seenInPayload.add(trimmed);
      valid.push(trimmed);
      if (valid.length >= MAX_DOMAINS_PER_RUN) break;
    }

    if (valid.length === 0) {
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Pre-resolve threat-scoring once per payload — every row is
    // type='phishing' from the same feed, so the inputs to
    // calculateConfidence / calculateSeverity / reclassifyThreatType
    // don't depend on the domain. No need to re-derive 5k times.
    const baseType = reclassifyThreatType("phishing", null, null) ?? "phishing";
    const baseConfidence = 80; // pre-#998 default for phishdestroy
    const baseSeverity = calculateSeverity(
      // calculateConfidence has feed-aware overrides; honor them so we
      // stay aligned with single-row insertThreat() callers elsewhere.
      calculateConfidence("phishdestroy", baseType, false),
    );
    const finalConfidence = baseConfidence;
    const finalSeverity = baseSeverity;
    const finalType = baseType;

    // Build statements once, flush in chunks. Each chunk is a single
    // D1 transaction; failures roll back that chunk only.
    const stmts = valid.map((domain) =>
      ctx.env.DB.prepare(
        `INSERT OR IGNORE INTO threats
           (id, source_feed, threat_type, malicious_url, malicious_domain,
            ioc_value, severity, confidence_score, status,
            first_seen, last_seen, created_at)
         VALUES (?, 'phishdestroy', ?, ?, ?, ?, ?, ?, 'active',
                 datetime('now'), datetime('now'), datetime('now'))`,
      ).bind(
        threatId("phishdestroy", "domain", domain),
        finalType,
        `https://${domain}`,
        domain,
        domain,
        finalSeverity,
        finalConfidence,
      ),
    );

    let itemsNew = 0;
    let itemsError = 0;
    for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
      const chunk = stmts.slice(i, i + BATCH_CHUNK);
      try {
        const results = await ctx.env.DB.batch(chunk);
        for (const r of results) {
          // INSERT OR IGNORE: changes=1 → new row, changes=0 → PK collision (duplicate).
          itemsNew += r.meta?.changes ?? 0;
        }
      } catch (err) {
        itemsError += chunk.length;
        console.error(`[phishdestroy] batch ${i}-${i + chunk.length} failed:`, err);
      }
    }

    const itemsDuplicate = valid.length - itemsNew - itemsError;
    return { itemsFetched: valid.length, itemsNew, itemsDuplicate, itemsError };
  },
};
