/**
 * Generic agentic tool-use loop.
 *
 * This is the piece the platform's batch agents do NOT have: a multi-turn
 * loop where the *model* decides the next tool call, we execute it, feed the
 * result back, and repeat until the model calls a terminal tool (or a hard
 * turn cap trips). `lib/anthropic.ts` already plumbs `tools` + `toolChoice`
 * and returns the raw content blocks — this helper adds the loop, the
 * tool-result threading, and the durable-step seam.
 *
 * Manual loop (not the SDK tool-runner) on purpose: we want the per-turn
 * cost gate (checkAgentBudget runs inside callAnthropic), per-call ledger
 * attribution, a turn-by-turn audit trail, and an injectable step boundary
 * so a Cloudflare Workflow can wrap each turn in step.do() later (Phase 2).
 *
 * See docs/AGENTIC_DEEP_SCAN_SPEC.md §3.2.
 */

import { callAnthropic, type AnthropicMessage, type AnthropicContentBlock, type AnthropicResponse } from "./anthropic";
import {
  classifyAnthropicFailure,
  isDeliberateAiSkipError,
  newAiCallCounters,
  recordAiCall,
  type AiCallCounters,
} from "./haiku";
import type { Env } from "../types";

/** Anthropic tool definition (JSON Schema input). */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** One executed tool call, kept for the audit trail. */
export interface TrailEntry {
  turn: number;
  tool: string;
  input: unknown;
  result: string;
}

/**
 * Why the loop stopped. `budget` = the per-run token budget
 * (maxRunTokens) was used up; `ai_skipped` = a deliberate skip (AI_MODE /
 * AI_CLAUDE_TASKS / spend throttle / per-agent cap) refused a turn — no
 * request left, not a failure.
 */
export type LoopStop = "submit_report" | "max_turns" | "end_turn" | "budget" | "ai_skipped";

export interface AgentLoopOptions {
  env: Env;
  /** Ledger attribution — must be a registered agent id, e.g. "campaign_hunter". */
  agentId: string;
  runId: string | null;
  model: string;
  system: string;
  tools: ToolDef[];
  /** Name of the terminal tool that ends the loop with the structured payload. */
  terminalTool: string;
  /** Execute one (non-terminal) tool call; return a string the model reads back. */
  runTool: (name: string, input: unknown) => Promise<string>;
  /** Opening user message — the investigation goal + brand identity. */
  initialUserMessage: string;
  /** Hard stop on runaway loops. */
  maxTurns: number;
  /** Output tokens per turn. */
  maxTokensPerTurn?: number;
  /**
   * Per-run token budget (input + output, summed over turns). Checked
   * after each turn: once usage reaches it the loop stops with
   * `stoppedBy: "budget"` instead of starting another turn, so one run
   * cannot blow far past the agent's monthly cap (which is only checked
   * pre-flight, 60s-cached). Unset = no per-run budget.
   */
  maxRunTokens?: number;
  /** Optional durable-step wrapper (Workflow step.do). Defaults to a pass-through. */
  step?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /** Injectable model call — defaults to callAnthropic. Overridden in tests. */
  invoke?: (opts: Parameters<typeof callAnthropic>[1]) => Promise<AnthropicResponse>;
}

export interface AgentLoopResult {
  /** The terminal tool's `input`, or null if the loop ended without it. */
  finalReport: unknown | null;
  turns: number;
  trail: TrailEntry[];
  stoppedBy: LoopStop;
  /** Tokens billed across the run's model turns (input + output). */
  tokensUsed: number;
  /** Strictly-API counters (lib/haiku.ts) — one recordAiCall per turn. */
  aiCalls: AiCallCounters;
  /** Set when stoppedBy is "ai_skipped": the skip error's message. */
  skipReason?: string;
}

function toolUseBlocks(content: AnthropicContentBlock[]): AnthropicContentBlock[] {
  return content.filter((b) => b.type === "tool_use");
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const wrap = opts.step ?? (<T>(_l: string, fn: () => Promise<T>) => fn());
  const invoke = opts.invoke ?? ((o) => callAnthropic(opts.env, o));
  const maxTokens = opts.maxTokensPerTurn ?? 4096;

  const messages: AnthropicMessage[] = [
    { role: "user", content: opts.initialUserMessage },
  ];
  const trail: TrailEntry[] = [];
  const aiCalls = newAiCallCounters();
  let tokensUsed = 0;
  const done = (turns: number, stoppedBy: LoopStop, finalReport: unknown | null = null, skipReason?: string): AgentLoopResult => ({
    finalReport, turns, trail, stoppedBy, tokensUsed, aiCalls,
    ...(skipReason !== undefined ? { skipReason } : {}),
  });

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    let resp: AnthropicResponse;
    try {
      resp = await wrap(`agent-loop-turn-${turn}`, () =>
        invoke({
          agentId: opts.agentId,
          runId: opts.runId,
          model: opts.model,
          system: opts.system,
          messages,
          tools: opts.tools,
          maxTokens,
          // System prompt + tool defs are a stable prefix across every turn —
          // cache it so turns 2..N read it at ~0.1x input cost.
          cacheSystem: true,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isDeliberateAiSkipError(err)) {
        // No request left (or a Workflow step re-surfaced the skip). Stop
        // quietly with whatever the earlier turns produced.
        recordAiCall(aiCalls, { success: false, error: message, failure_kind: "throttled" }, false);
        return done(turn - 1, "ai_skipped", null, message);
      }
      recordAiCall(aiCalls, { success: false, error: message, failure_kind: classifyAnthropicFailure(err) }, false);
      throw err;
    }
    recordAiCall(aiCalls, { success: true }, true);
    tokensUsed += (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0);

    // Append the assistant turn verbatim — tool_use blocks must be preserved
    // for the next request to be a valid tool-use exchange.
    messages.push({
      role: "assistant",
      content: resp.content as unknown as Array<Record<string, unknown>>,
    });

    const calls = toolUseBlocks(resp.content);
    if (calls.length === 0) {
      // Model answered in prose with no tool call — nothing more to do.
      return done(turn, "end_turn");
    }

    // Terminal tool ends the loop with its structured input.
    const terminal = calls.find((b) => b.name === opts.terminalTool);
    if (terminal) {
      return done(turn, "submit_report", terminal.input ?? null);
    }

    // Per-run token budget: don't pay for tool execution + another turn.
    if (opts.maxRunTokens !== undefined && tokensUsed >= opts.maxRunTokens) {
      return done(turn, "budget");
    }

    const results: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      const name = call.name ?? "unknown";
      let result: string;
      try {
        result = await opts.runTool(name, call.input);
      } catch (err) {
        result = `tool_error: ${err instanceof Error ? err.message : String(err)}`;
      }
      trail.push({ turn, tool: name, input: call.input, result });
      results.push({
        type: "tool_result",
        tool_use_id: call.id ?? "",
        content: result,
      });
    }
    messages.push({ role: "user", content: results });
  }

  return done(opts.maxTurns, "max_turns");
}
