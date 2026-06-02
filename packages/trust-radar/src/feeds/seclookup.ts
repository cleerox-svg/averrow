import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";

/**
 * SecLookup — Domain + IP threat intelligence enrichment.
 *
 * Generous free tier: 1 million lookups/month (~33K/day).
 * Used as bulk enrichment engine to supplement VirusTotal (limited to 480/day).
 *
 * Strategy: 100 lookups per 30-min run (well within 33K/day limit).
 * Monthly call tracking via KV key: seclookup_monthly_{year}_{month}
 * Results NOT cached in KV (generous limit, fresh data preferred).
 */

export interface SecLookupResult {
  risk_score: number;
  threat_type: string | null;
  categories: string[];
  first_seen: string | null;
  last_seen: string | null;
  registrar: string | null;
}

const MONTHLY_LIMIT = 950_000; // 1M free tier, cap at 950K
const BATCH_SIZE = 100;
const DELAY_MS = 1_000; // 1s between calls (be respectful)
// Hard wall-clock cap for the per-run loop. 100 sequential lookups ×
// (1s delay + fetch + cross-feed SQL) could exceed Navigator's 15-min
// orphan-reap threshold on a slow upstream; this guarantees the run ends
// well before that, leaving the rest of the batch for the next cron tick.
const BUDGET_MS = 120_000;
const FETCH_TIMEOUT_MS = 10_000; // was 30s — cap a single hung lookup

/**
 * Check a single indicator (domain or IP) against SecLookup.
 */
export async function checkSecLookup(
  indicator: string,
  type: "domain" | "ip",
  env: Env,
): Promise<SecLookupResult | null> {
  if (!env.SECLOOKUP_API_KEY) return null;

  const endpoint = type === "domain"
    ? `https://api.seclookup.com/v1/domain/${encodeURIComponent(indicator)}`
    : `https://api.seclookup.com/v1/ip/${encodeURIComponent(indicator)}`;

  const res = await fetch(endpoint, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: {
      Authorization: `Bearer ${env.SECLOOKUP_API_KEY}`,
      Accept: "application/json",
    },
  });

  if (res.status === 429) {
    logger.error("seclookup_rate_limit", { indicator, type, status: 429 });
    return null;
  }
  if (res.status === 404) {
    return { risk_score: 0, threat_type: null, categories: [], first_seen: null, last_seen: null, registrar: null };
  }
  if (!res.ok) {
    logger.error("seclookup_api_error", { indicator, type, status: res.status });
    return null;
  }

  const body = await res.json() as {
    risk_score?: number;
    threat_type?: string;
    categories?: string[];
    first_seen?: string;
    last_seen?: string;
    registrar?: string;
  };

  return {
    risk_score: body.risk_score ?? 0,
    threat_type: body.threat_type ?? null,
    categories: body.categories ?? [],
    first_seen: body.first_seen ?? null,
    last_seen: body.last_seen ?? null,
    registrar: body.registrar ?? null,
  };
}

/** Get monthly call count from KV */
async function getMonthlyCount(env: Env): Promise<number> {
  const now = new Date();
  const key = `seclookup_monthly_${now.getUTCFullYear()}_${now.getUTCMonth() + 1}`;
  const val = await env.CACHE.get(key);
  return val ? parseInt(val, 10) : 0;
}

