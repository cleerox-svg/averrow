/**
 * Platform-wide AI spend throttle — the `budget_config` monthly ceiling.
 *
 * Lives in its own module (not lib/haiku.ts) so lib/anthropic.ts can
 * enforce it inside `callAnthropic` without an import cycle
 * (haiku.ts → anthropic.ts → ai-throttle.ts → budgetManager.ts). Before
 * this move the gate only ran inside the haiku.ts helpers, and the ~20
 * direct `callAnthropic*` callers (narrator, evidence assembler, abuse
 * mailbox classifier + deep analyzer, Campaign Hunter, …) bypassed it
 * (docs/AI_STRATEGY_2026-10.md §3).
 *
 * Ladder (BudgetManager.getStatus): soft (80%) is advisory; hard (95%)
 * and emergency (99%) pause every non-critical call. Measured against
 * our own `budget_ledger` (via agent_budget_rollups), not the provider
 * balance.
 *
 * Telemetry cut-over (Track B1d): the budget is read through
 * BudgetManager.forEnv — budget_config from the routed budget store, the
 * month's spend summed across telemetry ∪ core — so the throttle sees the
 * whole month before, during and after a budget flip.
 */

import { BudgetManager, type BudgetEnv } from "./budgetManager";

/** KV key holding the cached non-critical throttle decision. "" = not
 *  throttled; any other value = the throttle reason. */
export const AI_THROTTLE_KV_KEY = "ai:throttle_reason";
const AI_THROTTLE_KV_TTL_SECONDS = 60;

/**
 * The last decision computed from a successful budget read, kept 6h. When
 * the budget read fails (core and/or TELEMETRY_DB down during the budget
 * cut-over — BudgetManager already retries on the routed DB alone), it is
 * returned instead of failing open; only with no last good decision does
 * the throttle fail open.
 */
export const AI_THROTTLE_LAST_GOOD_KV_KEY = "ai:throttle_last_good";
export const AI_THROTTLE_LAST_GOOD_TTL_SECONDS = 6 * 3600;

async function readLastGood(env: BudgetEnv): Promise<string | null | undefined> {
  if (!env.CACHE) return undefined;
  try {
    const v = await env.CACHE.get(AI_THROTTLE_LAST_GOOD_KV_KEY);
    return v === null ? undefined : v === "" ? null : v;
  } catch {
    return undefined;
  }
}

/** Throttle decision plus whether it came from a successful budget read. */
interface ThrottleDecision {
  reason: string | null;
  /** false = the budget read threw; `reason` is the fail-open null. */
  fresh: boolean;
  /**
   * true = the spend was read from the routed DB alone (the union failed):
   * a LOWER bound. Its throttle is trusted, its "allow" is not.
   */
  partial: boolean;
}

/**
 * The decision to return, from a computed decision + the last good one:
 *   full read     → the computed decision (the caller caches it);
 *   partial read  → its throttle if it throttles; else the last good
 *                   decision if THAT throttles (a lower-bound spend must not
 *                   lift a real throttle); else allow;
 *   failed read   → the last good decision, else fail open.
 * Only a full read may be cached (60 s key or last-good).
 */
async function resolveDecision(env: BudgetEnv, d: ThrottleDecision): Promise<string | null> {
  if (d.fresh && !d.partial) return d.reason;
  if (d.fresh && d.reason) return d.reason;
  const lastGood = await readLastGood(env);
  if (d.fresh) return lastGood ?? null; // partial + allow: only a last-good THROTTLE wins
  return lastGood === undefined ? d.reason : lastGood;
}

function throttleReason(level: string, pctUsed: number, limitUsd: number): string {
  return `budget ${level} throttle (${pctUsed}% of $${limitUsd})`;
}

async function computeThrottle(env: BudgetEnv): Promise<ThrottleDecision> {
  try {
    const budget = await BudgetManager.forEnv(env);
    const status = await budget.getStatus();
    const partial = status.partial_spend === true;
    if (status.throttle_level === "emergency" || status.throttle_level === "hard") {
      return {
        reason: throttleReason(status.throttle_level, status.pct_used, status.config.monthly_limit_usd),
        fresh: true,
        partial,
      };
    }
    return { reason: null, fresh: true, partial };
  } catch (err) {
    console.warn(`[ai-throttle] budget read failed (last good decision, else fail open): ${err instanceof Error ? err.message : String(err)}`);
    return { reason: null, fresh: false, partial: false };
  }
}

/**
 * Returns a string reason if non-critical AI calls should be paused due to
 * the budget throttle, or null to proceed. Uncached — one budget_config
 * read + one agent_budget_rollups scan per call; hot paths use
 * `getAiThrottleReason` instead.
 *
 * `critical = true` always returns null. It only affects this advisory
 * check: callAnthropic enforces the non-critical throttle on EVERY call and
 * has no critical override, so a "critical" caller is still refused at the
 * hard/emergency level once it reaches the model call.
 */
export async function checkCostGuard(env: BudgetEnv, critical: boolean): Promise<string | null> {
  if (critical) return null;
  return resolveDecision(env, await computeThrottle(env));
}

/**
 * The non-critical throttle decision, KV-cached for 60s so a burst of
 * calls pays at most one budget read per minute (and a cache hit costs no
 * D1 read at all). Fails open: a KV or D1 hiccup means "not throttled",
 * matching the per-agent gate — better to over-spend by a minute than to
 * break a customer-facing call on an infrastructure blip. A fail-open
 * result is NOT cached, so the next call re-reads the budget instead of
 * pinning "not throttled" for a minute after a D1 error.
 *
 * `CACHE` is optional so test fixtures without KV still work (they take
 * the D1 path every call).
 */
export async function getAiThrottleReason(
  env: BudgetEnv,
): Promise<string | null> {
  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get(AI_THROTTLE_KV_KEY);
      if (cached !== null) {
        return cached === "" ? null : cached;
      }
    } catch { /* fall through to recompute */ }
  }

  const decision = await computeThrottle(env);

  // Only a FULL read is cached: a partial (routed-DB-only, lower-bound) or
  // failed read never writes the 60 s key or last-good.
  if (env.CACHE && decision.fresh && !decision.partial) {
    try {
      await env.CACHE.put(AI_THROTTLE_KV_KEY, decision.reason ?? "", { expirationTtl: AI_THROTTLE_KV_TTL_SECONDS });
      await env.CACHE.put(AI_THROTTLE_LAST_GOOD_KV_KEY, decision.reason ?? "", { expirationTtl: AI_THROTTLE_LAST_GOOD_TTL_SECONDS });
    } catch { /* non-fatal */ }
  }

  return resolveDecision(env, decision);
}
