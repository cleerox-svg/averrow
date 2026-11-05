/**
 * Per-task Claude gating (AI_CLAUDE_TASKS) + central spend throttle.
 *
 * Pins the callAnthropic gate order -- rules_only -> allowlist -> spend
 * throttle -> API key -> per-agent cap -- and that every refusal is a
 * deliberate skip ('throttled'), never an outage. Drives the REAL
 * lib/anthropic.ts / lib/haiku.ts / lib/ai-throttle.ts /
 * lib/per-agent-budget.ts with only `fetch` stubbed.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  isAiTaskAllowed,
  parseAiClaudeTasks,
  callAnthropic,
  AiDisabledError,
  AiBudgetThrottledError,
  AnthropicError,
} from "../src/lib/anthropic";
import { classifyAnthropicFailure, callHaikuRaw, classifyThreat, isDeliberateAiSkip } from "../src/lib/haiku";
import { runAbuseClassifierBackfill } from "../src/lib/abuse-mailbox-classifier";
import type { Env } from "../src/types";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";

const OK_BODY = {
  id: "msg_test",
  model: "claude-haiku-4-5-20251001",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 10, output_tokens: 5 },
};
const okResponse = () =>
  new Response(JSON.stringify(OK_BODY), { status: 200, headers: { "content-type": "application/json" } });

const CALL = {
  model: "claude-haiku-4-5-20251001",
  system: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
  maxTokens: 16,
};

const realFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => okResponse());
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** DB + KV that fail the test on any access. */
function untouchable() {
  const prepare = vi.fn(() => {
    throw new Error("unexpected D1 access");
  });
  const kvGet = vi.fn(async () => {
    throw new Error("unexpected KV access");
  });
  const kv = { get: kvGet, put: kvGet, delete: kvGet } as unknown as KVNamespace;
  return { db: { prepare } as unknown as D1Database, kv, prepare, kvGet };
}

// ─── 1. Truth table ──────────────────────────────────────────────

describe("parseAiClaudeTasks", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["   ", null],
    [" , ,, ", null],
  ])("%j -> null (no allowlist declared)", (raw, expected) => {
    expect(parseAiClaudeTasks(raw as string | undefined)).toBe(expected);
  });

  it("trims entries and drops empties", () => {
    expect([...(parseAiClaudeTasks(" observer , ,narrator,, ") ?? [])]).toEqual(["observer", "narrator"]);
  });
});

describe("isAiTaskAllowed truth table", () => {
  const cases: Array<[string, { AI_MODE?: string; AI_CLAUDE_TASKS?: string }, string, boolean]> = [
    ["rules_only, no list", { AI_MODE: "rules_only" }, "observer", false],
    ["rules_only beats a list that names the task", { AI_MODE: "rules_only", AI_CLAUDE_TASKS: "observer" }, "observer", false],
    ["rules_only with padding still blocks", { AI_MODE: " rules_only " }, "observer", false],
    ["unset mode + unset list -> allowed", {}, "anything", true],
    ["unset mode + list -> list applies", { AI_CLAUDE_TASKS: "observer" }, "analyst", false],
    ["enabled + unset list -> blocked (fail closed)", { AI_MODE: "enabled" }, "anything", false],
    ["padded enabled + unset list -> blocked (fail closed)", { AI_MODE: " enabled " }, "anything", false],
    ["enabled + empty list -> blocked (fail closed)", { AI_MODE: "enabled", AI_CLAUDE_TASKS: "" }, "anything", false],
    ["enabled + whitespace-only list -> blocked (fail closed)", { AI_MODE: "enabled", AI_CLAUDE_TASKS: "  ,  " }, "anything", false],
    ["enabled + bare comma -> blocked (fail closed)", { AI_MODE: "enabled", AI_CLAUDE_TASKS: "," }, "anything", false],
    ["enabled + '*' -> allowed (explicit allow-all)", { AI_MODE: "enabled", AI_CLAUDE_TASKS: "*" }, "anything", true],
    ["enabled + '*' among ids -> allowed", { AI_MODE: "enabled", AI_CLAUDE_TASKS: "observer, * " }, "anything", true],
    ["rules_only beats '*'", { AI_MODE: "rules_only", AI_CLAUDE_TASKS: "*" }, "anything", false],
    ["listed -> allowed", { AI_MODE: "enabled", AI_CLAUDE_TASKS: "observer,narrator" }, "narrator", true],
    ["not listed -> blocked", { AI_MODE: "enabled", AI_CLAUDE_TASKS: "observer,narrator" }, "analyst", false],
    ["entries are trimmed", { AI_MODE: "enabled", AI_CLAUDE_TASKS: " observer , narrator " }, "narrator", true],
    ["empty entries are ignored, list still restrictive", { AI_MODE: "enabled", AI_CLAUDE_TASKS: ",observer,," }, "narrator", false],
    ["wrong case -> blocked (case-sensitive)", { AI_MODE: "enabled", AI_CLAUDE_TASKS: "observer" }, "Observer", false],
    ["list in upper case does not match lower id", { AI_MODE: "enabled", AI_CLAUDE_TASKS: "OBSERVER" }, "observer", false],
    ["prefix is not a match (exact)", { AI_MODE: "enabled", AI_CLAUDE_TASKS: "observer" }, "observer_x", false],
    ["empty agentId never matches a real list", { AI_MODE: "enabled", AI_CLAUDE_TASKS: "observer" }, "", false],
  ];
  it.each(cases)("%s", (_n, env, agentId, expected) => {
    expect(isAiTaskAllowed(env, agentId)).toBe(expected);
  });
});

