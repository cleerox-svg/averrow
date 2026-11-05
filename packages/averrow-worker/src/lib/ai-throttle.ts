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
 */

import type { Env } from "../types";
import { BudgetManager } from "./budgetManager";

/** KV key holding the cached non-critical throttle decision. "" = not
 *  throttled; any other value = the throttle reason. */
export const AI_THROTTLE_KV_KEY = "ai:throttle_reason";
const AI_THROTTLE_KV_TTL_SECONDS = 60;

/** Throttle decision plus whether it came from a successful budget read. */
interface ThrottleDecision {
  reason: string | null;
  /** false = the budget read threw; `reason` is the fail-open null. */
  fresh: boolean;
}

function throttleReason(level: string, pctUsed: number, limitUsd: number): string {
  return `budget ${level} throttle (${pctUsed}% of $${limitUsd})`;
}

async function computeThrottle(env: Pick<Env, "DB">): Promise<ThrottleDecision> {
  try {
    const budget = new BudgetManager(env.DB);
    const status = await budget.getStatus();
    if (status.throttle_level === "emergency" || status.throttle_level === "hard") {
      return {
        reason: throttleReason(status.throttle_level, status.pct_used, status.config.monthly_limit_usd),
        fresh: true,
      };
    }
    return { reason: null, fresh: true };
  } catch (err) {
    console.warn(`[ai-throttle] budget read failed (failing open): ${err instanceof Error ? err.message : String(err)}`);
    return { reason: null, fresh: false };
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
export async function checkCostGuard(env: Pick<Env, "DB">, critical: boolean): Promise<string | null> {
  if (critical) return null;
  return (await computeThrottle(env)).reason;
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
  env: Pick<Env, "DB"> & { CACHE?: KVNamespace },
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

  if (env.CACHE && decision.fresh) {
    try {
      await env.CACHE.put(AI_THROTTLE_KV_KEY, decision.reason ?? "", { expirationTtl: AI_THROTTLE_KV_TTL_SECONDS });
    } catch { /* non-fatal */ }
  }

  return decision.reason;
}
