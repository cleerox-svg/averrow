/**
 * Abuse Mailbox Classifier Agent — wraps the abuse-report triage backfill
 * as a first-class AgentModule so every run lands in agent_runs /
 * agent_outputs and surfaces in Flight Control + platform-diagnostics +
 * the Agents UI.
 *
 * The batch (`runAbuseClassifierBackfill`) already handles:
 *   - pending-row selection (skips throttled + retry-capped rows)
 *   - Haiku classification → phishing / malware / spam / benign / ambiguous
 *   - severity computation + poison-pill retry graduation
 *   - threat promotion + Sonnet deep analysis + determination emails on
 *     HIGH / CRITICAL phishing|malware
 *
 * This wrapper converts the batch return into an AgentResult and emits a
 * single diagnostic agent_outputs row when the tick did work.
 *
 * Dispatched from the dedicated `17 * * * *` cron (cron/orchestrator.ts) via
 * executeAgent, and manually via /api/internal/agents/abuse_mailbox_classifier/run.
 * The standalone /api/admin/abuse-mailbox/run-classifier drain endpoint stays
 * as a direct operator tool (it bypasses the runner intentionally).
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";

export const abuseMailboxClassifierAgent: AgentModule = {
  name: "abuse_mailbox_classifier",
  displayName: "Sifter",
  description:
    "Triages forwarded abuse-report emails — classifies phishing/malware/spam/benign via Haiku, promotes confirmed threats, and emails reporters a determination",
  color: "#0A8AB5",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 30,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 10_000_000 },
  // Direct SQL surface is empty — delegates to lib/abuse-mailbox-classifier.
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "response",
  pipelinePosition: 41,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, input } = ctx;
    const { runAbuseClassifierBackfill } = await import("../lib/abuse-mailbox-classifier");

    const limit = typeof input.limit === "number" ? input.limit : 50;
    const offset = typeof input.offset === "number" ? input.offset : 0;

    const stats = await runAbuseClassifierBackfill(env, { limit, offset });

    const outputs: AgentOutputEntry[] = [];
    if (stats.classified > 0 || stats.failed > 0) {
      const bc = stats.by_classification;
      outputs.push({
        type: "diagnostic",
        summary: `Abuse triage: ${stats.scanned} scanned, ${stats.classified} classified (${bc.phishing} phishing, ${bc.malware} malware, ${bc.spam} spam, ${bc.benign} benign, ${bc.ambiguous} ambiguous), ${stats.failed} failed`,
        severity: bc.phishing > 0 || bc.malware > 0 ? "medium" : "info",
        details: { ...stats },
      });
    }

    return {
      itemsProcessed: stats.scanned,
      itemsCreated: stats.classified,
      itemsUpdated: 0,
      output: { ...stats },
      agentOutputs: outputs,
    };
  },
};