// ─── 2. callAnthropic gating ─────────────────────────────────────

describe("callAnthropic gate order", () => {
  it("disallowed task: AiDisabledError(task_not_allowed), NO fetch, NO D1/KV access", async () => {
    const { db, kv, prepare, kvGet } = untouchable();
    const env = { DB: db, CACHE: kv, ANTHROPIC_API_KEY: "k", AI_MODE: "enabled", AI_CLAUDE_TASKS: "observer" } as never;

    const err = await callAnthropic(env, { agentId: "analyst", ...CALL }).catch((e) => e);

    expect(err).toBeInstanceOf(AiDisabledError);
    expect(err).not.toBeInstanceOf(AiBudgetThrottledError);
    expect((err as AiDisabledError).reason).toBe("task_not_allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(kvGet).not.toHaveBeenCalled();
  });

  it("rules_only wins over everything: reason rules_only, no I/O", async () => {
    const { db, kv, prepare, kvGet } = untouchable();
    const env = { DB: db, CACHE: kv, ANTHROPIC_API_KEY: "k", AI_MODE: "rules_only", AI_CLAUDE_TASKS: "observer" } as never;

    const err = await callAnthropic(env, { agentId: "observer", ...CALL }).catch((e) => e);

    expect(err).toBeInstanceOf(AiDisabledError);
    expect((err as AiDisabledError).reason).toBe("rules_only");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(kvGet).not.toHaveBeenCalled();
  });

  it("allowed task proceeds to fetch (throttle not engaged, uncapped agent)", async () => {
    const env = {
      DB: { prepare: vi.fn() } as unknown as D1Database,
      CACHE: fakeKv({ "ai:throttle_reason": "", "agent_budget:legacy-kebab": "" }),
      ANTHROPIC_API_KEY: "k",
      AI_MODE: "enabled",
      AI_CLAUDE_TASKS: "legacy-kebab",
    } as never;

    const res = await callAnthropic(env, { agentId: "legacy-kebab", ...CALL });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.usage.input_tokens).toBe(10);
  });

  it("allowlist unset: any task proceeds (backward compatible)", async () => {
    const env = {
      DB: { prepare: vi.fn() } as unknown as D1Database,
      CACHE: fakeKv({ "ai:throttle_reason": "", "agent_budget:whatever": "" }),
      ANTHROPIC_API_KEY: "k",
    } as never;
    await callAnthropic(env, { agentId: "whatever", ...CALL });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throttle reason present: AiBudgetThrottledError, no fetch, classified 'throttled'", async () => {
    const env = {
      DB: { prepare: vi.fn() } as unknown as D1Database,
      CACHE: fakeKv({ "ai:throttle_reason": "budget hard throttle (96% of $80)" }),
      ANTHROPIC_API_KEY: "k",
      AI_MODE: "enabled",
      AI_CLAUDE_TASKS: "observer",
    } as never;

    const err = await callAnthropic(env, { agentId: "observer", ...CALL }).catch((e) => e);

    expect(err).toBeInstanceOf(AiBudgetThrottledError);
    expect(err).toBeInstanceOf(AiDisabledError);
    expect((err as AiBudgetThrottledError).throttleReason).toBe("budget hard throttle (96% of $80)");
    expect((err as Error).message).toMatch(/^ai_budget_throttled:/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(classifyAnthropicFailure(err)).toBe("throttled");
    expect(isDeliberateAiSkip(classifyAnthropicFailure(err))).toBe(true);
  });

  it("classifier also recognises the message prefix alone (plain AnthropicError)", () => {
    const e = new AnthropicError("ai_budget_throttled: budget hard throttle — AI call skipped", "x");
    expect(classifyAnthropicFailure(e)).toBe("throttled");
  });

  it("allowlist is checked BEFORE the throttle: a disallowed task with a throttle set reads task_not_allowed", async () => {
    const env = {
      DB: { prepare: vi.fn() } as unknown as D1Database,
      CACHE: fakeKv({ "ai:throttle_reason": "budget hard throttle (96% of $80)" }),
      ANTHROPIC_API_KEY: "k",
      AI_MODE: "enabled",
      AI_CLAUDE_TASKS: "observer",
    } as never;
    const err = await callAnthropic(env, { agentId: "analyst", ...CALL }).catch((e) => e);
    expect((err as AiDisabledError).reason).toBe("task_not_allowed");
  });

  it("throttle is checked BEFORE the API key: no key + throttled -> throttled, not api_error", async () => {
    const env = {
      DB: { prepare: vi.fn() } as unknown as D1Database,
      CACHE: fakeKv({ "ai:throttle_reason": "budget emergency throttle (99% of $80)" }),
    } as never;
    const err = await callAnthropic(env, { agentId: "observer", ...CALL }).catch((e) => e);
    expect(err).toBeInstanceOf(AiBudgetThrottledError);
  });

  it("a direct (non-haiku) caller shape is throttled too (callAnthropic itself enforces it)", async () => {
    // Same call shape as narrator / evidence-assembler: callAnthropic with
    // no lib/haiku.ts helper in front.
    const env = {
      DB: { prepare: vi.fn() } as unknown as D1Database,
      CACHE: fakeKv({ "ai:throttle_reason": "budget hard throttle (96% of $80)" }),
      ANTHROPIC_API_KEY: "k",
    } as never;
    await expect(callAnthropic(env, { agentId: "narrator", ...CALL })).rejects.toBeInstanceOf(AiBudgetThrottledError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("without env.DB the throttle is not consulted (fixtures without D1 still work)", async () => {
    const env = { ANTHROPIC_API_KEY: "k", AI_MODE: "enabled", AI_CLAUDE_TASKS: "observer" } as never;
    await callAnthropic(env, { agentId: "observer", ...CALL });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── 3. haiku helpers ────────────────────────────────────────────

describe("lib/haiku.ts helpers with a disallowed agentId", () => {
  const { db, kv, prepare, kvGet } = untouchable();
  const env = { DB: db, CACHE: kv, ANTHROPIC_API_KEY: "k", AI_MODE: "enabled", AI_CLAUDE_TASKS: "observer" } as never;

  it("callHaikuRaw -> failure_kind 'throttled', no fetch, no I/O", async () => {
    const r = await callHaikuRaw(env, { agentId: "analyst", runId: "r" }, "s", "u");
    expect(r).toMatchObject({ success: false, failure_kind: "throttled" });
    expect(r.error).toMatch(/AI_CLAUDE_TASKS/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(kvGet).not.toHaveBeenCalled();
  });

  it("classifyThreat (callJsonSafe) -> failure_kind 'throttled', no fetch, no I/O", async () => {
    const r = await classifyThreat(env, { agentId: "analyst", runId: "r" }, { source_feed: "f", malicious_domain: "evil.example" });
    expect(r).toMatchObject({ success: false, failure_kind: "throttled" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("under rules_only the helper message names AI_MODE", async () => {
    const r = await callHaikuRaw({ ...(env as object), AI_MODE: "rules_only" } as never, { agentId: "observer" }, "s", "u");
    expect(r.failure_kind).toBe("throttled");
    expect(r.error).toMatch(/rules_only/);
  });
});

// ─── 4 / 5. Real per-agent cap + abuse classifier ────────────────

describe.skipIf(!hasSqlite())("per-agent cap + abuse classifier (real gates)", () => {
  let raw: SqliteDb;

  // getDeclaredCap lazily imports the whole agent registry; warm it once.
  beforeAll(async () => {
    const mod = await import("../src/agents/index");
    expect(Object.keys(mod.agentModules).length).toBeGreaterThan(0);
  }, 120_000);

  beforeEach(() => {
    raw = openDerivedDb(["budget_ledger", "budget_config", "agent_budget_rollups", "abuse_inbox_messages"]);
  });

  const addRollup = (agentId: string, tokens: number) =>
    raw
      .prepare(
        `INSERT INTO agent_budget_rollups (agent_id, year_month, total_input_tokens, total_output_tokens, total_cost_usd, call_count)
         VALUES (?, strftime('%Y-%m', 'now'), ?, 0, 1, 1)`,
      )
      .run(agentId, tokens);

  const env = (over: Record<string, unknown> = {}) =>
    ({
      DB: d1FromSqlite(raw, { swallow: (sql: string) => /named_threats|FROM brands/.test(sql) }),
      CACHE: fakeKv({ "ai:throttle_reason": "" }),
      ANTHROPIC_API_KEY: "k",
      AI_MODE: "enabled",
      // Explicit allow-all: with AI_MODE="enabled" an absent list fails closed.
      AI_CLAUDE_TASKS: "*",
      ...over,
    }) as never;

  it("NON_MODULE_AGENT_CAPS id (abuse_mailbox_deep_analyzer) is capped at 500K tokens", async () => {
    addRollup("abuse_mailbox_deep_analyzer", 500_000);

    const err = await callAnthropic(env(), { agentId: "abuse_mailbox_deep_analyzer", ...CALL }).catch((e) => e);

    expect(err).toBeInstanceOf(AnthropicError);
    expect((err as Error).message).toMatch(/^budget_cap_exceeded: agent abuse_mailbox_deep_analyzer over monthly token cap/);
    expect(classifyAnthropicFailure(err)).toBe("budget_cap");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("NON_MODULE_AGENT_CAPS id just under the cap still calls (boundary: cap is exclusive)", async () => {
    addRollup("abuse_mailbox_deep_analyzer", 499_999);
    await callAnthropic(env(), { agentId: "abuse_mailbox_deep_analyzer", ...CALL });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("an unregistered id with a huge rollup is NOT capped (pass-through)", async () => {
    addRollup("not-a-real-agent", 999_999_999);
    await callAnthropic(env(), { agentId: "not-a-real-agent", ...CALL });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  describe("abuse classifier deliberate skip leaves the row pending", () => {
    beforeEach(() => {
      raw
        .prepare(
          `INSERT INTO abuse_inbox_messages
             (id, org_id, original_from, original_subject, original_body_snippet,
              forwarded_by_email, classification, classification_attempts)
           VALUES ('m1', 1, 'x@evil.test', 'Verify your account', 'click here',
                   'reporter@customer.test', 'pending', 2)`,
        )
        .run();
    });
    const row = () =>
      raw
        .prepare(
          `SELECT classification, classification_attempts, classified_by, last_classify_error, determination_sent_at
             FROM abuse_inbox_messages WHERE id = 'm1'`,
        )
        .all()[0] as Record<string, unknown>;
    const untouched = {
      classification: "pending",
      classification_attempts: 2,
      classified_by: null,
      last_classify_error: null,
      determination_sent_at: null,
    };

    it("spend throttle engaged: attempt bump undone, no graduation at the cap, no fetch", async () => {
      const r = await runAbuseClassifierBackfill(
        env({ CACHE: fakeKv({ "ai:throttle_reason": "budget hard throttle (96% of $80)" }) }),
      );
      expect(r.skipped_rules_only).toBe(true);
      expect(r.failed).toBe(0);
      expect(r.by_classification.parse_error).toBe(0);
      expect(r.by_classification.ambiguous).toBe(0);
      expect(row()).toEqual(untouched);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("per-agent cap hit (budget_cap): treated as a deliberate skip, row not consumed", async () => {
      addRollup("abuse_mailbox_classifier", 2_000_000);
      const r = await runAbuseClassifierBackfill(env());
      expect(r.skipped_rules_only).toBe(true);
      expect(r.failed).toBe(0);
      expect(row()).toEqual(untouched);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("task not in AI_CLAUDE_TASKS: pass-level skip, nothing selected or touched", async () => {
      const r = await runAbuseClassifierBackfill(env({ AI_CLAUDE_TASKS: "observer" }));
      expect(r).toMatchObject({ scanned: 0, classified: 0, failed: 0, skipped_rules_only: true });
      expect(row()).toEqual(untouched);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("a real outage (HTTP 400) still counts as a failure -- contrast with the skips above", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("credit balance too low", { status: 400 }));
      const r = await runAbuseClassifierBackfill(env());
      expect(r.skipped_rules_only).toBeUndefined();
      expect(r.failed).toBe(1);
      expect(row().classification_attempts).toBe(3);
    });
  });
});

// ─── 6. wrangler.toml pins ───────────────────────────────────────

describe("wrangler.toml AI_CLAUDE_TASKS", () => {
  const toml = readFileSync(resolve(__dirname, "..", "wrangler.toml"), "utf8");
  const stagingIdx = toml.search(/^\[env\.staging\]/m);
  const prodSection = toml.slice(0, stagingIdx);

  const prodLine = prodSection.split("\n").find((l) => /^AI_CLAUDE_TASKS\s*=/.test(l));
  const prodIds = (prodLine?.match(/"([^"]*)"/)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts") && !p.includes("__tests__")) out.push(p);
    }
    return out;
  }
  const srcFiles = walk(resolve(__dirname, "..", "src")).map((p) => ({ p, text: readFileSync(p, "utf8") }));

  it("prod declares a non-empty allowlist (unset would re-open every bulk caller)", () => {
    expect(prodLine).toBeDefined();
    expect(prodIds.length).toBeGreaterThan(0);
    expect(prodSection).toMatch(/^AI_MODE\s*=\s*"enabled"/m);
  });

  it("excludes evidence_assembler (draft is auto-submitted to abuse desks; no human-review gate)", () => {
    expect(prodIds).not.toContain("evidence_assembler");
  });

  it("does not use the '*' allow-all in prod", () => {
    expect(prodIds).not.toContain("*");
  });

  it("has no duplicates and no padding/case typos", () => {
    expect(new Set(prodIds).size).toBe(prodIds.length);
    for (const id of prodIds) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it.each(prodIds)("%s is a real agentId used at a Claude call site", (id) => {
    const quoted = new RegExp(`(agentId\\s*[:=]\\s*|_ID\\s*=\\s*|AGENT_ID\\s*=\\s*)['"]${id}['"]`);
    const callers = srcFiles.filter(
      ({ text }) => quoted.test(text) && /callAnthropic|callHaiku|generateInsight|classifyThreat|runAgentLoop|callJsonSafe|agent-loop/.test(text),
    );
    expect(callers.map((c) => c.p), `no Claude call site declares agentId "${id}"`).not.toEqual([]);
  });

  it.each(["staging", "dev"])("env.%s stays AI_MODE = rules_only and sets no allowlist override", (name) => {
    const m = toml.match(new RegExp(`^\\[env\\.${name}\\][\\s\\S]*?(?=^\\[env\\.|$(?![\\s\\S]))`, "m"));
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/AI_MODE\s*=\s*"rules_only"/);
    expect(m![0]).not.toMatch(/AI_MODE\s*=\s*"enabled"/);
  });
});

// ─── Observer: event-triggered runs skip AI ──────────────────────

describe("observer event-triggered runs", () => {
  it("source marks triggeredByEvent runs as a deliberate 'throttled' skip and skips the weekly narrative", () => {
    const src = readFileSync(resolve(__dirname, "..", "src/agents/observer.ts"), "utf8");
    expect(src).toMatch(/input\.triggeredByEvent/);
    // No synthetic AI result: event runs simply never call generateInsight.
    expect(src).toMatch(/const insightResult = triggeredByEvent\s*\?\s*null/);
    expect(src).toMatch(/isSunday && isMorning && !triggeredByEvent/);
  });
});
