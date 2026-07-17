/**
 * ARCHITECT Phase 3 — Sonnet synthesis.
 *
 * synthesizeFromInputs(bundle, analyses, env) takes the in-memory
 * ContextBundle and the three Phase 2 SectionAnalysis payloads
 * directly, computes the ground-truth scorecard, and asks
 * Sonnet 4.5 to emit a single markdown executive report that
 * reconciles contradictions Haiku may have introduced.
 *
 * The function:
 * - Single tool_use call (`report_synthesis_markdown`) so the model
 *   cannot drift into free prose or skip the required field.
 * - Shared transport selection: Cloudflare AI Gateway when
 *   CF_ACCOUNT_ID is set, direct api.anthropic.com otherwise.
 * - Per-call cost cap ($1.00) enforced after the usage numbers come
 *   back — Sonnet is more expensive than Haiku but still cheap for
 *   one report (~$0.05-0.15 in practice).
 * - stop_reason === 'tool_use' is the only happy path; anything else
 *   throws with the actual reason in the error message so the agent
 *   run row can surface it verbatim in error_message.
 *
 * No D1 reads — the architect AgentModule passes the bundle and the
 * already-computed analyses directly. Persistence is handled by the
 * standard agentRunner machinery via agent_runs / agent_outputs.
 */

import type { Env } from "../../../types";
import { estimateCost } from "../../../lib/budgetManager";
import { callAnthropic } from "../../../lib/anthropic";

import type { SectionAnalysis } from "../analysis/types";
import type { ContextBundle } from "../types";

import { computeScorecardFromAnalyses, type ComputedScorecard } from "./scorecard";

// ─── Model constants ───────────────────────────────────────────────
//
// Pricing lives in lib/budgetManager.ts COST_PER_MILLION — do not
// re-declare per-module constants. The synthesiser just picks the
// model ID and defers cost math to the canonical estimator.

export const SONNET_MODEL = "claude-sonnet-4-5-20250929";

/**
 * Hard cap per synthesis run. Sonnet 4.5 is ~5x Haiku's input rate
 * and ~3x output rate, so a typical synthesis lands around
 * $0.05–$0.15; $1.00 is the "something is catastrophically wrong"
 * tripwire, not a soft budget.
 */
export const MAX_COST_PER_SYNTHESIS_USD = 1.0;

const DEFAULT_MAX_TOKENS = 20_480;
const REQUEST_TIMEOUT_MS = 120_000;

// ─── Env subset ────────────────────────────────────────────────────

/**
 * Env subset the synthesiser needs: Anthropic credentials + DB. The
 * architect agent already runs inside agentRunner with a full Env
 * binding, so DB is free; the canonical wrapper uses it to write the
 * synthesis call to budget_ledger automatically.
 */
export type SynthesizerEnv = Pick<
  Env,
  "ANTHROPIC_API_KEY" | "LRX_API_KEY" | "CF_ACCOUNT_ID" | "DB"
>;

// ─── Tool schema ───────────────────────────────────────────────────

export const REPORT_SYNTHESIS_MARKDOWN_TOOL = {
  name: "report_synthesis_markdown",
  description:
    "Submit the final markdown executive report for the ARCHITECT audit.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["report_md"],
    properties: {
      report_md: {
        type: "string",
        maxLength: 20_000,
        description:
          "The full markdown report. Must follow the exact H1/H2 structure specified in the system prompt.",
      },
    },
  },
} as const;

// ─── Sonnet call ───────────────────────────────────────────────────

interface SynthesisUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

interface CallResult {
  report_md: string;
  usage: SynthesisUsage;
}

