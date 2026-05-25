/**
 * Trademark Monitor agent — Phase 1 (zero-cost internal correlation).
 *
 * Seeds each monitored brand's marks (wordmark + logo phash from the
 * brands table) and unifies existing social / app-store / domain misuse
 * signals into trademark_findings. No external API, no AI spend.
 *
 * Delegates to scanners/trademark-monitor.ts. Dispatched from the hourly
 * orchestrator tick via runJob (cheap, internal-only). Phase 2 (logo image
 * matching via a paid vision/reverse-image API) is documented for later.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { runTrademarkScanBatch } from "../scanners/trademark-monitor";

export const trademarkMonitorAgent: AgentModule = {
  name: "trademark_monitor",
  displayName: "Herald",
  description: "Unifies brand wordmark misuse across social, app-store, and domain signals into the trademark surface (Phase 1, no external cost)",
  color: "#E5A832",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 120,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 0 },
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 39,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const stats = await runTrademarkScanBatch(ctx.env);

    const agentOutputs: AgentOutputEntry[] = [];
    if (stats.assets_seeded > 0 || stats.findings_created > 0) {
      agentOutputs.push({
        type: "diagnostic",
        summary: `Trademark scan: ${stats.assets_seeded} assets seeded, ${stats.findings_created} findings correlated`,
        severity: "info",
        details: stats,
      });
    }

    return {
      itemsProcessed: stats.findings_created,
      itemsCreated: stats.findings_created,
      itemsUpdated: 0,
      output: stats,
      agentOutputs,
    };
  },
};
