/**
 * Social Discovery Agent — wraps the per-brand social handle discovery
 * scanner as a first-class AgentModule so every run lands in agent_runs /
 * agent_outputs and surfaces in Flight Control + platform-diagnostics + the
 * Agents UI.
 *
 * The scanner batch (`runSocialDiscoveryBatch`) handles:
 *   - selection of brands with no official_handles, ordered by threat_count
 *   - per-platform handle discovery via search APIs / heuristics
 *   - upsert into social_profiles + brand_monitor_schedule seeding
 *
 * Runs immediately before social_monitor in the same 6h tick so newly found
 * handles get monitored on the same cycle.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";

const DISCOVERY_BATCH_LIMIT = 10;

export const socialDiscoveryAgent: AgentModule = {
  name: "social_discovery",
  displayName: "Outrider",
  description: "Scout that rides ahead — discovers official social handles for brands with none on file so Mockingbird has terrain to monitor",
  color: "#3CB878",
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
  pipelinePosition: 15,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    const { runSocialDiscoveryBatch } = await import("../scanners/social-monitor");

    const stats = await runSocialDiscoveryBatch(env, DISCOVERY_BATCH_LIMIT);

    const outputs: AgentOutputEntry[] = [];
    if (stats.brands_processed > 0) {
      outputs.push({
        type: "diagnostic",
        summary: `Social discovery: ${stats.brands_processed} brands, ${stats.profiles_found} handles found, ${stats.schedules_created} new monitor schedules`,
        severity: "info",
        details: stats,
      });
    }

    return {
      itemsProcessed: stats.brands_processed,
      itemsCreated: stats.schedules_created,
      itemsUpdated: stats.profiles_found,
      output: stats,
      agentOutputs: outputs,
    };
  },
};
