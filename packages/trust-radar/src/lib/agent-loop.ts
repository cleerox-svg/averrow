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

export type LoopStop = "submit_report" | "max_turns" | "end_turn";

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

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    const resp = await wrap(`agent-loop-turn-${turn}`, () =>
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

    // Append the assistant turn verbatim — tool_use blocks must be preserved
    // for the next request to be a valid tool-use exchange.
    messages.push({
      role: "assistant",
      content: resp.content as unknown as Array<Record<string, unknown>>,
    });

    const calls = toolUseBlocks(resp.content);
    if (calls.length === 0) {
      // Model answered in prose with no tool call — nothing more to do.
      return { finalReport: null, turns: turn, trail, stoppedBy: "end_turn" };
    }

    // Terminal tool ends the loop with its structured input.
    const terminal = calls.find((b) => b.name === opts.terminalTool);
    if (terminal) {
      return { finalReport: terminal.input ?? null, turns: turn, trail, stoppedBy: "submit_report" };
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

  return { finalReport: null, turns: opts.maxTurns, trail, stoppedBy: "max_turns" };
}
