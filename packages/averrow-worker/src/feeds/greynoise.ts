import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";

/**
 * GreyNoise — IP context enrichment.
 *
 * Answers: "Is this IP mass-scanning the internet, or targeting me specifically?"
 * Community API (free): 50 requests/day.
 * Strategy: 8 IPs per 4-hour run = 48/day (safe under 50 daily limit).
 *
 * Daily call tracking via KV key: greynoise_daily_{YYYY-MM-DD}
 * Results cached in KV with 48h TTL: greynoise:{ip}
 */

export interface GreyNoiseResult {
  noise: boolean;
  riot: boolean;
  classification: "benign" | "malicious" | "unknown";
  name: string | null;
  link: string | null;
}

const DAILY_LIMIT = 45; // Community tier = 50, cap at 45 for safety
const BATCH_SIZE = 8;   // 8 per run × 6 runs/day = 48 (under limit)
const DELAY_MS = 30_000; // 30s between calls (respects community rate limit)
// Hard wall-clock cap for the per-run loop. With a dedicated cron this
// feed gets its own fresh budget, but this guard guarantees a single run
// can never approach Navigator's 15-min orphan-reap threshold even if an
// upstream stalls — it just leaves the remaining IPs for the next run.
const BUDGET_MS = 240_000;
const FETCH_TIMEOUT_MS = 10_000; // was 30s — don't let one hung lookup pin the run

/**
 * Check a single IP against GreyNoise Community API.
 * Results are cached in KV with 48h TTL.
 */
export async function checkGreyNoise(ip: string, env: Env): Promise<GreyNoiseResult | null> {
  if (!env.GREYNOISE_API_KEY) return null;

  // Check KV cache first
  const cacheKey = `greynoise:${ip}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as GreyNoiseResult;
  }

  const res = await fetch(`https://api.greynoise.io/v3/community/${encodeURIComponent(ip)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: {
      key: env.GREYNOISE_API_KEY,
      Accept: "application/json",
    },
  });

  if (res.status === 429) {
    logger.error("greynoise_rate_limit", { ip, status: 429 });
    return null;
  }
  if (res.status === 404) {
    // IP not found — not a known scanner
    const result: GreyNoiseResult = {
      noise: false,
      riot: false,
      classification: "unknown",
      name: null,
      link: null,
    };
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 172800 });
    return result;
  }
  if (!res.ok) {
    logger.error("greynoise_api_error", { ip, status: res.status });
    return null;
  }

  const body = await res.json() as {
    ip: string;
    noise: boolean;
    riot: boolean;
    classification: "benign" | "malicious" | "unknown";
    name: string | null;
    link: string | null;
  };

  const result: GreyNoiseResult = {
    noise: body.noise,
    riot: body.riot,
    classification: body.classification,
    name: body.name ?? null,
    link: body.link ?? null,
  };

  // Cache for 48h
  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 172800 });

  return result;
}

/** Get today's call count from KV */
async function getDailyCount(env: Env): Promise<number> {
  const dateKey = `greynoise_daily_${new Date().toISOString().slice(0, 10)}`;
  const val = await env.CACHE.get(dateKey);
  return val ? parseInt(val, 10) : 0;
}

