/**
 * ARCHITECT meta-agent — standard AgentModule.
 *
 * Runs the full audit pipeline as one chain inside execute():
 *
 *   1. Collect — repo manifest + data-layer inventory + ops telemetry
 *      + feed runtime, assembled into a ContextBundle. The bundle is
 *      uploaded to the ARCHITECT_BUNDLES R2 binding so the markdown
 *      report can reference it later, and so we have a frozen
 *      snapshot to diff against on the next run.
 *
 *   2. Analyze — three Haiku tool_use calls in parallel, one per
 *      section (agents, feeds, data_layer). Each call sees only its
 *      relevant slice of the bundle so we don't pay tokens to
 *      re-send the whole inventory three times.
 *
 *   3. Synthesize — single Sonnet tool_use call that takes the
 *      computed (server-side) scorecard plus all three Phase 2
 *      analyses and emits a markdown executive report. The
 *      scorecard is computed deterministically from the assessments
 *      arrays, not from Haiku's self-reported numbers.
 *
 * The report markdown, computed scorecard, bundle R2 key, and the
 * three section analyses all land in `agent_outputs.details` for the
 * single output row this agent produces. Run state (status, duration,
 * tokens, errors) lives in `agent_runs` like every other agent —
 * agentRunner.executeAgent() handles that bookkeeping automatically.
 *
 * Triggered like every other agent via POST /api/agents/architect/trigger.
 * No bespoke admin routes, no Queue fan-out, no D1 tables of its own.
 */

import type {
  AgentContext,
  AgentModule,
  AgentResult,
} from "../../lib/agentRunner";

import {
  analyzeAgents,
  analyzeDataLayer,
  analyzeFeeds,
} from "./analysis/analyzer";
import { collectDataLayerInventory, collectFeedRuntime } from "./collectors/data-layer";
import { collectOpsTelemetry } from "./collectors/ops";
import { collectRepoInventory } from "./collectors/repo";
import { computeScorecardFromAnalyses } from "./synthesis/scorecard";
import {
  SONNET_MODEL,
  synthesizeFromInputs,
} from "./synthesis/synthesizer";
import type { ContextBundle } from "./types";