async function callSonnetTool(
  env: SynthesizerEnv,
  systemPrompt: string,
  userMessage: string,
): Promise<CallResult> {
  const startedAt = Date.now();

  const apiResponse = await callAnthropic(env, {
    agentId: "architect",
    runId: null,
    model: SONNET_MODEL,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: DEFAULT_MAX_TOKENS,
    tools: [REPORT_SYNTHESIS_MARKDOWN_TOOL],
    toolChoice: { type: "tool", name: REPORT_SYNTHESIS_MARKDOWN_TOOL.name },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  const durationMs = Date.now() - startedAt;

  // Same stop_reason guard as the analyzer. max_tokens is the
  // classic bloat failure mode — catch it here with the actual
  // reason + token counts so the run row's error_message tells the
  // operator exactly what happened without having to pull the raw
  // response out of logs.
  if (apiResponse.stop_reason !== "tool_use") {
    throw new Error(
      `ARCHITECT synthesizer: expected stop_reason='tool_use' but got '${apiResponse.stop_reason}' ` +
        `(in=${apiResponse.usage?.input_tokens ?? "?"}, ` +
        `out=${apiResponse.usage?.output_tokens ?? "?"})`,
    );
  }

  const toolUse = apiResponse.content.find(
    (b) =>
      b.type === "tool_use" && b.name === REPORT_SYNTHESIS_MARKDOWN_TOOL.name,
  );
  if (!toolUse || toolUse.input === undefined) {
    throw new Error(
      `ARCHITECT synthesizer: no tool_use block for '${REPORT_SYNTHESIS_MARKDOWN_TOOL.name}' in response`,
    );
  }

  const input = toolUse.input;
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof (input as { report_md?: unknown }).report_md !== "string"
  ) {
    throw new Error(
      `ARCHITECT synthesizer: tool_use input missing report_md string: ${JSON.stringify(
        input,
      ).slice(0, 500)}`,
    );
  }

  const reportMd = (input as { report_md: string }).report_md;

  const inputTokens = apiResponse.usage.input_tokens;
  const outputTokens = apiResponse.usage.output_tokens;
  const costUsd = estimateCost(apiResponse.model || SONNET_MODEL, inputTokens, outputTokens);
  if (costUsd > MAX_COST_PER_SYNTHESIS_USD) {
    throw new Error(
      `ARCHITECT synthesizer: per-synthesis cost cap exceeded: $${costUsd.toFixed(4)} > $${MAX_COST_PER_SYNTHESIS_USD.toFixed(2)} (in=${inputTokens}, out=${outputTokens})`,
    );
  }

  return {
    report_md: reportMd,
    usage: {
      model: apiResponse.model || SONNET_MODEL,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      duration_ms: durationMs,
    },
  };
}

// ─── System prompt ─────────────────────────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are ARCHITECT, the meta-agent synthesising a cross-section audit of the Averrow threat intelligence platform. You have already run three Phase 2 analyses (agents, feeds, data_layer) via Haiku. Your job now is to read those three analyses together, reconcile contradictions Haiku may have introduced, and emit a single markdown executive report.

Ground rules:
- Every claim must trace to evidence in the Phase 2 analyses or the bundle totals provided. Do not invent metrics, agents, feeds, or table names.
- The server has already computed the ground-truth scorecard from the raw assessments arrays. Use those numbers verbatim in the Scorecard table — do NOT re-count. They are authoritative.
- Reframe "kill" recommendations that are actually reconcile situations. The canonical example: a feed module whose repo code has no matching feed_configs row AND whose runtime twin is pulling successfully under a slightly different name. That is NOT a kill — it is a naming reconcile. Haiku frequently gets this wrong; catch it here.
- If two sections make claims that contradict each other, pick the claim best supported by concrete evidence (run counts, failure counts, telemetry warnings, last_error excerpts) and flag the contradiction in "Things ARCHITECT Got Wrong This Run."
- Be honest about Haiku's mistakes. The self-correction section builds trust over time — do not hide errors.
- Actionable > vague. Every Top-5 priority must have a concrete Claude Code prompt the user can paste directly into a new session.

Claude Code prompt format (used in Top 5 Priorities). Every prompt you emit must follow the same shape we've been using all along:

\`\`\`
Job: <one-line objective>
Scope: <which packages / directories / files>
Path discipline: <explicit "do not touch" boundaries>
Done means: <bulleted, verifiable success criteria>
Out of scope: <bulleted, explicit exclusions>
\`\`\`

Output contract — you MUST call the report_synthesis_markdown tool with a single field \`report_md\` containing a markdown document with this EXACT structure:

# ARCHITECT Audit — <YYYY-MM-DD>

## Executive Summary
<3-5 sentences. Headline findings only. What's burning, what's stable, what to do this week.>

## Scorecard
| Section | Green | Amber | Red | Total |
|---|---|---|---|---|
| Agents | ... | ... | ... | ... |
| Feeds | ... | ... | ... | ... |
| Data Layer | ... | ... | ... | ... |
| **Overall** | ... | ... | ... | ... |

## Top 5 Priorities (this week)
For each: ### title, one-paragraph explanation, evidence bullets, then a ready-to-paste Claude Code prompt in a fenced \`\`\`text block following the format above.

## All Findings by Section
### Agents
<bulleted findings, one line each, with a severity tag like [red]/[amber]/[green]>
### Feeds
<same>
### Data Layer
<same>

## Cross-Cutting Patterns
<patterns spanning sections — things that touch multiple areas and can't be fixed in one place>

## Things ARCHITECT Got Wrong This Run
<self-correction section. Flag Haiku misclassifications you noticed during synthesis. Builds trust over time.>

## Suggested Next Audit Date
<one line — pick a cadence matching severity>

Use the server-computed scorecard numbers exactly as provided. Keep the report under 20,000 characters — the tool will reject anything longer.`;

// ─── Public entry point ────────────────────────────────────────────

export interface SynthesizeResult {
  report_md: string;
  computed_scorecard: ComputedScorecard;
  usage: SynthesisUsage;
}

/**
 * Run a full synthesis from in-memory inputs.
 *
 * 1. Compute the ground-truth scorecard from the assessments arrays.
 * 2. Build the user payload from the bundle's totals + the three
 *    structured analyses.
 * 3. Call Sonnet via tool_use with the computed scorecard inlined.
 * 4. Return the markdown + scorecard + usage so the caller can
 *    persist them via standard agent_outputs storage.
 */
export async function synthesizeFromInputs(
  runId: string,
  bundle: ContextBundle,
  analyses: SectionAnalysis[],
  env: SynthesizerEnv,
): Promise<SynthesizeResult> {
  const computedScorecard = computeScorecardFromAnalyses(analyses);

  const structuredAnalyses = analyses.map((analysis) => ({
    section: analysis.section,
    analysis,
  }));

  const userPayload = {
    run_id: runId,
    generated_at: bundle.generated_at,
    ops_collected_at: bundle.ops.collected_at ?? null,
    repo_totals: bundle.repo.totals,
    data_layer_totals: bundle.data_layer.totals,
    telemetry_warnings: bundle.ops.telemetry_warnings ?? [],
    computed_scorecard: computedScorecard,
    phase2_analyses: structuredAnalyses,
  };

  const userMessage =
    `Synthesize the ARCHITECT audit for run_id=${runId}.\n\n` +
    `INPUT — computed scorecard + three Phase 2 analyses:\n` +
    `${JSON.stringify(userPayload, null, 2)}`;

  const { report_md, usage } = await callSonnetTool(
    env,
    SYNTHESIS_SYSTEM_PROMPT,
    userMessage,
  );

  return {
    report_md,
    computed_scorecard: computedScorecard,
    usage,
  };
}
