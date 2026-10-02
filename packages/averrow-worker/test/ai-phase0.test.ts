/**
 * AI strategy Phase 0 (docs/AI_STRATEGY_2026-10.md §2/§7) — Batch A.
 *
 *   0a. analyst's first-call diagnostic must not persist any slice of the
 *       Anthropic API key (it used to write `key_prefix`).
 *   0b. estimateCost never throws on an unknown model (fallback = the most
 *       expensive known tier), prefix-matches dated IDs, and recordCost /
 *       callAnthropic therefore always write the ledger row.
 *   (0c, the outage email escalation, lives in ai-phase0-escalation.test.ts
 *    because it module-mocks lib/notifications.)
 *   1a. AI_MODE=rules_only: zero network requests, zero D1 reads from the
 *       wrapper, and every helper reports failure_kind 'throttled' so
 *       recordAiCall counts a SKIP (not an attempt) and Flight Control's
 *       outage alert cannot fire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  estimateCost,
  estimateCostDetailed,
  resolveRateKey,
  BudgetManager,
  COST_PER_MILLION,
  FALLBACK_COST_PER_MILLION,
} from "../src/lib/budgetManager";
import {
  callAnthropic,
  callAnthropicJSON,
  callAnthropicText,
  AiDisabledError,
  AnthropicError,
  isAiRulesOnly,
} from "../src/lib/anthropic";
import {
  callHaikuRaw,
  classifyThreat,
  classifyAnthropicFailure,
  isDeliberateAiSkip,
  newAiCallCounters,
  recordAiCall,
} from "../src/lib/haiku";
import { executeAgent } from "../src/lib/agentRunner";
import { analystAgent } from "../src/agents/analyst";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { ANALYST_TABLES, brandMatchJson, routedFetch, seedThreats, distinct } from "./ai-fixtures";

// ─── Shared fakes ────────────────────────────────────────────────

interface LedgerRow { model: string; input_tokens: number; output_tokens: number; cost_usd: number }

/** Fake D1 that captures budget_ledger inserts and counts every prepare(). */
function makeLedgerDb() {
  const rows: LedgerRow[] = [];
  let prepares = 0;
  const stmt = (sql: string, args: readonly unknown[] = []) => ({
    bind: (...next: unknown[]) => stmt(sql, next),
    run: async () => {
      if (/INSERT INTO budget_ledger/i.test(sql)) {
        rows.push({
          model: String(args[3]),
          input_tokens: Number(args[4]),
          output_tokens: Number(args[5]),
          cost_usd: Number(args[6]),
        });
      }
      return { meta: {} };
    },
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  const db = {
    prepare: (sql: string) => { prepares++; return stmt(sql); },
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      for (const s of statements) await s.run();
      return statements.map(() => ({ meta: {} }));
    },
  } as unknown as D1Database;
  return { db, rows, prepares: () => prepares };
}

function okResponse(model: string, text = "ok"): Response {
  return new Response(JSON.stringify({
    id: "msg_1", model, stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════
// 0b. estimateCost
// ═════════════════════════════════════════════════════════════════

describe("0b. estimateCost never throws", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });

  it("prices an unknown model at the most expensive known tier and flags rateKnown=false", () => {
    const sonnet = COST_PER_MILLION["claude-sonnet-4-5-20250929"]!;
    expect(FALLBACK_COST_PER_MILLION).toEqual(sonnet);
    expect(() => estimateCost("claude-mystery-9", 1_000_000, 1_000_000)).not.toThrow();
    const d = estimateCostDetailed("claude-mystery-9", 1_000_000, 1_000_000);
    expect(d).toEqual({ cost: sonnet.input + sonnet.output, rateKnown: false });
  });

  it("warns once per unknown model, not once per call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    estimateCost("claude-warn-once-x", 1, 1);
    estimateCost("claude-warn-once-x", 1, 1);
    estimateCost("claude-warn-once-x", 1, 1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("prefix-matches dated / aliased model IDs to a known rate", () => {
    // Exact dated ID.
    expect(estimateCostDetailed("claude-haiku-4-5-20251001", 1_000_000, 0)).toEqual({ cost: 1, rateKnown: true });
    // A NEW date suffix on a known family resolves to that family, not Sonnet.
    expect(estimateCostDetailed("claude-haiku-4-5-20260315", 1_000_000, 1_000_000)).toEqual({ cost: 6, rateKnown: true });
    // Undated alias of a dated key.
    expect(estimateCostDetailed("claude-haiku-4-5", 0, 1_000_000)).toEqual({ cost: 5, rateKnown: true });
    // Dated ID of an undated (alias) key.
    expect(estimateCostDetailed("claude-sonnet-4-6-20260101", 1_000_000, 0)).toEqual({ cost: 3, rateKnown: true });
    // Legacy family keeps its own (cheaper) rate rather than Sonnet's.
    expect(estimateCostDetailed("claude-3-haiku", 1_000_000, 0)).toEqual({ cost: 0.25, rateKnown: true });
  });

  it("resolveRateKey picks the LONGEST matching key, measured on the form that matched", () => {
    // `claude-sonnet-4-6-*` also prefix-matches `claude-sonnet-4` (the alias
    // of `claude-sonnet-4-20250514`); the longer `claude-sonnet-4-6` must win.
    expect(resolveRateKey("claude-sonnet-4-6-20260101")).toBe("claude-sonnet-4-6");
    expect(resolveRateKey("claude-sonnet-4-6-preview")).toBe("claude-sonnet-4-6");
    expect(resolveRateKey("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    // ...while a genuinely sonnet-4 ID still resolves to the sonnet-4 key.
    expect(resolveRateKey("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
    expect(resolveRateKey("claude-sonnet-4")).toBe("claude-sonnet-4-20250514");
    expect(resolveRateKey("claude-sonnet-4-20260101")).toBe("claude-sonnet-4-20250514");
    // sonnet-4-5 vs sonnet-4: the 4-5 family wins on any suffix.
    expect(resolveRateKey("claude-sonnet-4-5-20260101")).toBe("claude-sonnet-4-5-20250929");
    expect(resolveRateKey("claude-sonnet-4-5-latest")).toBe("claude-sonnet-4-5-20250929");
    // Haiku families stay distinct.
    expect(resolveRateKey("claude-haiku-4-5")).toBe("claude-haiku-4-5-20251001");
    expect(resolveRateKey("claude-3-5-haiku-20991231")).toBe("claude-3-5-haiku-20241022");
    expect(resolveRateKey("claude-3-haiku-20991231")).toBe("claude-3-haiku-20240307");
    // No `-` boundary → no match (claude-sonnet-40 is not claude-sonnet-4).
    expect(resolveRateKey("claude-sonnet-40")).toBeNull();
    expect(resolveRateKey("gpt-4o")).toBeNull();
  });

  it("recordCost writes the ledger row for an unknown model", async () => {
    const { db, rows } = makeLedgerDb();
    const cost = await new BudgetManager(db).recordCost("analyst", null, "claude-unknown-x", 1_000_000, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "claude-unknown-x", input_tokens: 1_000_000, cost_usd: cost });
    expect(cost).toBe(FALLBACK_COST_PER_MILLION.input);
  });

  it("callAnthropic writes the ledger row when the API answers with a model ID missing from the table", async () => {
    const { db, rows } = makeLedgerDb();
    globalThis.fetch = vi.fn(async () => okResponse("claude-haiku-4-5-20991231")) as unknown as typeof fetch;
    await callAnthropic(
      { ANTHROPIC_API_KEY: "sk-ant-test", DB: db },
      { agentId: "test_agent", model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hi" }], maxTokens: 8 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe("claude-haiku-4-5-20991231");
    expect(rows[0]!.cost_usd).toBe(6); // haiku rate via prefix match, 1M in + 1M out
  });
});

// ═════════════════════════════════════════════════════════════════
// 1a. AI_MODE=rules_only
// ═════════════════════════════════════════════════════════════════

describe("1a. AI_MODE=rules_only — zero requests, deliberate skip", () => {
  const opts = { agentId: "test_agent", model: "claude-haiku-4-5-20251001", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 8 };

  it("isAiRulesOnly only trips on the literal 'rules_only' (unset/enabled/other = AI on)", () => {
    expect(isAiRulesOnly({})).toBe(false);
    expect(isAiRulesOnly({ AI_MODE: "enabled" })).toBe(false);
    expect(isAiRulesOnly({ AI_MODE: "" })).toBe(false);
    expect(isAiRulesOnly({ AI_MODE: "rules_only" })).toBe(true);
  });

  it("callAnthropic + JSON/text helpers throw AiDisabledError with no fetch and no D1 access", async () => {
    const fetchSpy = vi.fn(async () => okResponse("claude-haiku-4-5-20251001"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { db, rows, prepares } = makeLedgerDb();
    const env = { ANTHROPIC_API_KEY: "sk-ant-test", DB: db, AI_MODE: "rules_only" };

    await expect(callAnthropic(env, opts)).rejects.toBeInstanceOf(AiDisabledError);
    await expect(callAnthropicJSON(env, opts)).rejects.toBeInstanceOf(AiDisabledError);
    await expect(callAnthropicText(env, opts)).rejects.toBeInstanceOf(AnthropicError); // subclass

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prepares()).toBe(0); // no per-agent budget pre-flight read
    expect(rows).toHaveLength(0);
  });

  it("a direct callAnthropic caller's error classifies as 'throttled' (a deliberate skip)", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const err = await callAnthropic({ ANTHROPIC_API_KEY: "sk-ant-test", DB: makeLedgerDb().db, AI_MODE: "rules_only" }, opts)
      .catch((e: unknown) => e);
    expect(classifyAnthropicFailure(err)).toBe("throttled");
    expect(isDeliberateAiSkip(classifyAnthropicFailure(err))).toBe(true);
  });

  it("haiku helpers return failure_kind 'throttled' without fetch, KV or D1; recordAiCall counts a skip", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const kvGet = vi.fn();
    const { db, prepares } = makeLedgerDb();
    const env = { AI_MODE: "rules_only", ANTHROPIC_API_KEY: "sk-ant-test", DB: db, CACHE: { get: kvGet, put: vi.fn() } } as never;

    const classified = await classifyThreat(env, { agentId: "sentinel" }, { source_feed: "x", malicious_domain: "a.test" });
    const raw = await callHaikuRaw(env, { agentId: "sentinel" }, "sys", "msg");

    for (const r of [classified, raw]) {
      expect(r.success).toBe(false);
      expect(r.failure_kind).toBe("throttled");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(kvGet).not.toHaveBeenCalled();
    expect(prepares()).toBe(0);

    const c = newAiCallCounters();
    recordAiCall(c, classified, false);
    recordAiCall(c, raw, false);
    expect(c).toMatchObject({ aiCallsAttempted: 0, aiCallsSucceeded: 0, aiCallsSkipped: 2, aiFirstError: null });
  });

  it("unset AI_MODE behaves exactly as before: the request goes out", async () => {
    const fetchSpy = vi.fn(async () => okResponse("claude-haiku-4-5-20251001"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await callAnthropic({ ANTHROPIC_API_KEY: "sk-ant-test", DB: makeLedgerDb().db }, opts);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════
// 0a + 1a end to end through analyst (real SQLite harness)
// ═════════════════════════════════════════════════════════════════

const ANALYST_SRC = readFileSync(fileURLToPath(new URL("../src/agents/analyst.ts", import.meta.url)), "utf8");

describe("0a. analyst diagnostic carries no API-key material (source)", () => {
  it("no key_prefix and no slice of the key anywhere in analyst.ts", () => {
    expect(ANALYST_SRC).not.toMatch(/key_prefix/);
    expect(ANALYST_SRC).not.toMatch(/apiKey\s*\.\s*(slice|substring|substr)\(/);
  });
});

describe.skipIf(!hasSqlite())("analyst end to end — key leak + rules-only (real SQLite)", () => {
  let raw: SqliteDb;
  const KEY = "sk-ant-SECRETPREFIX-0123456789";

  beforeEach(() => {
    raw = openDerivedDb(ANALYST_TABLES);
    raw.exec(`INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('analyst', 'approved', datetime('now'))`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  async function run(aiMode?: string) {
    const env = {
      DB: d1FromSqlite(raw),
      CACHE: fakeKv({ "ai:throttle_reason": "" }),
      ANTHROPIC_API_KEY: KEY,
      ...(aiMode ? { AI_MODE: aiMode } : {}),
    } as never;
    const out = await executeAgent(env, analystAgent);
    expect(out.runId).not.toBe("");
    const rows = raw
      .prepare(`SELECT summary, details FROM agent_outputs WHERE agent_id = 'analyst' AND type = 'diagnostic'`)
      .all() as Array<{ summary: string; details: string }>;
    const probe = rows.find((r) => "haiku_success" in (JSON.parse(r.details) as object));
    const summary = rows.find((r) => "aiCallsAttempted" in (JSON.parse(r.details) as object));
    return { out, rows, probe, summary };
  }

  it("the first-call probe has key_source/key_set but no key_prefix, and no output row contains the key", async () => {
    seedThreats(raw, distinct(2));
    const net = routedFetch({ anthropic: () => new Response(JSON.stringify({
      id: "m", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn",
      content: [{ type: "text", text: brandMatchJson(90) }], usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }) });
    globalThis.fetch = net.fn;

    const { rows, probe } = await run();
    expect(probe).toBeDefined();
    const details = JSON.parse(probe!.details) as Record<string, unknown>;
    expect(details).not.toHaveProperty("key_prefix");
    expect(details.key_source).toBe("ANTHROPIC_API_KEY");
    expect(details.anthropic_key_set).toBe(true);
    expect(probe!.summary).not.toMatch(/key_prefix/);
    for (const r of rows) {
      expect(r.summary).not.toContain("sk-ant");
      expect(r.details).not.toContain("sk-ant");
    }
  });

  it("AI_MODE=rules_only: zero Anthropic requests, every call SKIPPED, run not degraded", async () => {
    seedThreats(raw, distinct(3));
    const net = routedFetch(); // any Anthropic call would throw
    globalThis.fetch = net.fn;

    const { out, summary, probe } = await run("rules_only");
    expect(net.anthropicCalls).toHaveLength(0);
    expect(net.unrouted).toEqual([]);
    const d = JSON.parse(summary!.details) as Record<string, unknown>;
    expect(d.aiCallsAttempted).toBe(0);
    expect(d.aiCallsSucceeded).toBe(0);
    expect(d.aiCallsSkipped).toBe(3);
    expect(out.result?.degraded).toBeUndefined();
    expect((JSON.parse(probe!.details) as Record<string, unknown>).haiku_failure_kind).toBe("throttled");
  });
});
