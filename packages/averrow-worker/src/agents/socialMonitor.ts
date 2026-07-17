/**
 * Social Monitor Agent — wraps the per-brand social impersonation scanner as
 * a first-class AgentModule so every run lands in agent_runs / agent_outputs
 * and surfaces in Flight Control + platform-diagnostics + the Agents UI.
 *
 * The scanner batch (`runSocialMonitorBatch`) already handles:
 *   - due-brand selection from brand_monitor_schedule (monitor_type='social')
 *   - per-platform handle + impersonation checks
 *   - per-brand alerts on HIGH / CRITICAL findings
 *   - Haiku AI assessment for ambiguous profiles
 *   - post-scan brand exposure score recompute
 *   - schedule advance (last_checked + next_check)
 *
 * This wrapper just converts the batch return into an AgentResult and emits
 * a single diagnostic agent_outputs row when the tick did work.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";

export const socialMonitorAgent: AgentModule = {
  name: "social_monitor",
  displayName: "Mockingbird",
  description: "Catches social impersonators by their mimicry — checks every monitored brand across Twitter / LinkedIn / Instagram / TikTok / GitHub / YouTube",
  color: "#3CB878",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 480,
  parallelMax: 1,
  costGuard: "enforced",
  // The scanner's own AI use is small — most spend lands on
  // social_ai_assessor (called as a sync sub-agent per profile).
  budget: { monthlyTokenCap: 5_000_000 },
  // Direct SQL surface is empty — delegates to scanners/social-monitor.
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 16,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    const { runSocialMonitorBatch } = await import("../scanners/social-monitor");

    const stats = await runSocialMonitorBatch(env);

    const outputs: AgentOutputEntry[] = [];
    if (stats.brands_processed > 0) {
      outputs.push({
        type: "diagnostic",
        summary: `Social scan: ${stats.brands_processed} brands, ${stats.total_results} profiles checked, ${stats.total_alerts} alerts`,
        severity: stats.total_alerts > 0 ? "medium" : "info",
        details: stats,
      });
    }

    return {
      itemsProcessed: stats.brands_processed,
      itemsCreated: stats.total_results,
      itemsUpdated: 0,
      output: stats,
      agentOutputs: outputs,
    };
  },
};