export const architectAgent: AgentModule = {
  name: "architect",
  displayName: "Architect",
  description:
    "Meta-agent — audits the platform (agents, feeds, data layer) and emits a markdown executive report",
  color: "#E5A832",
  trigger: "manual",
  requiresApproval: false,
  // Architect is RETIRED 2026-04-29 (Phase 2.2 of agent audit). The
  // module is kept as a typecheck reference but is not in agentModules.
  // Threshold is high so any accidental dispatch isn't auto-recovered.
  stallThresholdMinutes: 1500,
  parallelMax: 1,
  costGuard: "enforced",
  // Retired 2026-04-29; cap=0 so any accidental dispatch surfaces.
  budget: { monthlyTokenCap: 0 },
  // Retired — empty resource declarations. Drift CI gate ignores
  // architect since it's not in agentModules anymore.
  reads: [],
  writes: [],
  outputs: [],
  // RETIRED 2026-04-29 (Phase 2.2). Module kept around as a typecheck
  // reference; not in agentModules. FC's getAgentsToMonitor only
  // returns registered modules, so 'retired' here doesn't surface in
  // dispatch logic — the field is the formal lifecycle marker.
  status: "retired",
  category: "meta",
  pipelinePosition: 11,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, runId } = ctx;

    if (!env.ARCHITECT_BUNDLES) {
      throw new Error(
        "ARCHITECT requires ARCHITECT_BUNDLES R2 binding to be configured",
      );
    }

    // ─── Step 1: Collect ──────────────────────────────────────────
    // Repo inventory comes from the build-time manifest committed at
    // src/agents/architect/manifest.generated.ts — Workers have no
    // filesystem so we cannot walk the tree at request time.
    const repo = collectRepoInventory();

    const [dataLayer, ops, feedRuntime] = await Promise.all([
      collectDataLayerInventory(env),
      collectOpsTelemetry(env),
      collectFeedRuntime(env),
    ]);

    const bundle: ContextBundle = {
      bundle_version: 2,
      run_id: runId,
      generated_at: new Date().toISOString(),
      repo,
      data_layer: dataLayer,
      ops,
      feed_runtime: feedRuntime,
    };

    const bundleJson = JSON.stringify(bundle, null, 2);
    const r2Key = `architect/bundles/${runId}.json`;
    await env.ARCHITECT_BUNDLES.put(r2Key, bundleJson, {
      httpMetadata: { contentType: "application/json" },
    });

    // ─── Step 2: Analyze (three sections in parallel) ─────────────
    // Each analyzer sees only its own slice of the bundle so input
    // tokens stay flat. The per-call cost cap is enforced inside
    // analyzer.ts; if any section blows the cap the whole agent run
    // fails and the standard agent_runs error path catches it.
    const [agentsResult, feedsResult, dataLayerResult] = await Promise.all([
      analyzeAgents(bundle, env),
      analyzeFeeds(bundle, env),
      analyzeDataLayer(bundle, env),
    ]);

    // ─── Step 3: Compute scorecard + Sonnet synthesis ─────────────
    const analyses = [
      agentsResult.analysis,
      feedsResult.analysis,
      dataLayerResult.analysis,
    ];
    const computedScorecard = computeScorecardFromAnalyses(analyses);

    const synthesis = await synthesizeFromInputs(
      runId,
      bundle,
      analyses,
      env,
    );

    // ─── Aggregate cost / tokens for agent_runs bookkeeping ───────
    const totalInputTokens =
      agentsResult.input_tokens +
      feedsResult.input_tokens +
      dataLayerResult.input_tokens +
      synthesis.usage.input_tokens;
    const totalOutputTokens =
      agentsResult.output_tokens +
      feedsResult.output_tokens +
      dataLayerResult.output_tokens +
      synthesis.usage.output_tokens;
    const totalTokens = totalInputTokens + totalOutputTokens;
    const totalCostUsd =
      agentsResult.cost_usd +
      feedsResult.cost_usd +
      dataLayerResult.cost_usd +
      synthesis.usage.cost_usd;

    // Severity flag drives the agent_outputs.severity column. Reds in
    // the overall scorecard mean the platform has near-term liabilities
    // worth raising in the alert ticker.
    const overallSeverity: "high" | "medium" | "info" =
      computedScorecard.overall.red > 0
        ? "high"
        : computedScorecard.overall.amber > 0
          ? "medium"
          : "info";

    return {
      itemsProcessed: 1,
      itemsCreated: 1,
      itemsUpdated: 0,
      output: {
        run_id: runId,
        bundle_r2_key: r2Key,
        cost_usd: totalCostUsd,
        scorecard: computedScorecard,
      },
      model: SONNET_MODEL,
      tokensUsed: totalTokens,
      agentOutputs: [
        {
          type: "diagnostic",
          summary: `ARCHITECT audit complete — ${computedScorecard.overall.red} red, ${computedScorecard.overall.amber} amber, ${computedScorecard.overall.green} green across ${computedScorecard.overall.total} components ($${totalCostUsd.toFixed(2)})`,
          severity: overallSeverity,
          details: {
            run_id: runId,
            bundle_r2_key: r2Key,
            report_md: synthesis.report_md,
            computed_scorecard: computedScorecard,
            cost_breakdown: {
              agents: agentsResult.cost_usd,
              feeds: feedsResult.cost_usd,
              data_layer: dataLayerResult.cost_usd,
              synthesis: synthesis.usage.cost_usd,
              total: totalCostUsd,
            },
            analyses: [
              {
                section: "agents",
                model: agentsResult.model,
                input_tokens: agentsResult.input_tokens,
                output_tokens: agentsResult.output_tokens,
                cost_usd: agentsResult.cost_usd,
                duration_ms: agentsResult.duration_ms,
                analysis: agentsResult.analysis,
              },
              {
                section: "feeds",
                model: feedsResult.model,
                input_tokens: feedsResult.input_tokens,
                output_tokens: feedsResult.output_tokens,
                cost_usd: feedsResult.cost_usd,
                duration_ms: feedsResult.duration_ms,
                analysis: feedsResult.analysis,
              },
              {
                section: "data_layer",
                model: dataLayerResult.model,
                input_tokens: dataLayerResult.input_tokens,
                output_tokens: dataLayerResult.output_tokens,
                cost_usd: dataLayerResult.cost_usd,
                duration_ms: dataLayerResult.duration_ms,
                analysis: dataLayerResult.analysis,
              },
            ],
            synthesis_usage: synthesis.usage,
          },
        },
      ],
    };
  },
};
