import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";

/**
 * AbuseIPDB — IP abuse reputation enrichment.
 *
 * Checks IP addresses against the AbuseIPDB community database for abuse reports.
 * Free tier: 1,000 checks/day. Strategy: 20 IPs per 30-min run = 960/day max.
 *
 * Severity escalation:
 *   abuseConfidenceScore >= 80 → escalate to 'critical', confidence +20
 *   abuseConfidenceScore >= 50 → escalate to 'high' if currently lower
 *   abuseConfidenceScore >= 25 → no escalation, just record score
 *
 * Daily call tracking via KV key: abuseipdb_daily_{YYYY-MM-DD}
 * Results cached in KV with 24h TTL: abuseipdb:{ip}
 */

export interface AbuseIPDBResult {
  abuseConfidenceScore: number;
  totalReports: number;
  countryCode: string | null;
  isp: string | null;
  domain: string | null;
  usageType: string | null;
}

const DAILY_LIMIT = 950;
const BATCH_SIZE = 20;
// Concurrent fan-out cap. AbuseIPDB free tier docs cap on daily quota
// (1,000/day) but don't publish a per-second rate limit; community
// reports tolerate ~5-10 req/sec without 429s. Five is conservative.
const CONCURRENCY = 5;
// Safety delay between concurrent waves. Adds up to ~1.5s total
// across 4 waves of 5 IPs (vs the prior 285s of sequential 15-s
// sleeps that pushed pulls past Navigator's 15-min reap threshold).
const WAVE_DELAY_MS = 500;
// Per-fetch wall-clock cap so a hung upstream can't pin the whole
// wave. Well below the Navigator reap threshold.
const FETCH_TIMEOUT_MS = 8_000;

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Check a single IP against AbuseIPDB.
 * Results are cached in KV with 24h TTL.
 */
export async function checkAbuseIPDB(ip: string, env: Env): Promise<AbuseIPDBResult | null> {
  if (!env.ABUSEIPDB_API_KEY) return null;

  // Check KV cache first
  const cacheKey = `abuseipdb:${ip}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as AbuseIPDBResult;
  }

  const res = await fetch(
    `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
    {
      headers: {
        Key: env.ABUSEIPDB_API_KEY,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );

  if (!res.ok) {
    logger.error("abuseipdb_api_error", { ip, status: res.status });
    return null;
  }

  const body = await res.json() as {
    data: {
      abuseConfidenceScore: number;
      totalReports: number;
      countryCode: string | null;
      isp: string | null;
      domain: string | null;
      usageType: string | null;
    };
  };

  const result: AbuseIPDBResult = {
    abuseConfidenceScore: body.data.abuseConfidenceScore,
    totalReports: body.data.totalReports,
    countryCode: body.data.countryCode,
    isp: body.data.isp,
    domain: body.data.domain,
    usageType: body.data.usageType,
  };

  // Cache for 24h
  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });

  return result;
}

/**
 * Get today's call count from KV and check if under limit.
 */
async function getDailyCount(env: Env): Promise<number> {
  const dateKey = `abuseipdb_daily_${new Date().toISOString().slice(0, 10)}`;
  const val = await env.CACHE.get(dateKey);
  return val ? parseInt(val, 10) : 0;
}

async function incrementDailyCount(env: Env, by: number): Promise<void> {
  const dateKey = `abuseipdb_daily_${new Date().toISOString().slice(0, 10)}`;
  const current = await getDailyCount(env);
  // TTL of 86400 so it auto-expires next day
  await env.CACHE.put(dateKey, String(current + by), { expirationTtl: 86400 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const abuseipdb: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;

    // Graceful skip if no API key
    if (!env.ABUSEIPDB_API_KEY) {
      logger.info("abuseipdb_skipped", { reason: "ABUSEIPDB_API_KEY not set" });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Check daily budget
    const dailyCalls = await getDailyCount(env);
    if (dailyCalls >= DAILY_LIMIT) {
      logger.info("abuseipdb_daily_limit", { calls: dailyCalls, limit: DAILY_LIMIT });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    const remaining = DAILY_LIMIT - dailyCalls;
    const batchLimit = Math.min(BATCH_SIZE, remaining);

    // Query threats with IP addresses that haven't been checked
    const unchecked = await env.DB.prepare(`
      SELECT DISTINCT id, ip_address FROM threats
      WHERE abuseipdb_checked = 0
        AND ip_address IS NOT NULL
        AND first_seen >= datetime('now', '-7 days')
      ORDER BY severity DESC
      LIMIT ?
    `).bind(batchLimit).all<{ id: string; ip_address: string }>();

    const threats = unchecked.results;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    // Process IPs in concurrent waves. The prior implementation looped
    // sequentially with a 15-s sleep between every call (≈285 s for a
    // full BATCH_SIZE=20 batch), which exceeded Navigator's 15-min
    // partial-pull reap threshold often enough to fail 75% of pulls in
    // the last 6 h. Concurrency=5 + a 500-ms wave delay keeps the full
    // batch under ~10 s end-to-end while staying well under any
    // realistic AbuseIPDB rate limit.
    for (let i = 0; i < threats.length; i += CONCURRENCY) {
      const wave = threats.slice(i, i + CONCURRENCY);

      await Promise.all(
        wave.map(async (threat) => {
          itemsFetched++;
          try {
            const result = await checkAbuseIPDB(threat.ip_address, env);

            if (!result) {
              itemsError++;
              return;
            }

            // Determine severity escalation
            let newSeverity: string | null = null;
            let confidenceBoost = 0;

            if (result.abuseConfidenceScore >= 80) {
              newSeverity = "critical";
              confidenceBoost = 20;
            } else if (result.abuseConfidenceScore >= 50) {
              newSeverity = "high";
              confidenceBoost = 10;
            }
            // score >= 25: no escalation, just record

            if (newSeverity) {
              await env.DB.prepare(`
                UPDATE threats SET
                  abuseipdb_checked = 1,
                  abuseipdb_score = ?,
                  abuseipdb_reports = ?,
                  abuseipdb_isp = ?,
                  confidence_score = MIN(100, COALESCE(confidence_score, 60) + ?),
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
              `).bind(
                result.abuseConfidenceScore,
                result.totalReports,
                result.isp,
                confidenceBoost,
                SEVERITY_RANK[newSeverity] ?? 2,
                newSeverity,
                threat.id,
              ).run();
            } else {
              await env.DB.prepare(`
                UPDATE threats SET
                  abuseipdb_checked = 1,
                  abuseipdb_score = ?,
                  abuseipdb_reports = ?,
                  abuseipdb_isp = ?
                WHERE id = ?
              `).bind(
                result.abuseConfidenceScore,
                result.totalReports,
                result.isp,
                threat.id,
              ).run();
            }

            itemsNew++;
          } catch (err) {
            logger.error("abuseipdb_check_error", {
              ip: threat.ip_address,
              error: err instanceof Error ? err.message : String(err),
            });
            itemsError++;
          }
        }),
      );

      // Wave courtesy delay — skip after the final wave.
      if (i + CONCURRENCY < threats.length) {
        await sleep(WAVE_DELAY_MS);
      }
    }

    // Track daily usage
    if (itemsFetched > 0) {
      await incrementDailyCount(env, itemsFetched);
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
