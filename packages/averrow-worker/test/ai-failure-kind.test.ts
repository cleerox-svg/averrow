/**
 * `failure_kind` — a deliberate skip and an outage must never be confused.
 *
 * Background: the platform ran ~3 months with zero working AI (last
 * budget_ledger row 2026-07-10, cause `Anthropic HTTP 400 — credit balance
 * too low`) and nothing alerted, because every helper in lib/haiku.ts
 * collapsed "we chose not to call" and "the API refused us" into the same
 * `{ success: false, error }` envelope. Callers do
 * `if (!result.success) useHeuristic()`, which is right for a budget
 * throttle and catastrophic for an HTTP 400.
 *
 * `classifyAnthropicFailure` is module-private, so it is driven THROUGH its
 * two public callers (`classifyThreat` → callJsonSafe, and `callHaikuRaw`)
 * against the REAL lib/anthropic.ts + BudgetManager + per-agent budget gate,
 * with only `fetch` stubbed. That is deliberate: the classifier matches on
 * message PREFIXES thrown by anthropic.ts (`budget_cap_exceeded:`,
 * `Anthropic fetch failed:`, ...). A test that hand-built the error would
 * keep passing after someone reworded the throw site; driving the real throw
 * site fails the moment the two drift apart.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { classifyThreat, callHaikuRaw, isDeliberateAiSkip, type HaikuFailureKind } from "../src/lib/haiku";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";

const BUDGET_TABLES = ["budget_ledger", "budget_config", "agent_budget_rollups"];

const THREAT = { source_feed: "otherfeed", malicious_domain: "evil.example" };

/** A well-formed Anthropic 200 whose text block is `text`. */
function okResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      model: "claude-haiku-4-5-20251001",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const CLASSIFICATION_JSON = '{"threat_type":"phishing","confidence":88,"severity":"high"}';

interface Entry {
  /** What the unit under test returns. */
  call: (env: never, agentId?: string) => Promise<{ success: boolean; error?: string; failure_kind?: HaikuFailureKind }>;
}

/** Both public entry points that run `classifyAnthropicFailure`. */
const ENTRY_POINTS: Array<[string, Entry["call"]]> = [
  ["classifyThreat (callJsonSafe)", (env, agentId = "sentinel") => classifyThreat(env, { agentId, runId: "r1" }, THREAT)],
  ["callHaikuRaw", (env, agentId = "sentinel") => callHaikuRaw(env, { agentId, runId: "r1" }, "sys", "user", 16)],
];

