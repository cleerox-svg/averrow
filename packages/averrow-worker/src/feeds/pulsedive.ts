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

/**
 * Failure taxonomy for a single lookup — the whole point of the refactor.
 * The old code collapsed every failure into `null`, so a rejected key and a
 * transient upstream blip produced the identical non-actionable
 * "all lookups failed — check KEY / upstream" alert. Now the caller can tell
 * "rotate the secret" from "wait out the outage".
 *
 *   auth       — key rejected / expired / over-plan (HTTP 401/403, or a
 *                key/quota `{error}` body Pulsedive returns as HTTP 200).
 *                Definitive: it will reject every remaining indicator too.
 *   ratelimit  — HTTP 429; back off, don't rotate.
 *   upstream   — other non-2xx, or an unparseable 200 body.
 *   network    — fetch threw (DNS/TLS/timeout/abort).
 */
type LookupFailKind = "auth" | "ratelimit" | "upstream" | "network";
type LookupResult =
  | { ok: true; risk: PulsediveRisk }
  | { ok: false; kind: LookupFailKind; detail: string };

/** True if a Pulsedive HTTP-200 `{error}` body signals a key/quota problem. */
function isAuthLikeError(msg: string): boolean {
  return /key|api|auth|unauthor|invalid|forbidden|quota|credit|limit|upgrade|plan/i.test(msg);
}

/**
 * Look up one indicator, returning a classified result. Cached 48h in KV.
 * Never throws — network/timeout is caught and returned as `kind:'network'`
 * so the caller's accounting stays accurate.
 */
async function lookupPulsedive(indicator: string, env: Env): Promise<LookupResult> {
  if (!env.PULSEDIVE_API_KEY) return { ok: false, kind: "auth", detail: "PULSEDIVE_API_KEY not set" };

  const cacheKey = `pulsedive:${indicator}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached !== null && VALID_RISK.has(cached as PulsediveRisk)) {
    return { ok: true, risk: cached as PulsediveRisk };
  }

  const url = `https://pulsedive.com/api/info.php?indicator=${encodeURIComponent(indicator)}&key=${encodeURIComponent(env.PULSEDIVE_API_KEY)}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: "application/json" } });
  } catch (err) {
    return { ok: false, kind: "network", detail: err instanceof Error ? err.message : String(err) };
  }

  // Auth rejection — distinct, actionable on-call signal (rotate the key).
  if (res.status === 401 || res.status === 403) {
    logger.error("pulsedive_auth_rejected", { indicator, status: res.status });
    return { ok: false, kind: "auth", detail: `HTTP ${res.status}` };
  }
  if (res.status === 429) {
    logger.error("pulsedive_rate_limit", { indicator, status: 429 });
    return { ok: false, kind: "ratelimit", detail: "HTTP 429" };
  }
  if (!res.ok) {
    logger.error("pulsedive_api_error", { indicator, status: res.status });
    return { ok: false, kind: "upstream", detail: `HTTP ${res.status}` };
  }

  let body: { risk?: string; error?: string };
  try {
    body = (await res.json()) as { risk?: string; error?: string };
  } catch (err) {
    return { ok: false, kind: "upstream", detail: `unparseable body: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (body.error) {
    // Only "Indicator not found." is a valid "no risk data" answer → cache
    // it as unknown. Pulsedive returns key/quota problems as HTTP 200 +
    // {error}; classify those as `auth` so a bad key surfaces the rotate
    // signal instead of masquerading as a generic upstream error. Any other
    // {error} is a real, retryable upstream failure (uncached, does NOT
    // stamp the threat checked).
    if (/not\s*found/i.test(body.error)) {
      await env.CACHE.put(cacheKey, "unknown", { expirationTtl: 172800 });
      return { ok: true, risk: "unknown" };
    }
    const kind: LookupFailKind = isAuthLikeError(body.error) ? "auth" : "upstream";
    logger.error("pulsedive_error_body", { indicator, error: body.error, classifiedAs: kind });
    return { ok: false, kind, detail: body.error };
  }

  const risk: PulsediveRisk = VALID_RISK.has((body.risk ?? "") as PulsediveRisk)
    ? (body.risk as PulsediveRisk)
    : "unknown";

  await env.CACHE.put(cacheKey, risk, { expirationTtl: 172800 });
  return { ok: true, risk };
}

/**
 * Back-compat wrapper preserving the original exported contract: the risk
 * level, or null on any failure/rate-limit. Cached 48h in KV.
 */
export async function checkPulsedive(indicator: string, env: Env): Promise<PulsediveRisk | null> {
  const r = await lookupPulsedive(indicator, env);
  return r.ok ? r.risk : null;
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
    const failKinds: Record<LookupFailKind, number> = { auth: 0, ratelimit: 0, upstream: 0, network: 0 };

    for (const threat of threats) {
      if (Date.now() - loopStart > BUDGET_MS) {
        logger.info("pulsedive_budget_reached", { processed: itemsFetched, remaining: threats.length - itemsFetched });
        break;
      }
      if (!threat.indicator) continue;
      itemsFetched++;

      try {
        const result = await lookupPulsedive(threat.indicator, env);
        if (!result.ok) {
          itemsError++;
          failKinds[result.kind]++;
          // A rejected key rejects every remaining indicator too — stop
          // burning the daily/monthly quota + wall-clock budget on a
          // known-bad key and let the run end with an actionable error.
          if (result.kind === "auth") {
            logger.error("pulsedive_auth_abort", { detail: result.detail, attempted: itemsFetched });
            break;
          }
          if (itemsFetched < threats.length) await sleep(DELAY_MS);
          continue;
        }
        const risk = result.risk;

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
        // A throw here is a D1 UPDATE failure (lookupPulsedive itself never
        // throws) — count it, but as `upstream`, never `auth`, so a DB blip
        // can't trigger a spurious "rotate the key" alert.
        logger.error("pulsedive_check_error", { indicator: threat.indicator, error: err instanceof Error ? err.message : String(err) });
        itemsError++;
        failKinds.upstream++;
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
    // the full budget every run with no signal. The message names the
    // DOMINANT failure class so on-call knows whether to rotate the secret
    // or wait out an upstream outage.
    if (itemsFetched > 0 && itemsError === itemsFetched) {
      const dominant = (Object.entries(failKinds) as [LookupFailKind, number][])
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])[0];
      const dominantKind: LookupFailKind = dominant ? dominant[0] : "upstream";
      const detailMsg =
        dominantKind === "auth"
          ? "auth rejected (HTTP 401/403 or invalid-key body) — rotate PULSEDIVE_API_KEY"
          : dominantKind === "ratelimit"
            ? "rate-limited (HTTP 429) — over the free-tier quota, back off"
            : dominantKind === "network"
              ? "network/timeout reaching pulsedive.com — likely a transient upstream outage"
              : "upstream errors from pulsedive.com — check API status";
      throw new Error(
        `pulsedive: all ${itemsFetched} lookups failed — ${detailMsg} ` +
          `(auth=${failKinds.auth} ratelimit=${failKinds.ratelimit} upstream=${failKinds.upstream} network=${failKinds.network})`,
      );
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
