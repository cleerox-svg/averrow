import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";
import { store, type StoreDb } from "../lib/db-registry";
import { hasServiceAccount } from "../lib/google-service-account";
import { webRiskLookup, webRiskLookupsRemaining, type LookupRunStats } from "../lib/web-risk-lookup";

/**
 * URL reputation via the Google Cloud Web Risk Lookup API (uris.search).
 *
 * The feed keeps its historical name, `google_safe_browsing`, and the
 * threats columns it writes (gsb_checked / gsb_flagged / gsb_threat_type),
 * so alert triage (lib/alert-triage.ts), Flight Control's backlog.gsb and the
 * pipeline handlers keep working. It no longer calls the Safe Browsing v4 API
 * (non-commercial terms): every lookup goes through lib/web-risk-lookup.ts,
 * which holds the monthly free-tier cap, the volume estimate and the
 * NEVER-call-computeDiff/hashes.search rule.
 *
 * Two modes:
 * A) Bulk enrichment (runs on cron via ingest()): ≤ 100 recent unchecked
 *    threats per run, de-duplicated by URL, checked one URL per call.
 * B) Inline enrichment (exported checkGoogleSafeBrowsing): the contact-form
 *    link scan calls this for immediate URL validation.
 *
 * Credential: GOOGLE_SERVICE_ACCOUNT_JSON (shared with the Web Risk takedown
 * submitter). Results cached in KV with 24h TTL: gsb:<url>. A cache hit costs
 * no Web Risk quota. A URL Google did not answer for (no credential, cap
 * reached, counter unreadable, HTTP error, deadline) is checked=false: never
 * cached, and the feed never marks its threat gsb_checked — a later run
 * retries it.
 */

export interface GSBResult {
  flagged: boolean;
  threatType: string | null;
  /** false when no answer came from Google (no credential, monthly cap,
   *  API error). Results cached before this field existed are real answers,
   *  so absent ≠ false. */
  checked?: boolean;
}

/** Wall-clock budget for one feed run's lookups — inside the feed's 150 s
 *  per-pull timeout (FEED_RUN_TIMEOUT_OVERRIDES_MS), leaving room for the
 *  threats UPDATEs. URLs not reached stay unchecked for the next run. */
export const GSB_FEED_LOOKUP_BUDGET_MS = 100_000;

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Check URLs against Web Risk (uris.search). URLs are de-duplicated and
 * cache hits answered from KV before any call is made. Returns one result
 * per input URL, in order.
 */
export async function checkGoogleSafeBrowsing(
  urls: string[],
  env: Env,
  opts: { useCache?: boolean; deadline?: number } = {},
): Promise<GSBResult[]> {
  return (await checkUrlsWithStats(urls, env, opts)).results;
}

async function checkUrlsWithStats(
  urls: string[],
  env: Env,
  opts: { useCache?: boolean; deadline?: number },
): Promise<{ results: GSBResult[]; stats: LookupRunStats | null }> {
  const useCache = opts.useCache ?? true;
  const byUrl = new Map<string, GSBResult>();
  const unique = [...new Set(urls)];
  const toLookUp: string[] = [];

  for (const url of unique) {
    let cached: string | null = null;
    if (useCache) {
      try { cached = await env.CACHE.get(`gsb:${url}`); } catch { cached = null; }
    }
    if (cached !== null) {
      try { byUrl.set(url, JSON.parse(cached) as GSBResult); continue; } catch { /* re-check */ }
    }
    toLookUp.push(url);
  }

  let stats: LookupRunStats | null = null;
  if (toLookUp.length > 0) {
    const run = await webRiskLookup(env, toLookUp, { deadline: opts.deadline });
    stats = run.stats;
    for (let i = 0; i < toLookUp.length; i++) {
      const url = toLookUp[i]!;
      const v = run.verdicts[i]!;
      const result: GSBResult = { flagged: v.flagged, threatType: v.threatType, checked: v.checked };
      byUrl.set(url, result);
      if (v.checked) {
        try {
          await env.CACHE.put(`gsb:${url}`, JSON.stringify(result), { expirationTtl: 86400 });
        } catch { /* cache is best-effort */ }
      }
    }
  }

  return {
    results: urls.map((u) => byUrl.get(u) ?? { flagged: false, threatType: null, checked: false }),
    stats,
  };
}

/**
 * Cross-feed escalation: when 3+ enrichment sources agree, auto-escalate to critical.
 */
