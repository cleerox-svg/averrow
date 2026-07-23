import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";

/**
 * Pulsedive — IOC risk scoring (enrichment).
 *
 * Pulsedive's free registered tier exposes a REST API key (its
 * STIX/TAXII 2.1 export is a paid Feed plan, so this is enrichment, not
 * a TAXII ingest). We score indicators we already hold — domain or IP —
 * with Pulsedive's `risk` level and use it to calibrate confidence /
 * severity, mirroring the greynoise/seclookup enrichment pattern.
 *
 * Endpoint: GET https://pulsedive.com/api/info.php?indicator=<v>&key=<k>
 *   → { risk: "unknown"|"none"|"low"|"medium"|"high"|"critical"|"retired", ... }
 *   → { error: "Indicator not found." } when unknown to Pulsedive.
 *
 * Free-tier limits (verified from the Pulsedive account page): 1 req/s,
 * 50 requests/day, 500 requests/month. The MONTHLY cap is the binding
 * constraint — 50/day for a month is ~1500, far over 500 — so we pace to
 * ~15/day (≈465/month) and enforce all three ceilings (per-second via the
 * inter-call delay, plus daily + monthly KV counters). Runs on its own
 * cron; self-gates to a no-op when PULSEDIVE_API_KEY is unset.
 */

const DAILY_LIMIT = 15;      // under the 50/day cap; 15 × 31 ≈ 465 < 500/month
const MONTHLY_LIMIT = 480;   // hard backstop under the 500/month cap
const BATCH_SIZE = 8;        // per dedicated-cron run; daily/monthly caps clamp it
const DELAY_MS = 1_500;      // ≥1s spacing → under the 1 req/s cap (with margin)
const BUDGET_MS = 240_000;   // per-run wall-clock guard (reap-safe)
const FETCH_TIMEOUT_MS = 10_000;

type PulsediveRisk = "unknown" | "none" | "low" | "medium" | "high" | "critical" | "retired";
const VALID_RISK = new Set<PulsediveRisk>(["unknown", "none", "low", "medium", "high", "critical", "retired"]);

/** Look up one indicator; null on error/rate-limit. Cached 48h in KV. */
export async function checkPulsedive(indicator: string, env: Env): Promise<PulsediveRisk | null> {
  if (!env.PULSEDIVE_API_KEY) return null;

  const cacheKey = `pulsedive:${indicator}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached !== null) return cached as PulsediveRisk;

  const url = `https://pulsedive.com/api/info.php?indicator=${encodeURIComponent(indicator)}&key=${encodeURIComponent(env.PULSEDIVE_API_KEY)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: "application/json" } });

  if (res.status === 429) {
    logger.error("pulsedive_rate_limit", { indicator, status: 429 });
    return null;
  }
  if (!res.ok) {
    logger.error("pulsedive_api_error", { indicator, status: res.status });
    return null;
  }

  const body = (await res.json()) as { risk?: string; error?: string };

  if (body.error) {
    // Only "Indicator not found." is a valid "no risk data" answer → cache
    // it as unknown. ANY OTHER error (invalid key, quota exhausted, etc.,
    // which Pulsedive can return as HTTP 200 + {error}) is a real failure:
    // return null so it is retryable, uncached, and does NOT stamp the
    // threat checked — otherwise a bad key silently marks a whole day's
    // batch checked=unknown with no operator signal.
    if (/not\s*found/i.test(body.error)) {
      await env.CACHE.put(cacheKey, "unknown", { expirationTtl: 172800 });
      return "unknown";
    }
    logger.error("pulsedive_error_body", { indicator, error: body.error });
    return null;
  }

  const risk: PulsediveRisk = VALID_RISK.has((body.risk ?? "") as PulsediveRisk)
    ? (body.risk as PulsediveRisk)
    : "unknown";

  await env.CACHE.put(cacheKey, risk, { expirationTtl: 172800 });
  return risk;
}

