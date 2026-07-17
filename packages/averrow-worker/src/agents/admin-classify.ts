/**
 * Admin Classify — synchronous AI agent for the admin
 * "backfill unclassified threats" endpoint
 * (handlers/admin.ts handleBackfillClassifications).
 *
 * Different shape from the other Phase 3 sync agents but the same
 * shape as brand_deep_scan: the handler hands the agent a *batch* of
 * unclassified threats (up to N) and the agent makes one Haiku
 * classification call per threat, then returns the per-row results.
 * ONE agent_runs row covers the whole batch — N internal AI calls,
 * not N agent_runs.
 *
 * The handler used to hardcode `agentId: "admin-classify"` in
 * classifyThreat() calls so attribution landed in budget_ledger but
 * with no agent_runs row, no FC supervision, no input/output schema
 * validation, and the rule-based fallback rolled into the handler.
 *
 * Phase 3.9 of agent audit.
 *
 * Defenses:
 *   - Input schema bounds the batch size (≤200) and per-threat field
 *     lengths to keep prompts predictable.
 *   - Per-call cost guard via callJsonSafe inside lib/haiku.ts.
 *   - Rule-based fallback (severity by feed name + threat_type)
 *     replaces AI failure paths so the handler always gets a
 *     classification per row.
 */

import { z } from "zod";
import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { classifyThreat } from "../lib/haiku";

// ─── Input contract ─────────────────────────────────────────────

const ThreatRowSchema = z.object({
  id: z.string().min(1).max(80),
  malicious_url: z.string().min(1).max(2048).nullable(),
  malicious_domain: z.string().min(1).max(253).nullable(),
  ip_address: z.string().min(1).max(64).nullable(),
  source_feed: z.string().min(1).max(60),
  ioc_value: z.string().min(1).max(2048).nullable(),
  threat_type: z.string().min(1).max(60),
});

export const AdminClassifyInputSchema = z.object({
  threats: z.array(ThreatRowSchema).min(1).max(200),
});

export type AdminClassifyInput = z.infer<typeof AdminClassifyInputSchema>;

// ─── Output contract ────────────────────────────────────────────

const ClassificationSchema = z.object({
  id: z.string(),
  confidence: z.number().int().min(0).max(100),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  /** True iff the AI returned a parseable classification. False
   *  means the rule-based fallback was used. */
  aiSucceeded: z.boolean(),
});

export const AdminClassifyOutputSchema = z.object({
  classifications: z.array(ClassificationSchema),
  aiAttempted: z.number().int().min(0),
  aiParsed: z.number().int().min(0),
});

export type AdminClassifyOutput = z.infer<typeof AdminClassifyOutputSchema>;

// ─── Rule-based fallback (matches legacy handler) ───────────────

const HIGH_CONF_FEEDS = new Set(["phishtank", "threatfox", "feodo"]);
const MED_CONF_FEEDS = new Set(["urlhaus", "openphish"]);

function ruleBasedFallback(threat: AdminClassifyInput["threats"][number]): {
  confidence: number;
  severity: "critical" | "high" | "medium" | "low" | "info";
} {
  const feed = threat.source_feed.toLowerCase();
  const confidence = HIGH_CONF_FEEDS.has(feed) ? 90 : MED_CONF_FEEDS.has(feed) ? 80 : 60;
  const severity =
    threat.threat_type === "c2" || feed === "feodo"
      ? "critical"
      : threat.threat_type === "malware_distribution"
        ? "high"
        : "medium";
  return { confidence, severity };
}

const PROMPT_VERSION = "v1.0.0";

// ─── Agent module ───────────────────────────────────────────────

export const adminClassifyAgent: AgentModule = {
  name: "admin_classify",
  displayName: "Admin Classify",
  description: "Synchronous AI agent — Haiku classification of unclassified threats during admin backfill (batch, up to 200 calls per run)",
  color: "#FB923C",
  trigger: "api",
  requiresApproval: false,
  stallThresholdMinutes: 30,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 50_000_000 },
  // Direct SQL surface is empty — handler reads/updates threats via
  // the call site (handlers/admin.ts handleBackfillClassifications).
  reads: [],
  writes: [],
  outputs: [{ type: "classification" }, { type: "diagnostic" }],
  status: "retired",  // PR-P 2026-05-14: zero real usage in 14d (last call 2026-04-30 from a one-time test harness). Doc-only retirement — file + API route intact, re-activate by flipping status back.
  category: "sync",
  pipelinePosition: 30,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    const agentOutputs: AgentOutputEntry[] = [];

    const parseResult = AdminClassifyInputSchema.safeParse(ctx.input);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      agentOutputs.push({
        type: "diagnostic",
        summary: `admin_classify rejected input: ${issues.join("; ")}`,
        severity: "high",
        details: { issues },
      });
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { error: "input_schema_failed", issues },
        agentOutputs,
      };
    }
    const input = parseResult.data;

    const classifications: AdminClassifyOutput["classifications"] = [];
    let aiAttempted = 0;
    let aiParsed = 0;

    for (const threat of input.threats) {
      aiAttempted++;
      const result = await classifyThreat(env, { agentId: "admin_classify", runId: ctx.runId }, {
        malicious_url: threat.malicious_url,
        malicious_domain: threat.malicious_domain,
        ip_address: threat.ip_address,
        source_feed: threat.source_feed,
        ioc_value: threat.ioc_value,
      });

      if (result.success && result.data && typeof result.data.confidence === "number") {
        const sev = (result.data.severity ?? "medium").toLowerCase();
        const severity = (
          ["critical", "high", "medium", "low", "info"].includes(sev) ? sev : "medium"
        ) as "critical" | "high" | "medium" | "low" | "info";
        classifications.push({
          id: threat.id,
          confidence: Math.max(0, Math.min(100, Math.round(result.data.confidence))),
          severity,
          aiSucceeded: true,
        });
        aiParsed++;
      } else {
        const fb = ruleBasedFallback(threat);
        classifications.push({
          id: threat.id,
          confidence: fb.confidence,
          severity: fb.severity,
          aiSucceeded: false,
        });
      }
    }

    const aiFailures = aiAttempted - aiParsed;

    agentOutputs.push({
      type: "classification",
      summary: `admin_classify: ${aiParsed}/${aiAttempted} AI-classified, ${aiFailures} rule-based fallback`,
      severity: aiFailures > aiAttempted / 2 ? "high" : "info",
      details: {
        threats_total: classifications.length,
        ai_attempted: aiAttempted,
        ai_parsed: aiParsed,
        ai_failures: aiFailures,
        promptVersion: PROMPT_VERSION,
      },
    });

    const finalOutput: AdminClassifyOutput = { classifications, aiAttempted, aiParsed };
    const finalParse = AdminClassifyOutputSchema.safeParse(finalOutput);
    if (!finalParse.success) {
      throw new Error(
        `admin_classify final output failed schema: ${finalParse.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    return {
      itemsProcessed: classifications.length,
      itemsCreated: 0,
      itemsUpdated: 0,
      output: finalParse.data,
      agentOutputs,
    };
  },
};