async function incrementDailyCount(env: Env, by: number): Promise<void> {
  const dateKey = `greynoise_daily_${new Date().toISOString().slice(0, 10)}`;
  const current = await getDailyCount(env);
  await env.CACHE.put(dateKey, String(current + by), { expirationTtl: 86400 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const greynoise: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;

    // Graceful skip if no API key
    if (!env.GREYNOISE_API_KEY) {
      logger.info("greynoise_skipped", { reason: "GREYNOISE_API_KEY not set" });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Check daily budget
    const dailyCalls = await getDailyCount(env);
    if (dailyCalls >= DAILY_LIMIT) {
      logger.info("greynoise_daily_limit", { calls: dailyCalls, limit: DAILY_LIMIT });
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    const remaining = DAILY_LIMIT - dailyCalls;
    const batchLimit = Math.min(BATCH_SIZE, remaining);

    // Query high-severity threats with IPs not yet checked
    const unchecked = await env.DB.prepare(`
      SELECT DISTINCT id, ip_address FROM threats
      WHERE greynoise_checked = 0
        AND ip_address IS NOT NULL
        AND severity IN ('critical', 'high')
        AND first_seen >= datetime('now', '-7 days')
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT ?
    `).bind(batchLimit).all<{ id: string; ip_address: string }>();

    const threats = unchecked.results;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    const loopStart = Date.now();
    for (const threat of threats) {
      // Wall-clock guard: stop cleanly before the run could be reaped,
      // leaving remaining IPs for the next dedicated-cron tick.
      if (Date.now() - loopStart > BUDGET_MS) {
        logger.info("greynoise_budget_reached", { processed: itemsFetched, remaining: threats.length - itemsFetched });
        break;
      }
      itemsFetched++;
      try {
        const result = await checkGreyNoise(threat.ip_address, env);

        if (!result) {
          itemsError++;
          continue;
        }

        // Interpret GreyNoise signals
        if (result.riot) {
          // Known good service (CDN, DNS resolver, cloud provider) — likely false positive
          await env.DB.prepare(`
            UPDATE threats SET
              greynoise_checked = 1,
              greynoise_noise = ?,
              greynoise_riot = 1,
              greynoise_classification = ?,
              severity = 'low',
              tags = CASE
                WHEN tags IS NULL OR tags = '' THEN 'likely_false_positive'
                WHEN tags NOT LIKE '%likely_false_positive%' THEN tags || ',likely_false_positive'
                ELSE tags
              END
            WHERE id = ?
          `).bind(
            result.noise ? 1 : 0,
            result.classification,
            threat.id,
          ).run();

          logger.info("greynoise_riot_detected", {
            ip: threat.ip_address,
            name: result.name,
            message: `IP ${threat.ip_address} belongs to known service (${result.name}) — likely false positive`,
          });
          itemsNew++;
        } else if (result.noise && result.classification === "benign") {
          // Known benign scanner (Shodan, Censys, etc.) — downgrade severity
          await env.DB.prepare(`
            UPDATE threats SET
              greynoise_checked = 1,
              greynoise_noise = 1,
              greynoise_riot = 0,
              greynoise_classification = 'benign',
              severity = CASE
                WHEN severity = 'medium' THEN 'low'
                ELSE severity
              END
            WHERE id = ?
          `).bind(threat.id).run();

          logger.info("greynoise_benign_scanner", {
            ip: threat.ip_address,
            name: result.name,
            message: `IP ${threat.ip_address} is benign internet scanner (${result.name}) — downgraded`,
          });
          itemsNew++;
        } else if (result.noise && result.classification === "malicious") {
          // Known malicious mass-scanner — confirm severity
          await env.DB.prepare(`
            UPDATE threats SET
              greynoise_checked = 1,
              greynoise_noise = 1,
              greynoise_riot = 0,
              greynoise_classification = 'malicious',
              confidence_score = MIN(100, COALESCE(confidence_score, 60) + 10)
            WHERE id = ?
          `).bind(threat.id).run();

          logger.info("greynoise_malicious_confirmed", {
            ip: threat.ip_address,
            message: `IP ${threat.ip_address} confirmed malicious scanner by GreyNoise`,
          });
          itemsNew++;
        } else {
          // Not in GreyNoise scanner database — potential targeted attack
          await env.DB.prepare(`
            UPDATE threats SET
              greynoise_checked = 1,
              greynoise_noise = 0,
              greynoise_riot = 0,
              greynoise_classification = ?
            WHERE id = ?
          `).bind(result.classification, threat.id).run();

          logger.info("greynoise_not_scanner", {
            ip: threat.ip_address,
            message: `IP ${threat.ip_address} is NOT a known scanner — potential targeted attack`,
          });
          itemsDuplicate++; // counted as "checked but no actionable finding"
        }

        // Delay between API calls
        if (itemsFetched < threats.length) {
          await sleep(DELAY_MS);
        }
      } catch (err) {
        logger.error("greynoise_check_error", {
          ip: threat.ip_address,
          error: err instanceof Error ? err.message : String(err),
        });
        itemsError++;
      }
    }

    // Track daily usage
    if (itemsFetched > 0) {
      await incrementDailyCount(env, itemsFetched);
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