async function getDailyCount(env: Env): Promise<number> {
  const val = await env.CACHE.get(`pulsedive_daily_${new Date().toISOString().slice(0, 10)}`);
  return val ? parseInt(val, 10) : 0;
}
async function incrementDailyCount(env: Env, by: number): Promise<void> {
  const key = `pulsedive_daily_${new Date().toISOString().slice(0, 10)}`;
  await env.CACHE.put(key, String((await getDailyCount(env)) + by), { expirationTtl: 86400 });
}
async function getMonthlyCount(env: Env): Promise<number> {
  const val = await env.CACHE.get(`pulsedive_monthly_${new Date().toISOString().slice(0, 7)}`);
  return val ? parseInt(val, 10) : 0;
}
async function incrementMonthlyCount(env: Env, by: number): Promise<void> {
  const key = `pulsedive_monthly_${new Date().toISOString().slice(0, 7)}`;
  await env.CACHE.put(key, String((await getMonthlyCount(env)) + by), { expirationTtl: 2_764_800 }); // ~32 days
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const pulsedive: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;
    const empty: FeedResult = { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };

    if (!env.PULSEDIVE_API_KEY) {
      logger.info("pulsedive_skipped", { reason: "PULSEDIVE_API_KEY not set" });
      return empty;
    }

    const dailyCalls = await getDailyCount(env);
    const monthlyCalls = await getMonthlyCount(env);
    if (dailyCalls >= DAILY_LIMIT) {
      logger.info("pulsedive_daily_limit", { calls: dailyCalls, limit: DAILY_LIMIT });
      return empty;
    }
    if (monthlyCalls >= MONTHLY_LIMIT) {
      logger.info("pulsedive_monthly_limit", { calls: monthlyCalls, limit: MONTHLY_LIMIT });
      return empty;
    }
    // Clamp to whichever ceiling is closest — batch size, remaining day, or
    // remaining month.
    const batchLimit = Math.min(BATCH_SIZE, DAILY_LIMIT - dailyCalls, MONTHLY_LIMIT - monthlyCalls);

    // Highest-severity, recently-seen threats with a scoreable indicator
    // (domain preferred, else IP) not yet checked.
    const unchecked = await env.DB.prepare(`
      SELECT id, COALESCE(malicious_domain, ip_address) AS indicator
      FROM threats
      WHERE pulsedive_checked = 0
        AND (malicious_domain IS NOT NULL OR ip_address IS NOT NULL)
        AND severity IN ('critical', 'high')
        AND first_seen >= datetime('now', '-7 days')
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, created_at DESC
      LIMIT ?
    `).bind(batchLimit).all<{ id: string; indicator: string }>();

    const threats = unchecked.results;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    const loopStart = Date.now();
    for (const threat of threats) {
      if (Date.now() - loopStart > BUDGET_MS) {
        logger.info("pulsedive_budget_reached", { processed: itemsFetched, remaining: threats.length - itemsFetched });
        break;
      }
      if (!threat.indicator) continue;
      itemsFetched++;

      try {
        const risk = await checkPulsedive(threat.indicator, env);
        if (risk === null) { itemsError++; continue; }

        if (risk === "critical" || risk === "high") {
          // Corroborated as risky — nudge confidence up.
          await env.DB.prepare(`
            UPDATE threats SET
              pulsedive_checked = 1, pulsedive_risk = ?, pulsedive_checked_at = datetime('now'),
              confidence_score = MIN(100, COALESCE(confidence_score, 60) + 10)
            WHERE id = ?
          `).bind(risk, threat.id).run();
          itemsNew++;
        } else if (risk === "none") {
          // Pulsedive knows it and explicitly rates it not-risky — strong
          // FP signal. Downgrade to low + flag (matches greynoise's riot
          // path). NB: this feed only selects critical/high rows, so the
          // downgrade must be unconditional, not medium-gated.
          await env.DB.prepare(`
            UPDATE threats SET
              pulsedive_checked = 1, pulsedive_risk = 'none', pulsedive_checked_at = datetime('now'),
              severity = 'low',
              tags = CASE
                WHEN tags IS NULL OR tags = '' THEN 'likely_false_positive'
                WHEN tags NOT LIKE '%likely_false_positive%' THEN tags || ',likely_false_positive'
                ELSE tags END
            WHERE id = ?
          `).bind(threat.id).run();
          itemsNew++;
        } else if (risk === "low") {
          // Mild not-risky signal — drop one severity notch (critical→high,
          // high→medium) rather than a full downgrade.
          await env.DB.prepare(`
            UPDATE threats SET
              pulsedive_checked = 1, pulsedive_risk = 'low', pulsedive_checked_at = datetime('now'),
              severity = CASE severity WHEN 'critical' THEN 'high' WHEN 'high' THEN 'medium' ELSE severity END
            WHERE id = ?
          `).bind(threat.id).run();
          itemsNew++;
        } else {
          // unknown / retired / medium — record the check, no calibration.
          await env.DB.prepare(`
            UPDATE threats SET pulsedive_checked = 1, pulsedive_risk = ?, pulsedive_checked_at = datetime('now')
            WHERE id = ?
          `).bind(risk, threat.id).run();
          itemsDuplicate++; // checked, no actionable change
        }

        if (itemsFetched < threats.length) await sleep(DELAY_MS);
      } catch (err) {
        logger.error("pulsedive_check_error", { indicator: threat.indicator, error: err instanceof Error ? err.message : String(err) });
        itemsError++;
      }
    }

    // Every attempt consumed quota, so count them against both ceilings.
    if (itemsFetched > 0) {
      await incrementDailyCount(env, itemsFetched);
      await incrementMonthlyCount(env, itemsFetched);
    }

    // If EVERY lookup failed (invalid key / sustained upstream outage),
    // throw so runFeed marks the pull failed and the per-feed circuit
    // breaker backs off — instead of reporting success and re-hammering
    // the full budget every run with no signal.
    if (itemsFetched > 0 && itemsError === itemsFetched) {
      throw new Error(`pulsedive: all ${itemsFetched} lookups failed — check PULSEDIVE_API_KEY / upstream`);
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