async function incrementMonthlyCount(env: Env, by: number): Promise<void> {
  const now = new Date();
  const key = `seclookup_monthly_${now.getUTCFullYear()}_${now.getUTCMonth() + 1}`;
  const current = await getMonthlyCount(env);
  // TTL of ~31 days so it auto-expires
  await env.CACHE.put(key, String(current + by), { expirationTtl: 2_678_400 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cross-feed escalation: when 3+ enrichment sources agree, auto-escalate to critical.
 * Includes SecLookup (risk_score >= 80) alongside SURBL, VT, GSB, DBL.
 */
async function checkCrossFeedEscalation(db: D1Database, threatId: string): Promise<void> {
  const row = await db.prepare(`
    SELECT
      (CASE WHEN surbl_listed = 1 THEN 1 ELSE 0 END) +
      (CASE WHEN vt_malicious >= 3 THEN 1 ELSE 0 END) +
      (CASE WHEN gsb_flagged = 1 THEN 1 ELSE 0 END) +
      (CASE WHEN dbl_listed = 1 THEN 1 ELSE 0 END) +
      (CASE WHEN seclookup_risk_score >= 80 THEN 1 ELSE 0 END) as signals
    FROM threats WHERE id = ?
  `).bind(threatId).first<{ signals: number }>();

  if (row && row.signals >= 3) {
    await db.prepare(`
      UPDATE threats SET severity = 'critical', confidence_score = 99
      WHERE id = ? AND (severity != 'critical' OR confidence_score < 99)
    `).bind(threatId).run();
    logger.info("seclookup_cross_feed_escalation", {
      threatId,
      signals: row.signals,
      message: `Cross-feed escalation: ${row.signals} sources agree — auto-critical`,
    });
  }
}

export const seclookup: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;

    // Graceful skip if no API key
    if (!env.SECLOOKUP_API_KEY) {
      logger.info("seclookup_skipped", { reason: "SECLOOKUP_API_KEY not set" });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Check monthly budget
    const monthlyCalls = await getMonthlyCount(env);
    if (monthlyCalls >= MONTHLY_LIMIT) {
      logger.info("seclookup_monthly_limit", { calls: monthlyCalls, limit: MONTHLY_LIMIT });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    const remaining = MONTHLY_LIMIT - monthlyCalls;
    const batchLimit = Math.min(BATCH_SIZE, remaining);

    // Query unchecked threats (prioritize by severity)
    const unchecked = await env.DB.prepare(`
      SELECT DISTINCT id, malicious_domain, ip_address FROM threats
      WHERE seclookup_checked = 0
        AND (malicious_domain IS NOT NULL OR ip_address IS NOT NULL)
        AND first_seen >= datetime('now', '-7 days')
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at DESC
      LIMIT ?
    `).bind(batchLimit).all<{ id: string; malicious_domain: string | null; ip_address: string | null }>();

    const threats = unchecked.results;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    const loopStart = Date.now();
    for (const threat of threats) {
      // Wall-clock guard: stop cleanly before the run could be reaped,
      // leaving remaining indicators for the next dedicated-cron tick.
      if (Date.now() - loopStart > BUDGET_MS) {
        logger.info("seclookup_budget_reached", { processed: itemsFetched, remaining: threats.length - itemsFetched });
        break;
      }
      itemsFetched++;
      try {
        // Check domain first if available, IP as fallback
        const indicator = threat.malicious_domain ?? threat.ip_address!;
        const type = threat.malicious_domain ? "domain" as const : "ip" as const;

        const result = await checkSecLookup(indicator, type, env);

        if (!result) {
          itemsError++;
          continue;
        }

        // Risk scoring and severity adjustments
        let confidenceBoost = 0;
        let addTag: string | null = null;

        if (result.risk_score >= 80) {
          confidenceBoost = 15;
        } else if (result.risk_score < 20 && result.risk_score >= 0) {
          addTag = "seclookup_low_risk";
        }

        // Update threat with SecLookup data
        if (addTag) {
          await env.DB.prepare(`
            UPDATE threats SET
              seclookup_checked = 1,
              seclookup_risk_score = ?,
              seclookup_threat_type = ?,
              tags = CASE
                WHEN tags IS NULL OR tags = '' THEN ?
                WHEN tags NOT LIKE ? THEN tags || ',' || ?
                ELSE tags
              END
            WHERE id = ?
          `).bind(
            result.risk_score,
            result.threat_type,
            addTag,
            `%${addTag}%`,
            addTag,
            threat.id,
          ).run();
        } else if (confidenceBoost > 0) {
          await env.DB.prepare(`
            UPDATE threats SET
              seclookup_checked = 1,
              seclookup_risk_score = ?,
              seclookup_threat_type = ?,
              confidence_score = MIN(100, COALESCE(confidence_score, 60) + ?)
            WHERE id = ?
          `).bind(
            result.risk_score,
            result.threat_type,
            confidenceBoost,
            threat.id,
          ).run();
        } else {
          await env.DB.prepare(`
            UPDATE threats SET
              seclookup_checked = 1,
              seclookup_risk_score = ?,
              seclookup_threat_type = ?
            WHERE id = ?
          `).bind(
            result.risk_score,
            result.threat_type,
            threat.id,
          ).run();
        }

        // Cross-feed escalation check
        await checkCrossFeedEscalation(env.DB, threat.id);

        if (result.risk_score >= 50) {
          itemsNew++;
        } else {
          itemsDuplicate++;
        }

        // Delay between API calls
        if (itemsFetched < threats.length) {
          await sleep(DELAY_MS);
        }
      } catch (err) {
        logger.error("seclookup_check_error", {
          id: threat.id,
          error: err instanceof Error ? err.message : String(err),
        });
        itemsError++;
      }
    }

    // Track monthly usage
    if (itemsFetched > 0) {
      await incrementMonthlyCount(env, itemsFetched);
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
