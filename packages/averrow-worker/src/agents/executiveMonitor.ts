/**
 * Executive Monitor Agent — Stage 4 of the executive social-impersonation
 * feature. Wraps the executive-impersonation batch as a first-class
 * AgentModule so every run lands in agent_runs (start + completion) plus a
 * diagnostic agent_outputs row, and surfaces in Flight Control /
 * platform-diagnostics / the Agents UI.
 *
 * The batch (`runExecutiveMonitorBatch`) does all the work:
 *   - rotation-aware selection of active org_executives
 *   - per-exec pure detection (runExecutiveMonitorForExec)
 *   - non-official candidate → `executive_impersonation` alert via
 *     createAlert, with a dedup guard so re-runs don't spam
 *
 * This wrapper is intentionally THIN and SQL-free: the architect
 * manifest's per-file extractor only walks src/agents/*.ts, so keeping
 * the DB/KV/alert surface entirely inside scanners/executive-monitor-batch
 * keeps this agent's declared reads/writes empty — the same delegation
 * pattern ct_monitor / social_monitor use.
 *
 * Deterministic — NO AI (budget cap 0 surfaces any unexpected AI spend as
 * a regression, matching ct_monitor / trademark_monitor).
 *
 * Dispatched on its own dedicated 6-hourly cron (minute 26 — see
 * cron/orchestrator.ts) — one agent_runs row per tick, own Worker budget.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";

export const executiveMonitorAgent: AgentModule = {
  name: "executive_monitor",
  displayName: "Doppelganger",
  description:
    "Detects fake social profiles impersonating a customer org's registered executives — permutes each exec's name, HEAD-checks the watched platforms, and raises executive_impersonation alerts on non-official matches",
  color: "#C83C3C",
  trigger: "scheduled",
  requiresApproval: false,
  // 6-hourly cadence → 720min threshold (≈ interval × 2) so a single
  // missed tick doesn't trip the FC stall watchdog.
  stallThresholdMinutes: 720,
  parallelMax: 1,
  // No AI calls — HEAD probes + D1 only. Cap=0 flags any unexpected AI
  // spend as a regression (same convention as ct_monitor).
  costGuard: "enforced",
  budget: { monthlyTokenCap: 0 },
  // Direct SQL surface is empty — delegates to
  // scanners/executive-monitor-batch (invisible to the manifest extractor).
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  // Unique tail slot — 42 is ct_monitor, 40 is campaign_hunter.
  pipelinePosition: 43,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    const { runExecutiveMonitorBatch } = await import("../scanners/executive-monitor-batch");

    const stats = await runExecutiveMonitorBatch(env);

    const outputs: AgentOutputEntry[] = [];
    if (stats.candidates_found > 0 || stats.alerts_created > 0) {
      outputs.push({
        type: "diagnostic",
        summary:
          `Executive monitor: ${stats.executives_processed} exec(s), ` +
          `${stats.candidates_found} candidate(s), ${stats.alerts_created} alert(s)`,
        severity: stats.alerts_created > 0 ? "medium" : "info",
        details: stats as unknown as Record<string, unknown>,
      });
    }

    return {
      itemsProcessed: stats.executives_processed,
      itemsCreated: stats.alerts_created,
      itemsUpdated: 0,
      output: stats as unknown as Record<string, unknown>,
      agentOutputs: outputs,
    };
  },
};
