/**
 * Campaign Hunter — agent-loop control-flow tests.
 *
 * Covers the core new logic: the multi-turn loop terminates correctly on the
 * terminal tool, threads tool results back, records the trail, and respects
 * the turn cap. The model and tools are injected (scripted), so there is no
 * network or DB. A fuller scored eval against fixtured tool data with a real
 * model is the next step (see docs/AGENTIC_DEEP_SCAN_SPEC.md §7).
 */

import { describe, it, expect } from "vitest";
import { runAgentLoop, type AgentLoopOptions } from "../src/lib/agent-loop";
import type { Env } from "../src/types";
import type { AnthropicResponse, AnthropicContentBlock } from "../src/lib/anthropic";

function resp(content: AnthropicContentBlock[]): AnthropicResponse {
  return {
    content,
    model: "test-model",
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function toolUse(name: string, input: unknown, id = `tu_${name}`): AnthropicContentBlock {
  return { type: "tool_use", id, name, input };
}

function textBlock(text: string): AnthropicContentBlock {
  return { type: "text", text };
}

const baseOpts = (
  invoke: AgentLoopOptions["invoke"],
  overrides: Partial<AgentLoopOptions> = {},
): AgentLoopOptions => ({
  env: {} as Env,
  agentId: "campaign_hunter",
  runId: "run_test",
  model: "test-model",
  system: "system",
  tools: [],
  terminalTool: "submit_report",
  runTool: async () => "tool-result-data",
  initialUserMessage: "go",
  maxTurns: 5,
  invoke,
  ...overrides,
});

describe("runAgentLoop", () => {
  it("terminates on the terminal tool and returns its input", async () => {
    const script: AnthropicResponse[] = [
      resp([toolUse("query_brand_threats", { limit: 10 })]),
      resp([toolUse("submit_report", { verdict: "isolated_threats", confidence: 60 })]),
    ];
    let turn = 0;
    const result = await runAgentLoop(baseOpts(async () => script[turn++]!));

    expect(result.stoppedBy).toBe("submit_report");
    expect(result.turns).toBe(2);
    expect(result.finalReport).toEqual({ verdict: "isolated_threats", confidence: 60 });
    // Only the non-terminal tool call is executed and trailed.
    expect(result.trail).toHaveLength(1);
    expect(result.trail[0]).toMatchObject({ turn: 1, tool: "query_brand_threats", result: "tool-result-data" });
  });

  it("respects the turn cap when the model never submits a report", async () => {
    const result = await runAgentLoop(
      baseOpts(async () => resp([toolUse("query_brand_threats", {})]), { maxTurns: 3 }),
    );

    expect(result.stoppedBy).toBe("max_turns");
    expect(result.turns).toBe(3);
    expect(result.finalReport).toBeNull();
    expect(result.trail).toHaveLength(3);
  });

  it("ends cleanly when the model answers in prose with no tool call", async () => {
    const result = await runAgentLoop(baseOpts(async () => resp([textBlock("no tools here")])));

    expect(result.stoppedBy).toBe("end_turn");
    expect(result.turns).toBe(1);
    expect(result.finalReport).toBeNull();
    expect(result.trail).toHaveLength(0);
  });

  it("wraps each model turn in the injected step (Workflow durability seam)", async () => {
    const script: AnthropicResponse[] = [
      resp([toolUse("query_brand_threats", {})]),
      resp([toolUse("submit_report", { verdict: "active_campaign", confidence: 80 })]),
    ];
    let turn = 0;
    const stepLabels: string[] = [];
    const result = await runAgentLoop(
      baseOpts(async () => script[turn++]!, {
        step: async (label, fn) => {
          stepLabels.push(label);
          return fn();
        },
      }),
    );

    expect(result.stoppedBy).toBe("submit_report");
    // One step per model turn, with stable unique labels (so replay is durable).
    expect(stepLabels).toEqual(["agent-loop-turn-1", "agent-loop-turn-2"]);
  });

  it("captures tool errors into the trail without aborting the loop", async () => {
    const script: AnthropicResponse[] = [
      resp([toolUse("provider_history", { asn: 1 })]),
      resp([toolUse("submit_report", { verdict: "no_significant_threat", confidence: 90 })]),
    ];
    let turn = 0;
    const result = await runAgentLoop(
      baseOpts(async () => script[turn++]!, {
        runTool: async () => {
          throw new Error("boom");
        },
      }),
    );

    expect(result.stoppedBy).toBe("submit_report");
    expect(result.trail[0]!.result).toContain("tool_error: boom");
  });
});
