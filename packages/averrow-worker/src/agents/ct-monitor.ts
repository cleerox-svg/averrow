/**
 * Certificate Transparency monitor agent.
 *
 * Wraps the existing pollCertificates(env) sweep in scanners/ct-monitor.ts
 * in the standard agent runner so every run lands in agent_runs (start +
 * completion) plus an agent_outputs diagnostic. Before this wrap,
 * CT monitoring ran as a bare inline call at the tail of the hourly
 * orchestrator tick with NO agent_runs telemetry — so Flight Control's
 * stall watchdog (which iterates Object.keys(agentModules)) structurally
 * could not see it fail, and it never surfaced in agent_mesh /
 * platform-diagnostics (R2, Assessment 2026-07 §3.4).
 *
 * Dispatched hourly on its own dedicated cron (`18 * * * *`, see
 * cron/orchestrator.ts) — decoupled from the analyst inline-await that
 * was starving it to ~9/24 runs (R1). ONE agent_runs row per tick.
 *
 * The heavy SQL (brands ⋈ org_brands scan list, alert writes) lives in
 * the scanner, so reads/writes declare only the off-platform crt.sh
 * dependency — same delegation pattern as trademark_monitor /
 * lookalike_scanner (the manifest extractor only walks the agent file).
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { pollCertificates } from "../scanners/ct-monitor";

export const ctMonitorAgent: AgentModule = {
  name: "ct_monitor",
  displayName: "Watchtower",
  description: "Polls Certificate Transparency logs (crt.sh) for newly issued certs impersonating tenant-monitored brands and raises alerts on suspicious issuances",
  color: "#0A8AB5",
  trigger: "scheduled",
  requiresApproval: false,
  // Hourly cadence → 120min threshold (≈ interval × 2) so a single
  // missed tick doesn't trip the FC stall watchdog.
  stallThresholdMinutes: 120,
  parallelMax: 1,
  // No AI calls — crt.sh HTTP + D1 only. Cap=0 surfaces any unexpected
  // AI spend as a regression (same convention as trademark_monitor).
  costGuard: "enforced",
  budget: { monthlyTokenCap: 0 },
  reads: [{ kind: "external", name: "crt.sh", url: "https://crt.sh" }],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  // Unique tail slot — 40 collides with campaign_hunter (audit §22 rule 4).
  pipelinePosition: 42,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const stats = await pollCertificates(ctx.env);

    const agentOutputs: AgentOutputEntry[] = [];
    if (stats.suspicious > 0) {
      agentOutputs.push({
        type: "diagnostic",
        summary: `CT monitor: ${stats.suspicious} suspicious certificate(s) across ${stats.brandsScanned} monitored brand(s)`,
        severity: "medium",
        details: { ...stats } as Record<string, unknown>,
      });
    }

    return {
      itemsProcessed: stats.totalCerts,
      itemsCreated: stats.newCerts,
      itemsUpdated: 0,
      output: { ...stats } as Record<string, unknown>,
      agentOutputs,
    };
  },
};
