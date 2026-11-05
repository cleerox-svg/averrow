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

/**
 * Returns a string reason if AI calls should be paused due to budget
 * throttle, or null to proceed. `critical = true` callers are never
 * paused (kept for the existing handler-boundary call sites).
 *
 * Uncached — one budget_config read + one agent_budget_rollups scan per
 * call. Hot paths use `getAiThrottleReason` instead.
 */
export async function checkCostGuard(env: Pick<Env, "DB">, critical: boolean): Promise<string | null> {
  try {
    const budget = new BudgetManager(env.DB);
    const status = await budget.getStatus();
    if (status.throttle_level === "emergency") {
      return critical ? null : `budget emergency throttle (${status.pct_used}% of $${status.config.monthly_limit_usd})`;
    }
    if (status.throttle_level === "hard") {
      return critical ? null : `budget hard throttle (${status.pct_used}% of $${status.config.monthly_limit_usd})`;
    }
    return null;
  } catch (err) {
    console.warn(`[ai-throttle] checkCostGuard: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * The non-critical throttle decision, KV-cached for 60s so a burst of
 * calls pays at most one budget read per minute (and a cache hit costs no
 * D1 read at all). Fails open: a KV or D1 hiccup means "not throttled",
 * matching the per-agent gate — better to over-spend by a minute than to
 * break a customer-facing call on an infrastructure blip.
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

  const blocked = await checkCostGuard(env, false);

  if (env.CACHE) {
    try {
      await env.CACHE.put(AI_THROTTLE_KV_KEY, blocked ?? "", { expirationTtl: AI_THROTTLE_KV_TTL_SECONDS });
    } catch { /* non-fatal */ }
  }

  return blocked;
}
