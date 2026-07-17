/**
 * ARCHITECT Phase 2 analyzer regression tests.
 *
 * Three tests covering:
 * 1. Happy path: the analyzer parses a tool_use block straight out of
 *    content[i].input without any string manipulation.
 * 2. Truncation: stop_reason === "max_tokens" throws a clear error and
 *    never attempts to read a (missing or partial) tool_use block.
 * 3. Schedule Vacuum fix: a repo feed with schedule=null but a healthy
 *    feed_runtime row (enabled=1, pulls_7d>0, successes_7d>0) must not
 *    be graded red by the feeds analyzer. Verifies both the slice shape
 *    (feed_runtime numbers flow into the model input) and the new
 *    system-prompt rules (schedule=null is not a liveness signal).
 *
 * The orchestrator-level timeout / finally-backstop tests that used to
 * live here were removed when the analyzer execution moved from
 * in-process Promise.allSettled to Cloudflare Queues — the orchestrator
 * no longer awaits analyzer calls so there is no timeout race or
 * finally backstop to test. Queue path tests live in
 * src/agents/architect/analysis/__tests__/.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";

import {
  analyzeAgents,
  analyzeFeeds,
} from "../src/agents/architect/analysis/analyzer";
import type {
  ContextBundle,
  FeedRuntimeRow,
} from "../src/agents/architect/types";
import type {
  AgentsAnalysis,
  FeedsAnalysis,
} from "../src/agents/architect/analysis/types";

// ─── Fixture loader ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(
  __dirname,
  "../../../docs/architect/samples/minimal-bundle.json",
);

function loadMinimalBundle(): ContextBundle {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as ContextBundle;
}

// ─── Canned Anthropic responses ────────────────────────────────────

const CANNED_AGENTS_INPUT: AgentsAnalysis = {
  section: "agents",
  summary:
    "Cartographer and sentinel are healthy. Nexus is broken: 42/42 failures with CPU timeout.",
  scorecard: { green: 2, amber: 0, red: 1 },
  assessments: [
    {
      name: "sentinel",
      severity: "green",
      recommendation: "keep",
      rationale: "336 runs, 0 failures, stable duration.",
      evidence: ["runs_7d=336", "failures_7d=0"],
      concerns: [],
      suggested_actions: [],
    },
    {
      name: "cartographer",
      severity: "green",
      recommendation: "keep",
      rationale: "670/672 success rate over 7d, AI spend in line.",
      evidence: ["successes_7d=670", "failures_7d=2", "ai_cost=$0.42"],
      concerns: [],
      suggested_actions: [],
    },
    {
      name: "nexus",
      severity: "red",
      recommendation: "refactor",
      rationale:
        "42/42 failures with 'Worker exceeded CPU time limit' — ghost rows, sustained CPU exhaustion.",
      evidence: [
        "runs_7d=42",
        "successes_7d=0",
        "last_error='Worker exceeded CPU time limit'",
      ],
      concerns: ["CPU budget exhausted every run"],
      suggested_actions: ["Split nexus into smaller workers"],
    },
  ],
  cross_cutting_concerns: [
    "CPU-heavy agents lack chunked processing",
  ],
};

function buildToolUseResponse(input: unknown) {
  return {
    id: "msg_test",
    model: "claude-haiku-4-5-20251001",
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: "report_agents_analysis",
        input,
      },
    ],
    usage: { input_tokens: 1800, output_tokens: 900 },
  };
}

function buildFeedsToolUseResponse(input: unknown) {
  return {
    id: "msg_test",
    model: "claude-haiku-4-5-20251001",
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: "report_feeds_analysis",
        input,
      },
    ],
    usage: { input_tokens: 2100, output_tokens: 700 },
  };
}

function buildMaxTokensResponse() {
  return {
    id: "msg_test",
    model: "claude-haiku-4-5-20251001",
    stop_reason: "max_tokens",
    content: [
      // A truncated / partial tool_use — important: the analyzer must
      // NOT try to read this. We put garbage here to guarantee that
      // reading it would fail loudly if the stop_reason guard were
      // missing.
      { type: "text", text: "(partial response, truncated)" },
    ],
    usage: { input_tokens: 1800, output_tokens: 8192 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ─── Shared env ────────────────────────────────────────────────────

function makeAnalyzerEnv() {
  return {
    ANTHROPIC_API_KEY: "sk-ant-test",
    LRX_API_KEY: undefined,
    CF_ACCOUNT_ID: undefined,
  } as any;
}

// ─── Test 1: tool_use parse (no string manipulation) ───────────────

describe("analyzer — tool_use happy path", () => {
  let fetchSpy: Mock;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses the tool_use input field directly without string manipulation", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(buildToolUseResponse(CANNED_AGENTS_INPUT)),
    );

    const bundle = loadMinimalBundle();
    const result = await analyzeAgents(bundle, makeAnalyzerEnv());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The body sent must include the tool + tool_choice to force the
    // structured output path.
    const fetchCall = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(fetchCall[1].body as string);
    expect(sentBody.tools).toHaveLength(1);
    expect(sentBody.tools[0].name).toBe("report_agents_analysis");
    expect(sentBody.tool_choice).toEqual({
      type: "tool",
      name: "report_agents_analysis",
    });

    // The returned analysis is the tool_use.input verbatim, validated
    // by the hand-rolled schema guard.
    expect(result.analysis.section).toBe("agents");
    expect(result.analysis.scorecard).toEqual({ green: 2, amber: 0, red: 1 });
    expect(result.analysis.assessments).toHaveLength(3);
    expect(result.analysis.assessments[2]!.severity).toBe("red");
    expect(result.analysis.assessments[2]!.name).toBe("nexus");
    expect(result.input_tokens).toBe(1800);
    expect(result.output_tokens).toBe(900);
  });
});

// ─── Test 2: stop_reason=max_tokens surfaces cleanly ───────────────

describe("analyzer — stop_reason=max_tokens", () => {
  let fetchSpy: Mock;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws an error containing 'max_tokens' and does not read content as tool_use", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(buildMaxTokensResponse()));

    const bundle = loadMinimalBundle();
    await expect(analyzeAgents(bundle, makeAnalyzerEnv())).rejects.toThrow(
      /max_tokens/,
    );
  });
});

// ─── Test 3: Schedule Vacuum regression — schedule:null + healthy runtime → green
//
// Pre-fix behaviour: repo.feeds[].schedule was always null (the
// FeedModule TS interface has no schedule field), and the feeds
// analyzer treated that null as the liveness signal. Result: every
// feed graded red "dormant", even the ones running every 30 minutes.
// See docs/architect/findings/feeds-schedule-investigation.md.
//
// Post-fix contract the test pins:
// 1. The request body the analyzer sends to Haiku must carry the
//    joined runtime fields (pulls_7d, successes_7d, enabled,
//    schedule_cron, last_successful_pull) — not the repo schedule.
// 2. The system prompt must explicitly state that a missing code-level
//    schedule is not a dormancy signal, so a prompt regression flips
//    this test red immediately.
// 3. When Haiku returns green for an enabled feed with pulls_7d > 0
//    and successes_7d > 0, the analyzer passes it through verbatim.
//
// We mock Haiku's response so the test is deterministic — the
// important part is (1) and (2), which prove the runtime signal
// reaches the model and the model is told how to use it.

describe("analyzer — feeds: schedule:null + healthy feed_runtime → green", () => {
  let fetchSpy: Mock;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends feed_runtime numbers to Haiku, tells it schedule:null is not a liveness signal, and grades the feed green", async () => {
    // Base bundle has two repo feeds with schedule:null (phishtank)
    // and a real cron string (abuse-ch-urlhaus). Both are dispatched
    // from feed_configs at runtime — schedule in code is irrelevant.
    const baseBundle = loadMinimalBundle();
    const feedRuntime: FeedRuntimeRow[] = [
      {
        feed_name: "abuse-ch-urlhaus",
        enabled: 1,
        schedule_cron: "*/30 * * * *",
        last_successful_pull: "2026-04-08 23:30:00",
        last_attempted_pull: "2026-04-08 23:30:00",
        last_error: null,
        consecutive_failures: 0,
        pulls_7d: 336,
        successes_7d: 336,
      },
      {
        feed_name: "phishtank",
        enabled: 1,
        schedule_cron: "0 */4 * * *",
        last_successful_pull: "2026-04-08 20:00:00",
        last_attempted_pull: "2026-04-08 20:00:00",
        last_error: null,
        consecutive_failures: 0,
        pulls_7d: 42,
        successes_7d: 42,
      },
    ];
    const bundle: ContextBundle = {
      ...baseBundle,
      bundle_version: 2,
      feed_runtime: feedRuntime,
    };
    // Guard: the repo slice really does have schedule:null for
    // phishtank. If this ever changes upstream the test is no longer
    // exercising the regression — fail loudly.
    const phishtankRepo = bundle.repo.feeds.find(
      (f) => f.name === "phishtank",
    )!;
    expect(phishtankRepo.schedule).toBeNull();

    // Canned Haiku response: both feeds graded green, scorecard
    // matches. The analyzer must pass this through verbatim when
    // it's well-formed.
    const cannedFeedsAnalysis: FeedsAnalysis = {
      section: "feeds",
      summary:
        "All repo feeds are dispatched from feed_configs and running cleanly over the last 7 days.",
      scorecard: { green: 2, amber: 0, red: 0 },
      assessments: [
        {
          name: "abuse-ch-urlhaus",
          severity: "green",
          recommendation: "keep",
          rationale:
            "336/336 successful pulls over 7 days, enabled=1, scheduled every 30 minutes via feed_configs.",
          evidence: [
            "enabled=1",
            "pulls_7d=336",
            "successes_7d=336",
            "schedule_cron=*/30 * * * *",
          ],
          concerns: [],
          suggested_actions: [],
        },
        {
          name: "phishtank",
          severity: "green",
          recommendation: "keep",
          rationale:
            "42/42 successful pulls over 7 days, enabled=1. Repo schedule is null by design — runtime row shows feed is firing.",
          evidence: [
            "enabled=1",
            "pulls_7d=42",
            "successes_7d=42",
            "schedule_cron=0 */4 * * *",
          ],
          concerns: [],
          suggested_actions: [],
        },
      ],
      cross_cutting_concerns: [],
    };

    fetchSpy.mockResolvedValueOnce(
      jsonResponse(buildFeedsToolUseResponse(cannedFeedsAnalysis)),
    );

    const result = await analyzeFeeds(bundle, makeAnalyzerEnv());

    // ─── 1. Request body carries runtime fields, not repo schedule
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const fetchCall = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(fetchCall[1].body as string);
    expect(sentBody.tools).toHaveLength(1);
    expect(sentBody.tools[0].name).toBe("report_feeds_analysis");
    expect(sentBody.tool_choice).toEqual({
      type: "tool",
      name: "report_feeds_analysis",
    });

    // The user message must contain the runtime numbers for both
    // feeds so Haiku can grade on them.
    const userContent = sentBody.messages[0].content as string;
    expect(userContent).toContain("pulls_7d");
    expect(userContent).toContain("successes_7d");
    expect(userContent).toContain("last_successful_pull");
    expect(userContent).toContain('"schedule_cron": "*/30 * * * *"');
    expect(userContent).toContain('"schedule_cron": "0 */4 * * *"');
    expect(userContent).toContain('"has_runtime": true');
    // The repo-level `schedule` field is always null by design — the
    // slice builder drops it entirely so it can't mislead the model.
    expect(userContent).not.toContain('"schedule": null');

    // ─── 2. System prompt explicitly de-weights schedule:null
    const systemPrompt = sentBody.system as string;
    expect(systemPrompt).toMatch(/DO NOT TREAT A MISSING SCHEDULE AS DORMANT/);
    expect(systemPrompt).toMatch(/feed_configs/);
    expect(systemPrompt).toMatch(/pulls_7d/);
    expect(systemPrompt).toMatch(/successes_7d/);
    expect(systemPrompt).toMatch(/consecutive_failures/);

    // ─── 3. Healthy feed comes back green (not red)
    expect(result.analysis.section).toBe("feeds");
    expect(result.analysis.scorecard).toEqual({ green: 2, amber: 0, red: 0 });
    const phishtankAssessment = result.analysis.assessments.find(
      (a) => a.name === "phishtank",
    )!;
    expect(phishtankAssessment.severity).toBe("green");
    expect(phishtankAssessment.severity).not.toBe("red");
  });
});
