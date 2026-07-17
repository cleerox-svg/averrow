/**
 * Per-agent module metadata + current-month rollup
 * (AGENT_STANDARD §3, §10, §11 surfaces).
 *
 * GET /api/admin/agents/:id/module-metadata
 *
 * Returns everything the Phase 5.5 UI uplift needs to render the
 * "Declarations" panel on the agent detail screen:
 *
 *   - Supervision (stallThresholdMinutes, parallelMax, costGuard)
 *   - Budget declaration + current-month spend pulled from
 *     agent_budget_rollups (no budget_ledger SUM)
 *   - Resource declarations (reads / writes)
 *   - Output declarations (outputs[])
 *   - Status + category + pipelinePosition
 *   - Trigger
 *
 * Bypasses the Phase 4.3 manifest extraction — this endpoint just
 * dumps what the AgentModule itself declares. The drift gate
 * already enforces that declarations match the static SQL extract,
 * so the runtime declaration is the truth source for the UI.
 */

import { json } from "../lib/cors";
import type { Env } from "../types";

export async function handleAgentModuleMetadata(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!agentId) return json({ success: false, error: "missing agent_id" }, 400, origin);

  try {
    const { agentModules } = await import("../agents");
    const mod = (agentModules as Record<string, typeof import("../agents").agentModules[string] | undefined>)[agentId];
    if (!mod) return json({ success: false, error: `unknown agent_id: ${agentId}` }, 404, origin);

    // Pull the current-month rollup for spend-vs-cap. Phase 5.1's
    // agent_budget_rollups gives us a single-row PK lookup.
    const rollup = await env.DB.prepare(`
      SELECT total_input_tokens, total_output_tokens, total_cost_usd, call_count, updated_at
      FROM agent_budget_rollups
      WHERE agent_id = ? AND year_month = strftime('%Y-%m', 'now')
    `).bind(agentId).first<{
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost_usd: number;
      call_count: number;
      updated_at: string;
    }>();

    const monthTokens = (rollup?.total_input_tokens ?? 0) + (rollup?.total_output_tokens ?? 0);
    const cap = mod.budget.monthlyTokenCap;
    const alertAt = mod.budget.alertAt ?? 0.8;
    const pctOfCap = cap > 0 ? Math.round((monthTokens / cap) * 100) : null;

    return json({
      success: true,
      data: {
        agent_id: mod.name,
        display_name: mod.displayName,
        description: mod.description,
        category: mod.category,
        status: mod.status,
        pipeline_position: mod.pipelinePosition,
        trigger: mod.trigger,
        // ── Supervision (AGENT_STANDARD §3) ──
        supervision: {
          stall_threshold_minutes: mod.stallThresholdMinutes,
          parallel_max: mod.parallelMax,
          cost_guard: mod.costGuard,
          requires_approval: mod.requiresApproval ?? false,
        },
        // ── Budget vs current-month spend (§11) ──
        budget: {
          monthly_token_cap: cap,
          alert_at: alertAt,
          tokens_month: monthTokens,
          cost_usd_month: rollup?.total_cost_usd ?? 0,
          calls_month: rollup?.call_count ?? 0,
          pct_of_cap: pctOfCap,
          over_alert_threshold: pctOfCap !== null && cap > 0 && monthTokens >= cap * alertAt,
          over_cap: cap > 0 && monthTokens >= cap,
          rollup_updated_at: rollup?.updated_at ?? null,
        },
        // ── Resource declarations (§10) ──
        resources: {
          reads: mod.reads,
          writes: mod.writes,
        },
        // ── Output declarations (§9) ──
        outputs: mod.outputs,
      },
    }, 200, origin);
  } catch (err) {
    return json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      500,
      origin,
    );
  }
}
