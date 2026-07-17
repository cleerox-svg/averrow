/**
 * ARCHITECT Phase 3 — synthesiser regression tests.
 *
 * Two tests covering the two terminal paths through
 * synthesizeFromInputs():
 *
 * 1. Happy: fetch mock returns a canned tool_use response with valid
 *    markdown, the call resolves with { report_md, computed_scorecard,
 *    usage } and the scorecard is derived from the fixture assessments.
 * 2. max_tokens: fetch mock returns a response with
 *    stop_reason='max_tokens' — synthesizeFromInputs() throws with a
 *    clear error mentioning max_tokens so the standard agent_runs
 *    error path can write that verbatim to the run row.
 *
 * We stub global fetch so the synthesiser's transport layer is
 * exercised end-to-end except for the network hop. No D1 mocking is
 * needed — the new API takes the bundle and analyses directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type {
  AgentsAnalysis,
  DataLayerAnalysis,
  FeedsAnalysis,
  SectionAnalysis,
} from "../../analysis/types";
import type { ContextBundle } from "../../types";
import {
  synthesizeFromInputs,
  type SynthesizerEnv,
} from "../synthesizer";

// ─── Shared fixtures ───────────────────────────────────────────────

const AGENTS_ANALYSIS: AgentsAnalysis = {
  section: "agents",
  summary: "Agents.",
  scorecard: { green: 0, amber: 0, red: 0 },
  assessments: [
    {
      name: "sentinel",
      severity: "green",
      recommendation: "keep",
      rationale: "Healthy.",
      evidence: ["runs_7d=336"],
      concerns: [],
      suggested_actions: [],
    },
    {
      name: "observer",
      severity: "red",
      recommendation: "kill",
      rationale: "Dead.",
      evidence: ["runs_7d=0"],
      concerns: [],
      suggested_actions: [],
    },
  ],
  cross_cutting_concerns: [],
};

const FEEDS_ANALYSIS: FeedsAnalysis = {
  section: "feeds",
  summary: "Feeds.",
  scorecard: { green: 0, amber: 0, red: 0 },
  assessments: [
    {
      name: "phishtank",
      severity: "green",
      recommendation: "keep",
      rationale: "Pulling.",
      evidence: ["successes_7d=168"],
      concerns: [],
      suggested_actions: [],
    },
  ],
  cross_cutting_concerns: [],
};

const DATA_LAYER_ANALYSIS: DataLayerAnalysis = {
  section: "data_layer",
  summary: "Data layer.",
  scorecard: { green: 0, amber: 0, red: 0 },
  assessments: [
    {
      name: "threats",
      severity: "amber",
      recommendation: "refactor",
      rationale: "Big.",
      evidence: ["rows=113000"],
      concerns: [],
      suggested_actions: [],
      scale_risk: "high",
    },
  ],
  hot_tables: ["threats"],
  scale_bottlenecks: [],
  cross_cutting_concerns: [],
};

function makeBundle(): ContextBundle {
  return {
    bundle_version: 2,
    run_id: "test-run",
    generated_at: "2026-04-09T00:00:00.000Z",
    repo: {
      collected_at: "2026-04-09T00:00:00.000Z",
      agents: [],
      feeds: [],
      crons: [],
      workers: [],
      totals: { agents: 0, feeds: 0, crons: 0, workers: 0 },
    },
    data_layer: {
      collected_at: "2026-04-09T00:00:00.000Z",
      tables: [],
      totals: { table_count: 0, total_rows: 0, total_est_bytes: 0 },
    },
    ops: {
      collected_at: "2026-04-09T00:00:00.000Z",
      window_days: 7,
      agents: [],
      crons: [],
      queues_depth: {},
      ai_gateway: {
        total_cost_usd_7d: 0,
        cache_hit_rate: null,
        model_mix: {},
      },
      telemetry_warnings: [],
    },
    feed_runtime: [],
  };
}

function makeEnv(): SynthesizerEnv {
  return {
    ANTHROPIC_API_KEY: "sk-ant-test",
    LRX_API_KEY: undefined,
    CF_ACCOUNT_ID: undefined,
  } as unknown as SynthesizerEnv;
}

// ─── fetch mock helpers ────────────────────────────────────────────

function mockFetchOnce(response: unknown, status = 200): void {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function toolUseResponse(reportMd: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "tool_test",
        name: "report_synthesis_markdown",
        input: { report_md: reportMd },
      },
    ],
    usage: { input_tokens: 4200, output_tokens: 2100 },
  };
}

function maxTokensResponse() {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    stop_reason: "max_tokens",
    content: [
      {
        type: "text",
        text: "truncated mid-markdown...",
      },
    ],
    usage: { input_tokens: 4200, output_tokens: 20_480 },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("synthesizeFromInputs — happy path", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns { report_md, computed_scorecard, usage } when Sonnet returns a tool_use block", async () => {
    const fakeMarkdown =
      "# ARCHITECT Audit — 2026-04-09\n\n## Executive Summary\n\nAll good.";
    mockFetchOnce(toolUseResponse(fakeMarkdown));

    const analyses: SectionAnalysis[] = [
      AGENTS_ANALYSIS,
      FEEDS_ANALYSIS,
      DATA_LAYER_ANALYSIS,
    ];

    const result = await synthesizeFromInputs(
      "test-run",
      makeBundle(),
      analyses,
      makeEnv(),
    );

    expect(result.report_md).toBe(fakeMarkdown);

    // Scorecard derived from the fixture assessments:
    // - agents: 1 green (sentinel) + 1 red (observer)
    // - feeds: 1 green (phishtank)
    // - data_layer: 1 amber (threats)
    expect(result.computed_scorecard.agents).toEqual({
      green: 1,
      amber: 0,
      red: 1,
      total: 2,
    });
    expect(result.computed_scorecard.feeds).toEqual({
      green: 1,
      amber: 0,
      red: 0,
      total: 1,
    });
    expect(result.computed_scorecard.data_layer).toEqual({
      green: 0,
      amber: 1,
      red: 0,
      total: 1,
    });
    expect(result.computed_scorecard.overall).toEqual({
      green: 2,
      amber: 1,
      red: 1,
      total: 4,
    });
    expect(result.computed_scorecard.kill_count).toBe(1);

    // Usage is populated from the mocked response.
    expect(result.usage.input_tokens).toBe(4200);
    expect(result.usage.output_tokens).toBe(2100);
    expect(result.usage.model).toBe("claude-sonnet-4-5-20250929");
    // 4200 * 3 / 1e6 + 2100 * 15 / 1e6 = 0.0126 + 0.0315 = 0.0441
    expect(result.usage.cost_usd).toBeCloseTo(0.0441, 4);
  });
});

describe("synthesizeFromInputs — max_tokens permanent failure", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws with a max_tokens-tagged error when Sonnet hits the output cap", async () => {
    mockFetchOnce(maxTokensResponse());

    const analyses: SectionAnalysis[] = [
      AGENTS_ANALYSIS,
      FEEDS_ANALYSIS,
      DATA_LAYER_ANALYSIS,
    ];

    await expect(
      synthesizeFromInputs("test-run", makeBundle(), analyses, makeEnv()),
    ).rejects.toThrow(/max_tokens/);
  });
});
