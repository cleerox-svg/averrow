/**
 * Budget API handlers — GET status, PATCH config, GET breakdown.
 */

import type { Env } from "../types";
import { json } from "../lib/cors";
import { BudgetManager, fetchAnthropicUsageReport } from "../lib/budgetManager";
import { dashboardSnapshotCacheKeys } from "./admin";

/** GET /api/admin/budget/status */
export async function handleBudgetStatus(_request: Request, env: Env): Promise<Response> {
  const mgr = new BudgetManager(env.DB);
  const anthropicKey = (env as unknown as Record<string, string | undefined>).ANTHROPIC_ADMIN_KEY;
  const anthropicReported = await fetchAnthropicUsageReport(anthropicKey, env);
  const status = await mgr.getStatus(anthropicReported);
  return json({ data: status });
}

/** GET /api/admin/budget/breakdown */
export async function handleBudgetBreakdown(_request: Request, env: Env): Promise<Response> {
  const mgr = new BudgetManager(env.DB);
  const byAgent = await mgr.getSpendByAgent();
  return json({ data: byAgent });
}

/** PATCH /api/admin/budget/config */
export async function handleBudgetConfigPatch(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null) as {
    monthly_limit_usd?: number;
    soft_pct?: number;
    hard_pct?: number;
    emergency_pct?: number;
  } | null;

  if (!body) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Validate numeric fields
  if (body.monthly_limit_usd !== undefined && (typeof body.monthly_limit_usd !== 'number' || body.monthly_limit_usd < 0)) {
    return json({ error: "monthly_limit_usd must be a non-negative number" }, 400);
  }
  if (body.soft_pct !== undefined && (typeof body.soft_pct !== 'number' || body.soft_pct < 0 || body.soft_pct > 100)) {
    return json({ error: "soft_pct must be between 0 and 100" }, 400);
  }
  if (body.hard_pct !== undefined && (typeof body.hard_pct !== 'number' || body.hard_pct < 0 || body.hard_pct > 100)) {
    return json({ error: "hard_pct must be between 0 and 100" }, 400);
  }
  if (body.emergency_pct !== undefined && (typeof body.emergency_pct !== 'number' || body.emergency_pct < 0 || body.emergency_pct > 100)) {
    return json({ error: "emergency_pct must be between 0 and 100" }, 400);
  }

  const mgr = new BudgetManager(env.DB);
  const updated = await mgr.updateConfig(body);

  // Bust BOTH role-scoped admin-dashboard snapshot entries. The composite
  // caches for ~75s (DASHBOARD_SNAPSHOT_TTL); without this, an operator's
  // budget-limit edit wouldn't surface in the dashboard's budget slice /
  // VerdictBand for up to 75s, and the client-side query invalidation
  // can't take effect while the server keeps serving the stale snapshot.
  await Promise.all(dashboardSnapshotCacheKeys().map((k) => env.CACHE.delete(k)));

  return json({ data: updated });
}
