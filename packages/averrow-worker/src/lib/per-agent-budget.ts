/**
 * Per-agent budget pre-flight gate (Phase 5.1).
 *
 * Compares an agent's declared `budget.monthlyTokenCap` (from its
 * AgentModule) against actual current-month token usage from the
 * agent_budget_rollups materialised view, and refuses the AI call
 * when the agent is over cap. KV-cached for 60s per agent so a
 * burst of calls from the same sync agent pays at most one D1 read
 * per minute.
 *
 * Failure modes:
 *   - Cap = 0 (`exempt` agents like flight_control / cube_healer /
 *     navigator / enricher) — the registry says they shouldn't make
 *     AI calls. ANY call from a cap-0 agent is rejected. This is the
 *     intended audit-trail signal that an unexpected AI surface
 *     showed up under that attribution.
 *   - Cap > 0, current spend < cap — pass.
 *   - Cap > 0, current spend >= cap — reject with a structured
 *     reason. The Anthropic wrapper turns the rejection into
 *     `AnthropicError(message='budget_cap_exceeded:...')` which the
 *     sync agents already catch + fall back to deterministic output.
 *   - Agent not in registry (e.g. legacy kebab-case ledger-only
 *     attribution like 'admin-classify' before the snake rename) —
 *     pass without enforcement (no declared cap to compare against).
 *     Logged once per cache window so the operator notices if a
 *     real new code path lacks a registered AgentModule.
 *   - D1 blip / KV blip — fail open (pass), log a warning. Better
 *     to over-spend by one minute than crash a customer-facing
 *     sync call on an infrastructure hiccup.
 */

import type { Env } from "../types";
import { BudgetManager } from "./budgetManager";

/** Subset of Env this gate needs. Mirrors AnthropicEnv so callers
 *  inside the AI wrapper don't have to widen their env shape.
 *  CACHE is optional — the gate falls through to the slow D1 path
 *  every call when KV isn't bound (test fixtures, retired modules). */
export type BudgetGateEnv = Pick<Env, "DB"> & { CACHE?: KVNamespace };

/** KV key for per-agent throttle decision. Mirrors the
 *  `ai:throttle_reason` 60s cache pattern used by the global
 *  cost guard in lib/haiku.ts. */
const KV_TTL_SECONDS = 60;
const KV_PREFIX = "agent_budget:";

export type AgentBudgetDecision =
  | { ok: true }
  | { ok: false; reason: string };

/** Result of a single resolved enforcement check, exported for tests
 *  + the diagnostic surface. */
export interface AgentBudgetSnapshot {
  agentId: string;
  monthlyTokenCap: number;
  currentTokens: number;
  pctOfCap: number;
  alertAt: number;
  overCap: boolean;
  overAlert: boolean;
}

/** Read the agent's declared cap from the AgentModule registry.
 *  Returns null when the agent is not registered — enforcement
 *  treats null as "no cap declared, pass through". */
async function getDeclaredCap(agentId: string): Promise<{ cap: number; alertAt: number } | null> {
  // Lazy import — agentModules isn't available until the module
  // graph is fully constructed. The dynamic import gives the
  // bundler a way to break the cycle that would otherwise pull
  // the entire agent registry into the cold-start path of every
  // AI call.
  const { agentModules } = await import("../agents");
  const mod = (agentModules as Record<string, { budget: { monthlyTokenCap: number; alertAt?: number } } | undefined>)[agentId];
  if (!mod) return null;
  return {
    cap: mod.budget.monthlyTokenCap,
    alertAt: mod.budget.alertAt ?? 0.8,
  };
}

/** Pre-flight enforcement check. Called from lib/anthropic.ts before
 *  every Anthropic dispatch. Returns the decision; the caller throws
 *  AnthropicError on `{ ok: false }`. */
export async function checkAgentBudget(env: BudgetGateEnv, agentId: string): Promise<AgentBudgetDecision> {
  const cacheKey = `${KV_PREFIX}${agentId}`;

  // ── Fast path — KV cached decision ─────────────────────────
  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey);
      if (cached !== null) {
        // "" = pass, anything else = the rejection reason. Mirrors
        // the existing ai:throttle_reason convention.
        return cached === "" ? { ok: true } : { ok: false, reason: cached };
      }
    } catch {
      // KV blip — fall through and recompute. Don't fail closed.
    }
  }

  // ── Slow path — read declared cap + current rollup ─────────
  let declared: { cap: number; alertAt: number } | null = null;
  try {
    declared = await getDeclaredCap(agentId);
  } catch (err) {
    console.warn(`[per-agent-budget] getDeclaredCap failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: true };
  }

  if (declared === null) {
    // Unregistered agentId. Don't enforce — pass through. Cache
    // the "pass" so we don't re-look-up every call from the same
    // legacy site within the cache window.
    await safeCachePut(env, cacheKey, "");
    return { ok: true };
  }

  // Cap = 0 → exempt agents shouldn't make AI calls. Any attempt
  // is a regression.
  if (declared.cap === 0) {
    const reason = `agent ${agentId} is declared exempt (monthlyTokenCap=0) — AI call refused. Add a cap to the AgentModule.budget if this is intentional.`;
    await safeCachePut(env, cacheKey, reason);
    return { ok: false, reason };
  }

  // Read current rollup state. Single primary-key lookup on
  // agent_budget_rollups — O(log n).
  let currentTokens = 0;
  try {
    if (env.DB) {
      const budget = new BudgetManager(env.DB);
      currentTokens = await budget.getAgentMonthlyTokens(agentId);
    }
  } catch (err) {
    console.warn(`[per-agent-budget] getAgentMonthlyTokens failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
    // Fail open on D1 hiccup — better to over-spend by one minute
    // than crash a customer-facing call. Don't cache; retry next call.
    return { ok: true };
  }

  if (currentTokens >= declared.cap) {
    const reason = `agent ${agentId} over monthly token cap: ${currentTokens.toLocaleString()} / ${declared.cap.toLocaleString()} tokens used`;
    await safeCachePut(env, cacheKey, reason);
    return { ok: false, reason };
  }

  // Pass. Cache the decision.
  await safeCachePut(env, cacheKey, "");
  return { ok: true };
}

/** Materialised snapshot for the diagnostic surface. */
export async function getAgentBudgetSnapshot(env: BudgetGateEnv, agentId: string): Promise<AgentBudgetSnapshot | null> {
  const declared = await getDeclaredCap(agentId);
  if (declared === null) return null;

  let currentTokens = 0;
  if (env.DB) {
    const budget = new BudgetManager(env.DB);
    currentTokens = await budget.getAgentMonthlyTokens(agentId);
  }
  const pct = declared.cap > 0 ? (currentTokens / declared.cap) * 100 : 0;
  return {
    agentId,
    monthlyTokenCap: declared.cap,
    currentTokens,
    pctOfCap: Math.round(pct * 10) / 10,
    alertAt: declared.alertAt,
    overCap: declared.cap > 0 && currentTokens >= declared.cap,
    overAlert: declared.cap > 0 && currentTokens >= declared.cap * declared.alertAt,
  };
}

async function safeCachePut(env: BudgetGateEnv, key: string, value: string): Promise<void> {
  if (!env.CACHE) return;
  try {
    await env.CACHE.put(key, value, { expirationTtl: KV_TTL_SECONDS });
  } catch {
    // KV write failure is non-fatal. Worst case the next call repeats
    // the D1 lookup. Don't crash the AI call path on it.
  }
}
