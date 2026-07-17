/**
 * ARCHITECT Phase 2 — Haiku analyzer functions.
 *
 * Three pure-ish functions, one per bundle section, each of which
 * sends ONLY its relevant slice to claude-haiku-4-5-20251001 (don't
 * pay tokens to re-send the whole bundle for every call), and
 * constrains Haiku to call a single `tool_use` tool whose JSON schema
 * mirrors the corresponding TS interface in `./types.ts`.
 *
 * Why tool_use instead of prose-JSON:
 * - The Anthropic API guarantees that `content[i].input` for a
 *   `tool_use` block is already a parsed JSON object matching the
 *   declared `input_schema`, so we don't need fence-stripping,
 *   brace-hunting, or retry-with-stricter-prompt.
 * - The `maxLength` constraints in the schemas cap output token
 *   bloat at the source — Haiku can't write prose essays per field
 *   even if asked.
 * - `tool_choice: { type: "tool", name: ... }` forces Haiku to call
 *   the tool; it can't respond in free text.
 *
 * Transport selection:
 * - All calls go through the canonical Anthropic wrapper at
 *   lib/anthropic.ts, which routes through Cloudflare AI Gateway
 *   (`averrow-ai-gateway/anthropic`) when `env.CF_ACCOUNT_ID` is set
 *   so cache hits are free on re-runs against the same bundle, and
 *   falls back to the direct Anthropic Messages API otherwise. The
 *   wrapper also writes a budget_ledger row per call automatically.
 *
 * Cost governance:
 * - Per-call hard cap: MAX_COST_PER_CALL_USD ($0.50). If a call is
 *   measured to exceed it we throw — the orchestrator records the
 *   failed row but continues with the other sections.
 * - Per-run cap lives in the orchestrator; analyzers enforce the
 *   per-call cap only.
 */

import type { Env } from "../../../types";
import type {
  ContextBundle,
  DataLayerInventory,
  FeedRuntimeRow,
  OpsTelemetry,
  RepoInventory,
} from "../types";

import { estimateCost } from "../../../lib/budgetManager";
import { callAnthropic } from "../../../lib/anthropic";
import {
  parseAgentsAnalysis,
  parseDataLayerAnalysis,
  parseFeedsAnalysis,
} from "./schema";
import {
  REPORT_AGENTS_ANALYSIS_TOOL,
  REPORT_DATA_LAYER_ANALYSIS_TOOL,
  REPORT_FEEDS_ANALYSIS_TOOL,
} from "./tool-schemas";
import type {
  AgentsAnalysis,
  AnalyzerResult,
  DataLayerAnalysis,
  FeedsAnalysis,
  SectionAnalysis,
} from "./types";

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";

/**
 * Hard cap per individual analyzer call. Haiku is cheap, but analyses
 * take ~4-8k input tokens and 1-2k output tokens so a single call
 * should land well under $0.05 — the $0.50 cap is the "something is
 * catastrophically wrong" tripwire, not a soft budget.
 */
export const MAX_COST_PER_CALL_USD = 0.5;

/**
 * Hard cap for a full Phase 2 run (all three sections combined).
 * Tripped by the orchestrator after each analyzer returns.
 */
export const MAX_COST_PER_RUN_USD = 2.0;

const DEFAULT_MAX_TOKENS = 16384;
const REQUEST_TIMEOUT_MS = 120_000;

// ─── Env subset the analyzers need ─────────────────────────────────

// DB is included so the canonical Anthropic wrapper can write each
// analyzer call to budget_ledger. The architect agent already runs
// inside agentRunner with a full Env binding, so threading DB through
// is free.
export type AnalyzerEnv = Pick<
  Env,
  "ANTHROPIC_API_KEY" | "LRX_API_KEY" | "CF_ACCOUNT_ID" | "DB"
>;

// ─── Shared Haiku call ─────────────────────────────────────────────

