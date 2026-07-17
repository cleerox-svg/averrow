/**
 * Canonical Anthropic wrapper regression tests.
 *
 * The wrapper at src/lib/anthropic.ts is the single enforcement point
 * for BudgetManager.recordCost. These tests pin three properties that
 * the whole Phase 4 Step 2 refactor depends on:
 *
 * 1. Every successful call writes a budget_ledger row with the right
 *    agentId, runId, model, and token counts. This is the regression
 *    guard — if anyone adds a new AI code path that bypasses the
 *    wrapper, the ledger invariant breaks and this test fails.
 * 2. A failed call (HTTP 500) does NOT write a ledger row. No tokens
 *    consumed means no cost to attribute.
 * 3. Tool use + Sonnet model flows through the wrapper the same way
 *    Haiku + plain text does — a single recordCost call, one row, one
 *    model string matching the response's returned model field.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

import {
  callAnthropic,
  callAnthropicJSON,
  AnthropicError,
} from "../src/lib/anthropic";

// ─── Fake D1 with a recordCost spy ──────────────────────────────

interface LedgerRow {
  agent_id: string;
  run_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

function makeFakeDb() {
  const rows: LedgerRow[] = [];
  const stmt = (sql: string, args: readonly unknown[] = []) => ({
    bind: (...nextArgs: unknown[]) => stmt(sql, nextArgs),
    // Phase 5.1: BudgetManager.recordCost now batches a ledger
    // INSERT + an agent_budget_rollups UPSERT. The fake db captures
    // the ledger row and ignores the rollup statement (the gate's
    // unit tests carry their own rollup-aware fake).
    run: async () => {
      if (/INSERT INTO budget_ledger/i.test(sql)) {
        rows.push({
          agent_id: String(args[1]),
          run_id: args[2] == null ? null : String(args[2]),
          model: String(args[3]),
          input_tokens: Number(args[4]),
          output_tokens: Number(args[5]),
          cost_usd: Number(args[6]),
        });
      }
      return { meta: {} };
    },
    // Phase 5.1's per-agent gate hits agent_budget_rollups. Return
    // null so the gate sees zero current spend → cap > 0 → pass.
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      for (const s of statements) await s.run();
      return statements.map(() => ({ meta: {} }));
    },
  } as unknown as D1Database;
  return { db, rows };
}

function makeEnv(db: D1Database) {
  return {
    ANTHROPIC_API_KEY: "sk-ant-test",
    LRX_API_KEY: undefined,
    CF_ACCOUNT_ID: undefined,
    DB: db,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildTextResponse(text: string, inputTokens: number, outputTokens: number, model = "claude-haiku-4-5-20251001") {
  return {
    id: "msg_test",
    model,
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function buildToolUseResponse(toolName: string, input: unknown, inputTokens: number, outputTokens: number, model = "claude-sonnet-4-5-20250929") {
  return {
    id: "msg_test",
    model,
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: toolName,
        input,
      },
    ],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("callAnthropic — automatic ledger tracking", () => {
  let fetchSpy: Mock;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes exactly one budget_ledger row per successful Haiku call with the right agent/run/model/tokens", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(buildTextResponse("hello world", 1234, 567)),
    );

    const { db, rows } = makeFakeDb();

    const response = await callAnthropic(makeEnv(db), {
      agentId: "sentinel",
      runId: "run-abc-123",
      model: "claude-haiku-4-5-20251001",
      system: "You are a test.",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 64,
    });

    // Caller still gets the raw response, including usage numbers.
    expect(response.usage.input_tokens).toBe(1234);
    expect(response.usage.output_tokens).toBe(567);
    expect(response.content[0]!.type).toBe("text");

    // One and only one ledger row.
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.agent_id).toBe("sentinel");
    expect(row.run_id).toBe("run-abc-123");
    expect(row.model).toBe("claude-haiku-4-5-20251001");
    expect(row.input_tokens).toBe(1234);
    expect(row.output_tokens).toBe(567);

    // Cost math: Haiku 4.5 = $1.00 in / $5.00 out per M tokens.
    // 1234 in  → $0.001234
    // 567  out → $0.002835
    // total    → $0.004069
    expect(row.cost_usd).toBeCloseTo(0.004069, 6);

    // Request body sent to Anthropic matches the options we passed.
    const [, fetchInit] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(fetchInit.body as string);
    expect(sentBody.model).toBe("claude-haiku-4-5-20251001");
    expect(sentBody.max_tokens).toBe(64);
    expect(sentBody.system).toBe("You are a test.");
    expect(sentBody.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("does NOT write a ledger row when the Anthropic call returns HTTP 500", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("upstream exploded", { status: 500 }),
    );

    const { db, rows } = makeFakeDb();

    await expect(
      callAnthropic(makeEnv(db), {
        agentId: "narrator",
        runId: "run-xyz",
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
      }),
    ).rejects.toThrow(AnthropicError);

    expect(rows).toHaveLength(0);
  });

  it("handles Sonnet tool_use — ledger row carries the Sonnet model and Sonnet pricing", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        buildToolUseResponse(
          "report_analysis",
          { summary: "ok" },
          2000,
          800,
          "claude-sonnet-4-5-20250929",
        ),
      ),
    );

    const { db, rows } = makeFakeDb();

    const response = await callAnthropic(makeEnv(db), {
      agentId: "architect",
      runId: "arch-1",
      model: "claude-sonnet-4-5-20250929",
      system: "synthesise",
      messages: [{ role: "user", content: "payload" }],
      maxTokens: 20_480,
      tools: [{ name: "report_analysis", input_schema: { type: "object" } }],
      toolChoice: { type: "tool", name: "report_analysis" },
    });

    expect(response.stop_reason).toBe("tool_use");
    const toolUse = response.content.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse!.input).toEqual({ summary: "ok" });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.agent_id).toBe("architect");
    expect(row.run_id).toBe("arch-1");
    expect(row.model).toBe("claude-sonnet-4-5-20250929");
    expect(row.input_tokens).toBe(2000);
    expect(row.output_tokens).toBe(800);
    // Sonnet 4.5 = $3.00 in / $15.00 out per M tokens.
    // 2000 in  → $0.006
    // 800 out  → $0.012
    // total    → $0.018
    expect(row.cost_usd).toBeCloseTo(0.018, 6);

    // Request body carries tools + tool_choice.
    const [, fetchInit] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(fetchInit.body as string);
    expect(sentBody.tools).toHaveLength(1);
    expect(sentBody.tool_choice).toEqual({
      type: "tool",
      name: "report_analysis",
    });
  });

  it("callAnthropicJSON parses fenced JSON and still writes exactly one ledger row", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        buildTextResponse(
          '```json\n{"verdict":"phishing","confidence":92}\n```',
          500,
          120,
        ),
      ),
    );

    const { db, rows } = makeFakeDb();

    const { parsed } = await callAnthropicJSON<{
      verdict: string;
      confidence: number;
    }>(makeEnv(db), {
      agentId: "cartographer",
      runId: null,
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "classify" }],
      maxTokens: 128,
    });

    expect(parsed.verdict).toBe("phishing");
    expect(parsed.confidence).toBe(92);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("cartographer");
    expect(rows[0]!.run_id).toBeNull();
    expect(rows[0]!.input_tokens).toBe(500);
    expect(rows[0]!.output_tokens).toBe(120);
  });
});
