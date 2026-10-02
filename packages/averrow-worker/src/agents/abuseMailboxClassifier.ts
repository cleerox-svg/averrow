/**
 * Abuse Mailbox Classifier Agent ("Sifter") — the hourly abuse-report
 * triage sweeper, wrapped as a first-class AgentModule so every run lands
 * in agent_runs / agent_outputs and surfaces in Flight Control +
 * platform-diagnostics + the Agents UI.
 *
 * Primary path is per message: handlers/abuseMailboxEmail.ts dispatches
 * the AbuseMailboxTriageWorkflow on receipt (rules verdict → ~2 min →
 * determination email). This agent is the backstop, in three stages:
 *
 *   1. Rules pass (`runAbuseRulesPass`, lib/abuse-mailbox-rules-runner.ts)
 *      over up to `limit` pending rows — deterministic, no AI, runs under
 *      AI_MODE=rules_only. Verdicts: phishing / malware on positive
 *      evidence (intel correlation, named-threat IOC/regex, device-code
 *      lure, executable attachment), otherwise ambiguous → analyst review.
 *   2. AI pass (`runAbuseClassifierBackfill`) — optional second opinion on
 *      rules REVIEW rows; skipped entirely under AI_MODE=rules_only.
 *   3. Determination sweeper (`sweepAbuseDeterminations`) — emails any
 *      verdict the Workflow missed, exactly once (atomic claim).
 *
 * Dispatched from the dedicated `17 * * * *` cron (cron/orchestrator.ts) via
 * executeAgent, and manually via /api/internal/agents/abuse_mailbox_classifier/run.
 * The standalone /api/admin/abuse-mailbox/run-classifier drain endpoint stays
 * as a direct operator tool for the AI pass (it bypasses the runner).
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";

export const abuseMailboxClassifierAgent: AgentModule = {
  name: "abuse_mailbox_classifier",
  displayName: "Sifter",
  description:
    "Triages forwarded abuse-report emails — rules-based verdicts from threat-intel correlation, named-threat signatures, device-code lures and attachment types (optional AI second opinion), promotes confirmed threats, and emails reporters a determination",
  color: "#0A8AB5",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 30,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 10_000_000 },
  // Direct SQL surface is empty — delegates to lib/abuse-mailbox-*.
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "response",
  pipelinePosition: 41,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, input } = ctx;
    const { runAbuseRulesPass } = await import("../lib/abuse-mailbox-rules-runner");
    const { runAbuseClassifierBackfill } = await import("../lib/abuse-mailbox-classifier");
    const { sweepAbuseDeterminations } = await import("../lib/abuse-mailbox-determination");

    const limit = typeof input.limit === "number" ? input.limit : 50;
    const offset = typeof input.offset === "number" ? input.offset : 0;

    // Rules first — ahead of the AI gate inside runAbuseClassifierBackfill.
    const rules = await runAbuseRulesPass(env, { limit });
    const stats = await runAbuseClassifierBackfill(env, { limit, offset });
    const sweep = await sweepAbuseDeterminations(env, { limit });

    const outputs: AgentOutputEntry[] = [];
    if (rules.scanned > 0 || stats.classified > 0 || stats.failed > 0 || sweep.sent > 0) {
      const bc = stats.by_classification;
      outputs.push({
        type: "diagnostic",
        summary:
          `Abuse triage: rules ${rules.scanned} scanned (${rules.malicious} malicious, ${rules.review} review, ${rules.errors} errors); ` +
          (stats.skipped_rules_only
            ? "AI pass skipped (rules_only); "
            : `AI ${stats.classified} classified (${bc.phishing} phishing, ${bc.malware} malware, ${bc.spam} spam, ${bc.benign} benign, ${bc.ambiguous} ambiguous), ${stats.failed} failed; `) +
          `${sweep.sent}/${sweep.candidates} determinations swept`,
        severity: rules.malicious > 0 || bc.phishing > 0 || bc.malware > 0 ? "medium" : "info",
        details: { rules: { ...rules }, ai: { ...stats }, sweep: { ...sweep } },
      });
    }

    return {
      itemsProcessed: rules.scanned + stats.scanned,
      itemsCreated: rules.malicious + rules.review + stats.classified,
      itemsUpdated: sweep.sent,
      output: { rules: { ...rules }, ai: { ...stats }, sweep: { ...sweep } },
      agentOutputs: outputs,
    };
  },
};