async function checkCrossFeedEscalation(db: StoreDb, threatId: string): Promise<void> {
  const row = await db.prepare(`
    SELECT
      (CASE WHEN surbl_listed = 1 THEN 1 ELSE 0 END) +
      (CASE WHEN vt_malicious >= 3 THEN 1 ELSE 0 END) +
      (CASE WHEN gsb_flagged = 1 THEN 1 ELSE 0 END) +
      (CASE WHEN dbl_listed = 1 THEN 1 ELSE 0 END) as signals
    FROM threats WHERE id = ?
  `).bind(threatId).first<{ signals: number }>();

  if (row && row.signals >= 3) {
    await db.prepare(`
      UPDATE threats SET severity = 'critical', confidence_score = 99
      WHERE id = ? AND (severity != 'critical' OR confidence_score < 99)
    `).bind(threatId).run();
    logger.info("enrichment_cross_feed_escalation", {
      threat_id: threatId,
      signals: row.signals,
      message: `Threat ${threatId} confirmed by ${row.signals} independent sources — critical`,
    });
  }
}

export const google_safe_browsing: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;
    const db = store(env, "core");

    if (!hasServiceAccount(env)) {
      logger.info("gsb_disabled", {
        message: "Web Risk lookups disabled — GOOGLE_SERVICE_ACCOUNT_JSON not configured",
      });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Skip the D1 work-queue read when this month's Web Risk quota is spent
    // (or the counter can't be read — fail closed). Rows stay gsb_checked = 0.
    const remaining = await webRiskLookupsRemaining(env);
    if (remaining === null || remaining === 0) {
      logger.warn("gsb_quota_stop", {
        reason: remaining === null ? "counter_unavailable" : "monthly_cap",
        message: "Web Risk lookups skipped this run — threats left unchecked for a later run",
      });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Query threats with unchecked Google SB status (last 7 days, limit 100)
    const unchecked = await db.prepare(`
      SELECT id, malicious_url, malicious_domain FROM threats
      WHERE gsb_checked = 0
        AND (malicious_url IS NOT NULL OR malicious_domain IS NOT NULL)
        AND first_seen >= datetime('now', '-7 days')
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
      LIMIT 100
    `).all<{ id: string; malicious_url: string | null; malicious_domain: string | null }>();

    const threats = unchecked.results;
    if (threats.length === 0) {
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Build URL list: prefer malicious_url, fallback to http://{domain}
    const urlMap = new Map<string, string[]>(); // url -> threat IDs
    for (const t of threats) {
      const url = t.malicious_url ?? `http://${t.malicious_domain}`;
      const ids = urlMap.get(url) ?? [];
      ids.push(t.id);
      urlMap.set(url, ids);
    }

    const urls = Array.from(urlMap.keys());
    const itemsFetched = threats.length;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    try {
      const { results, stats } = await checkUrlsWithStats(urls, env, {
        deadline: Date.now() + GSB_FEED_LOOKUP_BUDGET_MS,
      });
      if (stats) itemsError = stats.errors;

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]!;
        const result = results[i]!;
        const threatIds = urlMap.get(url) ?? [];

        // Not answered by Google (cap, counter, credential, HTTP error,
        // deadline): leave gsb_checked = 0 so a later run retries. Never
        // record "clean" for a URL nobody checked.
        if (result.checked === false) continue;

        if (result.flagged && result.threatType) {
          // Determine severity escalation
          let targetSeverity: string;
          if (result.threatType === "MALWARE") {
            targetSeverity = "critical";
          } else if (result.threatType === "SOCIAL_ENGINEERING") {
            targetSeverity = "high";
          } else {
            targetSeverity = "high";
          }
          const targetRank = SEVERITY_RANK[targetSeverity] ?? 3;

          for (const tid of threatIds) {
            await db.prepare(`
              UPDATE threats SET
                gsb_checked = 1,
                gsb_flagged = 1,
                gsb_threat_type = ?,
                confidence_score = MIN(100, COALESCE(confidence_score, 60) + 25),
                severity = CASE
                  WHEN ? > COALESCE(
                    CASE severity
                      WHEN 'info' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2
                      WHEN 'high' THEN 3 WHEN 'critical' THEN 4 ELSE 0
                    END, 0)
                  THEN ?
                  ELSE severity
                END
              WHERE id = ?
            `).bind(result.threatType, targetRank, targetSeverity, tid).run();

            await checkCrossFeedEscalation(db, tid);
          }

          logger.info("gsb_threat_confirmed", {
            url,
            threatType: result.threatType,
            threat_ids: threatIds,
            message: `Threat(s) confirmed as ${result.threatType} by Google Web Risk`,
          });
          itemsNew++;
        } else {
          // Mark as checked but clean
          for (const tid of threatIds) {
            await db.prepare(`
              UPDATE threats SET gsb_checked = 1
              WHERE id = ?
            `).bind(tid).run();
          }
          itemsDuplicate++;
        }
      }
    } catch (err) {
      logger.error("gsb_enrichment_error", {
        error: err instanceof Error ? err.message : String(err),
      });
      itemsError = threats.length;
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
