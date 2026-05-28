/**
 * Dark-Web Monitor Agent — wraps the per-brand dark-web scanner as a
 * first-class AgentModule so every run lands in agent_runs / agent_outputs
 * and surfaces in Flight Control + platform-diagnostics + the Agents UI.
 *
 * The scanner batch (`runDarkWebMonitorBatch`) already handles:
 *   - brand-monitor-schedule seeding
 *   - due-brand selection
 *   - per-brand alerts on HIGH / CRITICAL findings
 *   - Haiku AI review promotion of ambiguous rows
 *   - post-scan brand exposure score recompute
 *
 * This wrapper just converts the batch return into an AgentResult and
 * emits a single insight-level agent_outputs row when the tick did work.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";

export const darkWebMonitorAgent: AgentModule = {
  name: "dark_web_monitor",
  displayName: "Sounder",
  description: "Dark-web echolocation — pings paste archives + leak forums for brand mentions (Pastebin today; Telegram / HIBP / Flare later)",
  color: "#C83C3C",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 480,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 2_000_000 },
  // Direct SQL surface is empty — delegates to lib helpers.
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 18,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    const { runDarkWebMonitorBatch } = await import("../scanners/dark-web-monitor");

    const stats = await runDarkWebMonitorBatch(env);

    const outputs: AgentOutputEntry[] = [];
    const didWork =
      stats.brands_processed > 0 ||
      stats.ransomware_inserted > 0 ||
      stats.ransomware_alerts > 0;
    if (didWork) {
      const ransomNote = stats.ransomware_inserted > 0 || stats.ransomware_alerts > 0
        ? ` | ransomware DLS: ${stats.ransomware_inserted} new (${stats.ransomware_alerts} alerts)`
        : "";
      outputs.push({
        type: "diagnostic",
        summary: `Dark-web scan: ${stats.brands_processed} brands, ${stats.rows_upserted} mentions upserted, ${stats.alerts_created} alerts, ${stats.ai_processed} AI-reviewed (${stats.ai_upgraded} promoted)${ransomNote}`,
        severity:
          stats.alerts_created > 0 || stats.ransomware_alerts > 0 ? "medium" : "info",
        details: stats,
      });
    }

    return {
      itemsProcessed: stats.brands_processed,
      itemsCreated: stats.rows_upserted + stats.ransomware_inserted,
      itemsUpdated: 0,
      output: stats,
      agentOutputs: outputs,
    };
  },
};
