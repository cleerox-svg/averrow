/**
 * Lookalike Scanner — scheduled agent (not synchronous) that checks
 * newly-registered lookalike-domain candidates from the typosquat
 * generator, runs DNS/HTTP/MX checks + a Haiku AI assessment, and
 * stores the results.
 *
 * Phase 3.8 of agent audit. The audit (§5) initially categorised
 * this as a sync candidate; on closer read it's cron-driven (via
 * runLookalikeDomainCheck in orchestrator.ts → handleScheduled
 * hourly tick), not handler-driven. Belongs to the scheduled class.
 *
 * Wraps the existing checkLookalikeBatch(env) function in scanners/
 * lookalike-domains.ts. Per-row AI calls remain inside that
 * function and stay attributed to 'lookalike_scanner' in
 * budget_ledger. ONE agent_runs row per hourly tick covers all
 * rows scanned that tick.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { checkLookalikeBatch, seedLookalikesForOrgBrands } from "../scanners/lookalike-domains";

export const lookalikeScannerAgent: AgentModule = {
  name: "lookalike_scanner",
  displayName: "Lookalike Scanner",
  description: "Cron-driven scanner that classifies newly-registered typosquat candidates via DNS/HTTP/MX + Haiku AI assessment",
  color: "#F59E0B",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 120,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 20_000_000 },
  // Delegates to scanners/lookalike-domains.ts checkLookalikeBatch.
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 29,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const agentOutputs: AgentOutputEntry[] = [];
    let scanError: string | null = null;

    // Seed candidates for tenant-monitored brands that have none yet, so the
    // checker below has a non-empty pool. Best-effort — a seeding failure must
    // not block the check pass.
    try {
      const seed = await seedLookalikesForOrgBrands(ctx.env);
      if (seed.brands_seeded > 0) {
        agentOutputs.push({
          type: "diagnostic",
          summary: `Seeded lookalike candidates for ${seed.brands_seeded} brand(s): ${seed.candidates_created} new permutations`,
          severity: "info",
          details: seed,
        });
      }
    } catch (err) {
      agentOutputs.push({
        type: "diagnostic",
        summary: `lookalike seed step failed: ${err instanceof Error ? err.message : String(err)}`,
        severity: "low",
        details: { error: err instanceof Error ? err.message : String(err) },
      });
    }

    try {
      await checkLookalikeBatch(ctx.env);
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
      agentOutputs.push({
        type: "diagnostic",
        summary: `lookalike_scanner batch failed: ${scanError}`,
        severity: "high",
        details: { error: scanError },
      });
      // Don't throw — let the standard runner mark the run 'success'
      // with a diagnostic. The scanner's failure modes are mostly
      // per-row (DNS timeouts, AI throws) handled inside the lib;
      // a top-level throw means the loop didn't complete, which is
      // worth surfacing but not flagging as 'failed' since some
      // work likely landed. (Phase 4 partial-status work will
      // refine this — for now sub-call diagnostics are the trail.)
    }

    return {
      itemsProcessed: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      output: { error: scanError },
      agentOutputs,
    };
  },
};