interface CallResult {
  input: unknown;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

type ToolSchema =
  | typeof REPORT_AGENTS_ANALYSIS_TOOL
  | typeof REPORT_FEEDS_ANALYSIS_TOOL
  | typeof REPORT_DATA_LAYER_ANALYSIS_TOOL;

async function callHaikuTool(
  env: AnalyzerEnv,
  systemPrompt: string,
  userMessage: string,
  tool: ToolSchema,
): Promise<CallResult> {
  const startedAt = Date.now();

  const apiResponse = await callAnthropic(env, {
    agentId: "architect",
    runId: null,
    model: HAIKU_MODEL,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: DEFAULT_MAX_TOKENS,
    tools: [tool],
    toolChoice: { type: "tool", name: tool.name },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  const durationMs = Date.now() - startedAt;

  // Check stop_reason BEFORE reading content — catches the truncation
  // case explicitly instead of letting it cascade into a missing-tool
  // parse error. Expected: "tool_use". Anything else is a failure we
  // want surfaced with the actual reason in error_message.
  if (apiResponse.stop_reason !== "tool_use") {
    throw new Error(
      `ARCHITECT analyzer: expected stop_reason='tool_use' but got '${apiResponse.stop_reason}' ` +
        `(tool=${tool.name}, in=${apiResponse.usage?.input_tokens ?? "?"}, ` +
        `out=${apiResponse.usage?.output_tokens ?? "?"})`,
    );
  }

  const toolUse = apiResponse.content.find(
    (b) => b.type === "tool_use" && b.name === tool.name,
  );
  if (!toolUse || toolUse.input === undefined) {
    throw new Error(
      `ARCHITECT analyzer: no tool_use block for '${tool.name}' in response`,
    );
  }

  const inputTokens = apiResponse.usage.input_tokens;
  const outputTokens = apiResponse.usage.output_tokens;
  const costUsd = estimateCost(apiResponse.model || HAIKU_MODEL, inputTokens, outputTokens);
  if (costUsd > MAX_COST_PER_CALL_USD) {
    throw new Error(
      `ARCHITECT analyzer: per-call cost cap exceeded: $${costUsd.toFixed(4)} > $${MAX_COST_PER_CALL_USD.toFixed(2)} (in=${inputTokens}, out=${outputTokens})`,
    );
  }

  return {
    input: toolUse.input,
    model: apiResponse.model || HAIKU_MODEL,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
    duration_ms: durationMs,
  };
}

// ─── Bundle slicing ────────────────────────────────────────────────
//
// Each analyzer sees a focused slice of the bundle. We cross-reference
// ops telemetry in the agents slice (so the model can cite failures /
// CPU timeouts / ghost rows as evidence), and pass telemetry_warnings
// verbatim so the model knows which zero-valued fields mean "missing
// signal" rather than "nothing happened".

interface AgentsSlice {
  repo_totals: RepoInventory["totals"];
  agents: RepoInventory["agents"];
  crons: RepoInventory["crons"];
  agent_telemetry_7d: OpsTelemetry["agents"];
  cron_telemetry_7d: OpsTelemetry["crons"];
  ai_gateway_7d: OpsTelemetry["ai_gateway"];
  telemetry_warnings: string[];
  telemetry_window_days: number;
}

/**
 * One feeds analyzer input row — a repo feed module joined to its
 * runtime dispatch state. `schedule_cron` comes from feed_configs via
 * feed_runtime; `repo.feeds[].schedule` is always null by design and
 * is not forwarded.
 */
interface FeedWithRuntime {
  name: string;
  path: string;
  source_type: string;
  loc: number;
  last_modified: string;
  /** `true` when a feed_runtime row exists for this feed name. */
  has_runtime: boolean;
  /** `1` = enabled in feed_configs, `0` = disabled, `null` = no runtime row. */
  enabled: number | null;
  schedule_cron: string | null;
  last_successful_pull: string | null;
  last_attempted_pull: string | null;
  last_error: string | null;
  consecutive_failures: number | null;
  pulls_7d: number | null;
  successes_7d: number | null;
}

interface FeedsSlice {
  repo_totals: RepoInventory["totals"];
  /** Repo feed modules joined to their runtime dispatch state. */
  feeds: FeedWithRuntime[];
  /**
   * Any feed_runtime rows whose feed_name does not match a repo feed
   * module — typically legacy rows in feed_configs that no longer
   * have code. Empty in the happy case.
   */
  orphan_runtime: FeedRuntimeRow[];
  crons: RepoInventory["crons"];
  queues_depth: OpsTelemetry["queues_depth"];
  telemetry_warnings: string[];
}

interface DataLayerSlice {
  collected_at: DataLayerInventory["collected_at"];
  totals: DataLayerInventory["totals"];
  tables: DataLayerInventory["tables"];
  telemetry_warnings: string[];
}

function buildAgentsSlice(bundle: ContextBundle): AgentsSlice {
  return {
    repo_totals: bundle.repo.totals,
    agents: bundle.repo.agents,
    crons: bundle.repo.crons,
    agent_telemetry_7d: bundle.ops.agents,
    cron_telemetry_7d: bundle.ops.crons,
    ai_gateway_7d: bundle.ops.ai_gateway,
    telemetry_warnings: bundle.ops.telemetry_warnings,
    telemetry_window_days: bundle.ops.window_days,
  };
}

function buildFeedsSlice(bundle: ContextBundle): FeedsSlice {
  // v1 bundles (pre-feed_runtime) don't carry the field. Default to
  // empty so the rest of the slice still builds cleanly — every feed
  // will come out with has_runtime=false, which tells the model that
  // there is no runtime signal to score on (not the same as dormant).
  const runtime = bundle.feed_runtime ?? [];
  const runtimeByName = new Map<string, FeedRuntimeRow>();
  for (const row of runtime) {
    runtimeByName.set(row.feed_name, row);
  }

  const feeds: FeedWithRuntime[] = bundle.repo.feeds.map((f) => {
    const r = runtimeByName.get(f.name);
    return {
      name: f.name,
      path: f.path,
      source_type: f.source_type,
      loc: f.loc,
      last_modified: f.last_modified,
      has_runtime: r !== undefined,
      enabled: r ? r.enabled : null,
      schedule_cron: r ? r.schedule_cron : null,
      last_successful_pull: r ? r.last_successful_pull : null,
      last_attempted_pull: r ? r.last_attempted_pull : null,
      last_error: r ? r.last_error : null,
      consecutive_failures: r ? r.consecutive_failures : null,
      pulls_7d: r ? r.pulls_7d : null,
      successes_7d: r ? r.successes_7d : null,
    };
  });

  // Track feed_configs rows that have no matching repo module so
  // legacy D1 config drift is still visible to the model.
  const repoFeedNames = new Set(bundle.repo.feeds.map((f) => f.name));
  const orphanRuntime = runtime.filter((r) => !repoFeedNames.has(r.feed_name));

  return {
    repo_totals: bundle.repo.totals,
    feeds,
    orphan_runtime: orphanRuntime,
    crons: bundle.repo.crons,
    queues_depth: bundle.ops.queues_depth,
    telemetry_warnings: bundle.ops.telemetry_warnings,
  };
}

function buildDataLayerSlice(bundle: ContextBundle): DataLayerSlice {
  return {
    collected_at: bundle.data_layer.collected_at,
    totals: bundle.data_layer.totals,
    tables: bundle.data_layer.tables,
    telemetry_warnings: bundle.ops.telemetry_warnings,
  };
}

// ─── System prompts — short, role/context only ─────────────────────
//
// No schema inlined — the tool's input_schema is the contract and
// Haiku is forced to match it via tool_choice. No "return JSON only"
// pleading; the tool_use API makes that impossible to violate.

const SYSTEM_BASE =
  "You are ARCHITECT, a meta-agent auditing the Averrow threat intelligence platform. " +
  "You review inventory and ops telemetry for a single section of the platform and submit a structured assessment via the provided tool. " +
  "Ground every evidence string in a concrete signal from the input (agent name, table name, failure count, growth pct, last error excerpt). " +
  "Do not invent metrics. If a field is zero AND appears in telemetry_warnings, treat it as missing signal, not healthy. " +
  "Severity rubric: green = healthy; amber = needs attention soon (rising failures, bloat, drift, low-value work); red = actively broken or a near-term liability (repeated failures, CPU timeouts, ghost rows, runaway growth). " +
  "Recommendations: keep | split | merge | kill | refactor. Rationale must be 1-3 sentences, specific, evidence-backed. Suggested actions must be actionable, not vague.";

const AGENTS_SYSTEM_PROMPT = `${SYSTEM_BASE}

You are reviewing the AGENTS section. Cross-reference the repo agent list with 7-day ops telemetry: flag agents with failing runs, CPU timeouts (look for "exceeded CPU" / "Exceeded CPU" / "script will never generate a response" in last_error), zero runs (dead code), or runs_7d > 0 but successes_7d === 0 (ghost rows / silent failures). Any agent with sustained failures or CPU timeouts must be marked red. Use merge_with only when recommendation === "merge" and split_into only when recommendation === "split".`;

const FEEDS_SYSTEM_PROMPT = `${SYSTEM_BASE}

You are reviewing the FEEDS section. Each input row is a feed module joined to its runtime dispatch state from the feed_configs / feed_status / feed_pull_history tables.

CRITICAL — DO NOT TREAT A MISSING SCHEDULE AS DORMANT. The repo-level feed TypeScript modules deliberately do not declare a schedule in code; schedules live in the feed_configs D1 table and are hot-edited without a deploy. You will notice the input rows have no repo schedule field at all — that is by design. Use schedule_cron (which comes from feed_configs) together with the runtime fields below to judge liveness. Never flag a feed as dormant for lack of a code-level schedule.

Liveness must be judged from the runtime fields: enabled, pulls_7d, successes_7d, last_successful_pull, last_error, consecutive_failures.

Severity rubric for this section:
- has_runtime=false → amber, "no feed_configs row — orphan code or not registered in D1"
- enabled=0 → amber, recommendation: kill or keep-with-justification
- enabled=1 and pulls_7d=0 → red, truly dormant (scheduler isn't firing this feed at all)
- enabled=1 and pulls_7d>0 and successes_7d=0 → red, failing (firing but every attempt errors — cite last_error)
- consecutive_failures > 5 → amber at minimum (bump to red if it also matches a red rule above)
- enabled=1 and successes_7d>0 → green baseline (healthy) — only downgrade if there is a separate concrete concern (e.g. duplicate coverage, queue backpressure in queues_depth, cost blowup)

Evidence strings must cite runtime numbers: "pulls_7d=336, successes_7d=336, enabled=1" beats "feed is running". Cross-reference orphan_runtime entries as cross_cutting_concerns if present.`;

const DATA_LAYER_SYSTEM_PROMPT = `${SYSTEM_BASE}

You are reviewing the DATA_LAYER section. Focus on tables that will break at 10x scale: high row counts with no indexes, runaway 7-day growth (growth_7d_pct), large est_bytes relative to the D1 total, and unindexed hot tables. hot_tables = top 5 by est_bytes or 7-day growth. scale_bottlenecks = tables that will become painful at 10x current load (write amplification, index-less scans, unbounded log tables). scale_risk: low | medium | high per table, reflecting 10x projection.`;

// ─── Public analyzer functions ─────────────────────────────────────

export async function analyzeAgents(
  bundle: ContextBundle,
  env: AnalyzerEnv,
): Promise<AnalyzerResult<AgentsAnalysis>> {
  const slice = buildAgentsSlice(bundle);
  const userMessage = `Section: agents\n\nInput data:\n${JSON.stringify(slice, null, 2)}`;

  const call = await callHaikuTool(
    env,
    AGENTS_SYSTEM_PROMPT,
    userMessage,
    REPORT_AGENTS_ANALYSIS_TOOL,
  );
  // Belt-and-braces: the tool_use API guarantees the input matches
  // input_schema, but we still run the hand-rolled validator to catch
  // any drift between schema and TS types (and to narrow `unknown`).
  const analysis = parseAgentsAnalysis(call.input);
  return {
    analysis,
    model: call.model,
    input_tokens: call.input_tokens,
    output_tokens: call.output_tokens,
    cost_usd: call.cost_usd,
    duration_ms: call.duration_ms,
  };
}

export async function analyzeFeeds(
  bundle: ContextBundle,
  env: AnalyzerEnv,
): Promise<AnalyzerResult<FeedsAnalysis>> {
  const slice = buildFeedsSlice(bundle);
  const userMessage = `Section: feeds\n\nInput data:\n${JSON.stringify(slice, null, 2)}`;

  const call = await callHaikuTool(
    env,
    FEEDS_SYSTEM_PROMPT,
    userMessage,
    REPORT_FEEDS_ANALYSIS_TOOL,
  );
  const analysis = parseFeedsAnalysis(call.input);
  return {
    analysis,
    model: call.model,
    input_tokens: call.input_tokens,
    output_tokens: call.output_tokens,
    cost_usd: call.cost_usd,
    duration_ms: call.duration_ms,
  };
}

export async function analyzeDataLayer(
  bundle: ContextBundle,
  env: AnalyzerEnv,
): Promise<AnalyzerResult<DataLayerAnalysis>> {
  const slice = buildDataLayerSlice(bundle);
  const userMessage = `Section: data_layer\n\nInput data:\n${JSON.stringify(slice, null, 2)}`;

  const call = await callHaikuTool(
    env,
    DATA_LAYER_SYSTEM_PROMPT,
    userMessage,
    REPORT_DATA_LAYER_ANALYSIS_TOOL,
  );
  const analysis = parseDataLayerAnalysis(call.input);
  return {
    analysis,
    model: call.model,
    input_tokens: call.input_tokens,
    output_tokens: call.output_tokens,
    cost_usd: call.cost_usd,
    duration_ms: call.duration_ms,
  };
}

// Re-export the union for orchestrator convenience.
export type { SectionAnalysis };