describe.skipIf(!hasSqlite())("failure_kind derivation (real anthropic wrapper, stubbed fetch)", () => {
  // The per-agent budget gate (lib/per-agent-budget.ts getDeclaredCap) lazily
  // `import("../agents")`es the whole agent registry (~45 modules; circular, so
  // it cannot be static). Cold, that exceeds the 5s per-test timeout on a
  // loaded machine: the first budget_cap test times out mid-import and later
  // ones observe a half-evaluated module (failure_kind 'api_error' instead of
  // 'budget_cap'). Warm it once with its own budget so per-test is a cache hit.
  beforeAll(async () => {
    const mod = await import("../src/agents/index");
    expect(Object.keys(mod.agentModules).length).toBeGreaterThan(0);
  }, 120_000);

  let raw: SqliteDb;
  let fetchSpy: ReturnType<typeof vi.fn>;

  /** Not-throttled env. KV pre-seeded so the throttle gate does not depend on the DB. */
  const makeEnv = (over: Record<string, unknown> = {}, kv = fakeKv({ "ai:throttle_reason": "" })) =>
    ({
      DB: d1FromSqlite(raw),
      CACHE: kv,
      ANTHROPIC_API_KEY: "sk-ant-test",
      ...over,
    }) as never;

  beforeEach(() => {
    raw = openDerivedDb(BUDGET_TABLES);
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    // The wrapper console.error/warns on every failure path under test.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  describe.each(ENTRY_POINTS)("%s", (_name, call) => {
    // ── Deliberate skips: no request may leave the Worker ─────────────
    it("budget guard's `throttled:` early return -> 'throttled', and NO API call is made", async () => {
      const kv = fakeKv({ "ai:throttle_reason": "budget hard throttle (97% of $21.33)" });
      const r = await call(makeEnv({}, kv));

      expect(r.failure_kind).toBe("throttled");
      expect(r.success).toBe(false);
      expect(r.error).toBe("throttled: budget hard throttle (97% of $21.33)");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("throttle derived from the REAL BudgetManager spend (>= hard_pct of the monthly limit) -> 'throttled'", async () => {
      // No KV shortcut: isAiThrottled -> checkCostGuard -> BudgetManager.getStatus
      // reads budget_config + this month's agent_budget_rollups (the
      // derived schema, not a hand-written one).
      raw.exec(`INSERT INTO budget_config (id, monthly_limit_usd, soft_pct, hard_pct, emergency_pct) VALUES (1, 20, 80, 95, 99)`);
      raw.exec(
        `INSERT INTO agent_budget_rollups (agent_id, year_month, total_input_tokens, total_output_tokens, total_cost_usd, call_count)
         VALUES ('sentinel', strftime('%Y-%m', 'now'), 1, 1, 19.5, 1)`,
      );

      const r = await call(makeEnv({}, fakeKv()));

      expect(r.failure_kind).toBe("throttled");
      expect(r.error).toMatch(/^throttled: budget hard throttle/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("`budget_cap_exceeded:` thrown from lib/anthropic.ts -> 'budget_cap', and NO API call is made", async () => {
      // flight_control is declared exempt (monthlyTokenCap = 0), so the
      // per-agent gate in callAnthropic refuses it with the real throw.
      const r = await call(makeEnv(), "flight_control");

      expect(r.failure_kind).toBe("budget_cap");
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/^budget_cap_exceeded: /);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    // ── Outages: an HTTP status is unambiguous ─────────────────────────
    it.each([
      [400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'],
      [401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
      [429, '{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}'],
      [500, "upstream exploded"],
      [503, "overloaded"],
    ])("HTTP %i -> 'api_error' (the outage class), with `error` still carrying the status", async (status, body) => {
      fetchSpy.mockResolvedValueOnce(new Response(body, { status }));

      const r = await call(makeEnv());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(r.success).toBe(false);
      expect(r.failure_kind).toBe("api_error");
      expect(r.error).toMatch(new RegExp(`^Anthropic HTTP ${status}: `));
      expect(isDeliberateAiSkip(r.failure_kind)).toBe(false);
    });

    it("missing API key -> 'api_error' (a missing key is an outage, not a skip)", async () => {
      const r = await call(makeEnv({ ANTHROPIC_API_KEY: undefined }));

      expect(r.failure_kind).toBe("api_error");
      expect(r.error).toMatch(/No API key configured/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("transport failure (fetch rejects) -> 'network', and it is NOT a deliberate skip", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("connect ECONNRESET"));

      const r = await call(makeEnv());

      expect(r.failure_kind).toBe("network");
      expect(r.error).toBe("Anthropic fetch failed: connect ECONNRESET");
      expect(isDeliberateAiSkip(r.failure_kind)).toBe(false);
    });

    it("2xx with an unparseable envelope -> 'parse_error'", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("<html>gateway</html>", { status: 200 }));

      const r = await call(makeEnv());

      expect(r.failure_kind).toBe("parse_error");
      expect(r.error).toMatch(/^Anthropic response JSON parse failed/);
    });

    // ── THE DEFAULT BUCKET ─────────────────────────────────────────────
    // An unrecognised failure must read as "AI is not working", never as a
    // benign skip. If the default bucket were 'unknown'/skip-like, a novel
    // failure mode would silently suppress the platform_ai_calls_failing
    // alert — i.e. the original defect, reintroduced.
    describe("an unrecognised failure lands in 'api_error' (never an unknown / skip-like bucket)", () => {
      it("a PLAIN Error that is not an AnthropicError", async () => {
        // res.text() sits outside callAnthropic's own try/catch, so this
        // escapes as a bare Error — the shape of a genuinely novel failure.
        fetchSpy.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.reject(new Error("something nobody anticipated")),
        });

        const r = await call(makeEnv());

        expect(r.success).toBe(false);
        expect(r.error).toBe("something nobody anticipated");
        expect(r.failure_kind).toBe("api_error");
        expect(isDeliberateAiSkip(r.failure_kind)).toBe(false);
      });

      it("a non-Error throw (string)", async () => {
        fetchSpy.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.reject("just a string"),
        });

        const r = await call(makeEnv());

        expect(r.error).toBe("just a string");
        expect(r.failure_kind).toBe("api_error");
        expect(isDeliberateAiSkip(r.failure_kind)).toBe(false);
      });

      it("an AnthropicError with NO status and an unrecognised message", async () => {
        // The LRX-proxy-key guard throws a status-less AnthropicError whose
        // text matches none of the known prefixes/markers.
        const r = await call(makeEnv({ ANTHROPIC_API_KEY: "lrx_not_a_real_key" }));

        expect(r.error).toMatch(/LRX proxy key/);
        expect(r.failure_kind).toBe("api_error");
        expect(isDeliberateAiSkip(r.failure_kind)).toBe(false);
      });
    });

    // ── success / error are unchanged on every path ────────────────────
    it("a successful call carries NO failure_kind", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse(CLASSIFICATION_JSON));

      const r = await call(makeEnv());

      expect(r.success).toBe(true);
      expect(r.error).toBeUndefined();
      expect(r.failure_kind).toBeUndefined();
    });
  });

  // ── Entry-point specific: classifyThreat parses JSON, callHaikuRaw does not ──
  describe("callJsonSafe-only parse failures (callAnthropicJSON)", () => {
    const noTextBlock = () =>
      new Response(
        JSON.stringify({ id: "m", model: "claude-haiku-4-5-20251001", content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200 },
      );
    it.each<[string, () => Response, RegExp]>([
      ["no text block", noTextBlock, /no text block/],
      ["no JSON payload", () => okResponse("I could not classify that, sorry."), /no JSON payload/],
      ["malformed JSON payload", () => okResponse("{not: valid json,}"), /JSON parse failed/],
    ])("2xx but %s -> 'parse_error'", async (_label, respond, messageRe) => {
      fetchSpy.mockResolvedValueOnce(respond());

      const r = await classifyThreat(
        { DB: d1FromSqlite(raw), CACHE: fakeKv({ "ai:throttle_reason": "" }), ANTHROPIC_API_KEY: "sk-ant-test" } as never,
        { agentId: "sentinel", runId: "r1" },
        THREAT,
      );

      expect(r.success).toBe(false);
      expect(r.error).toMatch(messageRe);
      expect(r.failure_kind).toBe("parse_error");
      expect(isDeliberateAiSkip(r.failure_kind)).toBe(false);
    });
  });
});

describe("isDeliberateAiSkip — the single predicate every agent counter keys on", () => {
  it.each<[HaikuFailureKind | null | undefined, boolean]>([
    ["throttled", true],
    ["budget_cap", true],
    ["api_error", false],
    ["network", false],
    ["parse_error", false],
    // The default / "we don't know" shapes must read as NOT deliberate, so an
    // unclassified failure is counted as an attempted-and-failed call.
    [undefined, false],
    [null, false],
  ])("%s -> %s", (kind, expected) => {
    expect(isDeliberateAiSkip(kind)).toBe(expected);
  });
});
