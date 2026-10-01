/**
 * Strictly-API AI counters + honest run status — ANALYST, driven end to end
 * through `executeAgent` against a REAL SQLite instance whose schema is
 * derived from migrations/, with only `fetch` stubbed.
 *
 * Sentinel and cartographer are covered in ai-outage-counters.test.ts and
 * the cartographer lane; this is the third instrumented agent. Analyst was
 * left out originally because its tail phases (phase 6, numbered-variant
 * scan) make live DNS-over-HTTPS `fetch` calls that collide with a stub
 * written only for Anthropic. The stub here (`routedFetch`) discriminates on
 * the request hostname and serves both; the DoH describe block at the bottom
 * proves they coexist and that DoH traffic never reaches the AI counters.
 *
 * What each block pins (the traps that would silently restore the original
 * "three months of dead AI read as healthy" defect):
 *
 *   1. attempted / succeeded / skipped on the real paths — usable answer,
 *      HTTP 400 outage, throttle / budget cap.
 *   2. The keyword pre-match makes NO call. A run in which every threat
 *      pre-matches must read attempted === 0 and must not be degraded.
 *   3. A confidence < 70 answer `continue`s past the legacy success counter,
 *      but the call was billed and answered: it is a SUCCEEDED call. If it
 *      counted as a failure, a run of legitimately-uncertain answers would
 *      read as an outage.
 *   4. A wholly-failed run finalizes 'partial' with completed_at stamped;
 *      the first-failure fields carry the FIRST failure only.
 *   5. The summary row's severity rises off 'info' exactly when
 *      attempted > 0 && succeeded === 0.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executeAgent } from "../src/lib/agentRunner";
import { analystAgent } from "../src/agents/analyst";
import { computeIsStalled, isOrphanedRun } from "../src/agents/flightControl";
import {
  hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, sqlContaining,
  type SqliteDb, type StatementLogEntry,
} from "./sqlite-d1-harness";
import {
  ANALYST_TABLES, CREDIT_BALANCE_400, brandMatchJson, seedKeywordBrand, keywordMatched,
  routedFetch, seedThreats, distinct, type RoutedFetch,
} from "./ai-fixtures";

const ANALYST_SRC = readFileSync(fileURLToPath(new URL("../src/agents/analyst.ts", import.meta.url)), "utf8");

// The statements the assertions below rely on, pulled from the source so a
// reworded query changes what is tested instead of silently dropping out of
// coverage (and so a column that does not exist fails here, not in prod).
const CANDIDATE_SQL = sqlContaining(ANALYST_SRC, ["FROM threats", "WHERE target_brand_id IS NULL AND malicious_domain IS NOT NULL", "LIMIT 30"]);
const PROBE_SQL = sqlContaining(ANALYST_SRC, ["INSERT INTO agent_outputs", "'analyst', 'diagnostic'"]);
const KEYWORD_UPDATE_SQL = sqlContaining(ANALYST_SRC, ["UPDATE threats SET target_brand_id = ?, brand_match_method = 'keyword'"]);

type AnthropicHandler = NonNullable<NonNullable<Parameters<typeof routedFetch>[0]>["anthropic"]>;
const api400 = () => new Response(CREDIT_BALANCE_400, { status: 400 });

interface Run {
  runId: string;
  status: string;
  result: Awaited<ReturnType<typeof executeAgent>>["result"];
  runRow: { status: string; completed_at: string | null; error_message: string | null };
  /** `details` of the summary diagnostic (the one carrying the strictly-API counters). */
  details: Record<string, unknown>;
  summary: { summary: string; severity: string | null };
  /** The first-call probe row analyst writes directly (hardcoded 'info'). */
  probe: { summary: string; severity: string | null; details: Record<string, unknown> } | undefined;
  log: StatementLogEntry[];
}

describe.skipIf(!hasSqlite())("analyst — strictly-API counters and run status (real SQLite, routed fetch stub)", () => {
  let raw: SqliteDb;
  let net: RoutedFetch;

  const useFetch = (opts: Parameters<typeof routedFetch>[0] = {}): RoutedFetch => {
    net = routedFetch(opts);
    globalThis.fetch = net.fn;
    return net;
  };

  beforeEach(() => {
    raw = openDerivedDb(ANALYST_TABLES);
    raw.exec(`INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('analyst', 'approved', datetime('now'))`);
    useFetch(); // default: any Anthropic call throws, DoH answers NXDOMAIN
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    // Any URL that matched no route is an unexpected egress.
    expect(net.unrouted, "analyst called a URL the stub has no route for").toEqual([]);
    vi.restoreAllMocks();
  });

  async function runAnalyst(throttleReason = ""): Promise<Run> {
    const log: StatementLogEntry[] = [];
    const env = {
      DB: d1FromSqlite(raw, { log }),
      CACHE: fakeKv({ "ai:throttle_reason": throttleReason }),
      ANTHROPIC_API_KEY: "sk-ant-test",
    } as never;
    const out = await executeAgent(env, analystAgent);
    expect(out.runId, "executeAgent refused to run (circuit/approval gate)").not.toBe("");

    // Precondition for every test: the candidate select ran and did not
    // error. Without it a broken select would look like "0 threats, healthy".
    const candidateRuns = log.filter((e) => e.sql === CANDIDATE_SQL);
    expect(candidateRuns, "analyst's candidate SELECT did not run exactly once").toHaveLength(1);
    expect(candidateRuns[0]!.error).toBeUndefined();

    const runRow = raw.prepare(`SELECT status, completed_at, error_message FROM agent_runs WHERE id = ?`).all(out.runId)[0] as Run["runRow"];
    const rows = raw
      .prepare(`SELECT summary, severity, details FROM agent_outputs WHERE agent_id = 'analyst' AND type = 'diagnostic'`)
      .all() as Array<{ summary: string; severity: string | null; details: string }>;
    const summaryRow = rows.find((r) => "aiCallsAttempted" in (JSON.parse(r.details) as object));
    expect(summaryRow, "no analyst summary output carrying aiCallsAttempted was persisted").toBeDefined();
    const probeRow = rows.find((r) => "haiku_success" in (JSON.parse(r.details) as object));
    return {
      runId: out.runId,
      status: out.status,
      result: out.result,
      runRow,
      details: JSON.parse(summaryRow!.details) as Record<string, unknown>,
      summary: { summary: summaryRow!.summary, severity: summaryRow!.severity },
      probe: probeRow && { summary: probeRow.summary, severity: probeRow.severity, details: JSON.parse(probeRow.details) as Record<string, unknown> },
      log,
    };
  }

  const counters = (run: Run) => ({
    attempted: run.details.aiCallsAttempted as number,
    succeeded: run.details.aiCallsSucceeded as number,
    skipped: run.details.aiCallsSkipped as number,
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. attempted / succeeded / skipped on the real paths
  // ═══════════════════════════════════════════════════════════════════
  describe("1. the three real paths", () => {
    it("a usable classification: every call is attempted AND succeeded, nothing skipped, run is healthy", async () => {
      seedThreats(raw, distinct(3));
      useFetch({ anthropic: () => new Response(JSON.stringify({
        id: "m", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn",
        content: [{ type: "text", text: brandMatchJson(90) }], usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200 }) });

      const run = await runAnalyst();

      expect(net.anthropicCalls).toHaveLength(3); // one inferBrand call per threat, no sharing
      expect(counters(run)).toEqual({ attempted: 3, succeeded: 3, skipped: 0 });
      expect(run.details.aiFirstError).toBeNull();
      expect(run.details.aiFirstFailureKind).toBeNull();
      // Legacy counters agree here (this is the one shape where they do).
      expect(run.details.haikuSuccesses).toBe(3);
      expect(run.details.haikuFailures).toBe(0);
      expect(run.result?.degraded).toBeUndefined();
      expect(run.status).toBe("success");
      // And it really did the work: all three threats are linked to a brand.
      const linked = raw.prepare(`SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IS NOT NULL`).all()[0] as { n: number };
      expect(linked.n).toBe(3);
    });

    it("a wholly-failed classification (HTTP 400, the real outage shape): attempted N, succeeded 0, skipped 0", async () => {
      seedThreats(raw, distinct(3));
      useFetch({ anthropic: api400 });

      const run = await runAnalyst();

      expect(net.anthropicCalls).toHaveLength(3);
      expect(counters(run)).toEqual({ attempted: 3, succeeded: 0, skipped: 0 });
      expect(run.details.aiFirstFailureKind).toBe("api_error");
      expect(run.details.aiFirstError).toMatch(/credit balance/i);
      expect(run.details.haikuFailures).toBe(3);
      expect(run.details.haikuSuccesses).toBe(0);
      // No brand was linked: the failed calls produced nothing.
      const linked = raw.prepare(`SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IS NOT NULL`).all()[0] as { n: number };
      expect(linked.n).toBe(0);
    });

    it("a throttled run: attempted === 0, skipped incremented per threat, no request leaves, nothing degraded", async () => {
      seedThreats(raw, distinct(3));

      const run = await runAnalyst("budget hard throttle (97% of $21.33)");

      expect(net.anthropicCalls).toHaveLength(0);
      expect(counters(run)).toEqual({ attempted: 0, succeeded: 0, skipped: 3 });
      // The legacy counter sees 3 failures — exactly why it cannot be the signal.
      expect(run.details.haikuFailures).toBe(3);
      expect(run.details.aiFirstError).toBeNull();
      expect(run.details.aiFirstFailureKind).toBeNull();
      expect(run.probe!.details.haiku_failure_kind).toBe("throttled");
      expect(run.result?.degraded).toBeUndefined();
      expect(run.summary.severity).toBe("info");
      expect(run.status).toBe("success");
    });

    it("the per-agent monthly token cap (budget_cap) is also SKIPPED, never attempted", async () => {
      const { agentModules } = await import("../src/agents");
      const cap = agentModules.analyst!.budget.monthlyTokenCap;
      raw.prepare(
        `INSERT INTO agent_budget_rollups (agent_id, year_month, total_input_tokens, total_output_tokens, total_cost_usd, call_count)
         VALUES ('analyst', strftime('%Y-%m', 'now'), ?, 0, 1, 1)`,
      ).run(cap + 1);
      seedThreats(raw, distinct(2));

      const run = await runAnalyst();

      expect(net.anthropicCalls).toHaveLength(0);
      expect(counters(run)).toEqual({ attempted: 0, succeeded: 0, skipped: 2 });
      expect(run.result?.degraded).toBeUndefined();
      expect(run.status).toBe("success");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. The keyword pre-match skip
  // ═══════════════════════════════════════════════════════════════════
  describe("2. every threat pre-matches on a brand keyword (NO API call is made)", () => {
    beforeEach(() => {
      seedKeywordBrand(raw);
      seedThreats(raw, keywordMatched(4));
    });

    it("attempted === 0 (and succeeded/skipped 0): the pre-match is not an AI call and must not be counted as one", async () => {
      const run = await runAnalyst();

      // Precondition that makes this the trap: real work happened — all four
      // were matched and written — yet not one request left the Worker.
      expect(net.anthropicCalls).toHaveLength(0);
      expect(run.details.keywordPreMatched).toBe(4);
      expect(run.details.matched).toBe(4);
      const kw = run.log.filter((e) => e.sql === KEYWORD_UPDATE_SQL);
      expect(kw, "keyword UPDATE did not run for every pre-matched threat").toHaveLength(4);
      expect(kw.every((e) => e.error === undefined)).toBe(true);
      const linked = raw.prepare(`SELECT COUNT(*) AS n FROM threats WHERE target_brand_id = 'brand_acmebank' AND brand_match_method = 'keyword'`).all()[0] as { n: number };
      expect(linked.n).toBe(4);

      expect(counters(run)).toEqual({ attempted: 0, succeeded: 0, skipped: 0 });
    });

    it("does NOT produce a degraded run: alert predicate false, severity info, status 'success', completed_at stamped", async () => {
      const run = await runAnalyst();

      const { attempted, succeeded } = counters(run);
      expect(attempted > 0 && succeeded === 0).toBe(false);
      expect(run.result?.degraded).toBeUndefined();
      expect(run.summary.severity).toBe("info");
      expect(run.summary.summary).not.toMatch(/AI CALLS ALL FAILING/);
      expect(run.status).toBe("success");
      expect(run.runRow.status).toBe("success");
      expect(run.runRow.completed_at).not.toBeNull();
    });

    it("pre-matched threats are not counted alongside real calls: 4 pre-matched + 2 model-bound failing -> attempted 2, not 6", async () => {
      seedThreats(raw, [{ id: "m0", domain: "site0-zq.net", feed: "otherfeed", type: "phishing" }, { id: "m1", domain: "site1-zq.net", feed: "otherfeed", type: "phishing" }]);
      useFetch({ anthropic: api400 });

      const run = await runAnalyst();

      expect(net.anthropicCalls).toHaveLength(2);
      expect(run.details.keywordPreMatched).toBe(4);
      expect(counters(run)).toEqual({ attempted: 2, succeeded: 0, skipped: 0 });
      // The two failing calls ARE all the AI the run attempted, so it is degraded
      // even though four threats were matched by rules — the rules are the fallback.
      expect(run.status).toBe("partial");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. The low-confidence trap
  // ═══════════════════════════════════════════════════════════════════
  describe("3. a confidence < 70 answer", () => {
    const lowConfidenceAnswer = () =>
      new Response(JSON.stringify({
        id: "m", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn",
        content: [{ type: "text", text: brandMatchJson(40) }], usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200 });

    it("is a SUCCEEDED call (billed, ledger row written), not a failure: attempted === succeeded, run is healthy", async () => {
      seedThreats(raw, distinct(3));
      useFetch({ anthropic: lowConfidenceAnswer });

      const run = await runAnalyst();

      expect(net.anthropicCalls).toHaveLength(3);
      // The behaviour that makes this a trap: the legacy counters see NEITHER
      // a success nor a failure for these (they `continue` at the gate)...
      expect(run.details.lowConfidence).toBe(3);
      expect(run.details.haikuSuccesses).toBe(0);
      expect(run.details.haikuFailures).toBe(0);
      expect(run.details.matched).toBe(0);
      // ...but the strictly-API counters record the truth: three answered calls.
      expect(counters(run)).toEqual({ attempted: 3, succeeded: 3, skipped: 0 });
      expect(run.details.aiFirstError).toBeNull();
      // The ledger independently agrees the calls were made and billed
      // (this is leg 1 of the Flight Control gate).
      const ledger = raw.prepare(`SELECT COUNT(*) AS n FROM budget_ledger WHERE agent_id = 'analyst'`).all()[0] as { n: number };
      expect(ledger.n).toBe(3);

      // A run of legitimately-uncertain answers must NOT read as an outage.
      expect(run.result?.degraded).toBeUndefined();
      expect(run.summary.severity).toBe("info");
      expect(run.summary.summary).not.toMatch(/AI CALLS ALL FAILING/);
      expect(run.status).toBe("success");
      // And the uncertain answers linked nothing.
      const linked = raw.prepare(`SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IS NOT NULL`).all()[0] as { n: number };
      expect(linked.n).toBe(0);
    });

    it.each([
      { confidence: 69, accepted: false },
      { confidence: 70, accepted: true },
    ])("boundary: confidence $confidence is $accepted for the legacy gate, but ALWAYS a succeeded call", async ({ confidence, accepted }) => {
      seedThreats(raw, distinct(1));
      useFetch({ anthropic: () => new Response(JSON.stringify({
        id: "m", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn",
        content: [{ type: "text", text: brandMatchJson(confidence) }], usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200 }) });

      const run = await runAnalyst();

      expect(run.details.haikuSuccesses).toBe(accepted ? 1 : 0);
      expect(run.details.lowConfidence).toBe(accepted ? 0 : 1);
      expect(counters(run)).toEqual({ attempted: 1, succeeded: 1, skipped: 0 });
      expect(run.status).toBe("success");
    });

    it("mixed with failures: 2 uncertain answers + 1 HTTP 400 -> attempted 3 / succeeded 2, AI is alive so not degraded", async () => {
      seedThreats(raw, distinct(3));
      let n = 0;
      useFetch({ anthropic: () => (++n === 2 ? api400() : lowConfidenceAnswer()) });

      const run = await runAnalyst();

      expect(counters(run)).toEqual({ attempted: 3, succeeded: 2, skipped: 0 });
      expect(run.details.lowConfidence).toBe(2);
      expect(run.details.haikuFailures).toBe(1);
      expect(run.result?.degraded).toBeUndefined();
      expect(run.status).toBe("success");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. Degraded finalize
  // ═══════════════════════════════════════════════════════════════════
  describe("4. a run where AI was attempted and wholly failed", () => {
    beforeEach(() => {
      seedThreats(raw, distinct(3));
      // First call: the credit-balance 400. Every later call: a DIFFERENT
      // failure, so "first only" is distinguishable from "last" or "joined".
      let n = 0;
      useFetch({ anthropic: () => (++n === 1 ? api400() : new Response("upstream exploded", { status: 500 })) });
    });

    it("finalizes 'partial' — not 'success' (the defect) and not 'failed' (dishonest) — with no error recorded", async () => {
      const run = await runAnalyst();

      expect(run.status).toBe("partial");
      expect(run.runRow.status).toBe("partial");
      expect(run.runRow.error_message).toBeNull();
      expect(run.result?.degraded?.reason).toMatch(/all 3 Anthropic call\(s\) failed/);
    });

    it("stamps completed_at, which keeps the run out of the orphan / stall paths", async () => {
      const run = await runAnalyst();

      expect(run.runRow.completed_at).not.toBeNull();
      expect(isOrphanedRun({ status: run.runRow.status, completedAt: run.runRow.completed_at })).toBe(false);
      const stalledAt50Min = (completedAt: string | null): boolean =>
        computeIsStalled({
          lastRunAgeMs: 50 * 60 * 1000, // past the 45-min 'partial' clause, under the 60-min hard ceiling
          thresholdMs: 60 * 60 * 1000,
          isWorkflowAgent: false,
          lastRunStatus: run.runRow.status,
          lastRunCompletedAt: completedAt,
        });
      expect(stalledAt50Min(run.runRow.completed_at)).toBe(false);
      // Contrast: the same run without the stamp WOULD be recovered.
      expect(stalledAt50Min(null)).toBe(true);
    });

    it("aiFirstFailureKind / aiFirstError carry the FIRST failure only, never an accumulation", async () => {
      const run = await runAnalyst();

      expect(net.anthropicCalls).toHaveLength(3);
      expect(counters(run)).toEqual({ attempted: 3, succeeded: 0, skipped: 0 });
      expect(run.details.aiFirstFailureKind).toBe("api_error");
      const first = run.details.aiFirstError as string;
      expect(first).toMatch(/credit balance/i);
      // The 2nd and 3rd failures (HTTP 500) must not be appended or substituted.
      expect(first).not.toMatch(/upstream exploded|500/);
      expect(first).not.toContain("\n");
      // Surfaced the same way in the human summary and the degraded reason.
      expect(run.summary.summary).toContain(first);
      expect(run.result?.degraded?.reason).toContain(first);
      expect(run.result?.degraded?.reason).not.toMatch(/upstream exploded/);
    });

    it("the first-call probe row records the failure kind (its INSERT is inside a swallowing try/catch, so prove it ran)", async () => {
      const run = await runAnalyst();

      const probeInsert = run.log.filter((e) => e.sql === PROBE_SQL);
      expect(probeInsert).toHaveLength(1);
      expect(probeInsert[0]!.error).toBeUndefined();
      expect(run.probe).toBeDefined();
      expect(run.probe!.details.haiku_success).toBe(false);
      expect(run.probe!.details.haiku_failure_kind).toBe("api_error");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. Severity of the summary diagnostic
  // ═══════════════════════════════════════════════════════════════════
  describe("5. summary severity is 'high' iff attempted > 0 && succeeded === 0", () => {
    const ok = (text: string) => () => new Response(JSON.stringify({
      id: "m", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn",
      content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 });

    const scenarios: Array<{
      name: string;
      setup: () => { throttle?: string; anthropic?: AnthropicHandler };
      severity: "high" | "info";
    }> = [
      { name: "every call failed (HTTP 400)", severity: "high", setup: () => { seedThreats(raw, distinct(2)); return { anthropic: api400 }; } },
      { name: "a single failed call (no floor on the per-run verdict)", severity: "high", setup: () => { seedThreats(raw, distinct(1)); return { anthropic: api400 }; } },
      { name: "all calls succeeded", severity: "info", setup: () => { seedThreats(raw, distinct(2)); return { anthropic: ok(brandMatchJson(90)) }; } },
      { name: "uncertain (confidence < 70) answers only", severity: "info", setup: () => { seedThreats(raw, distinct(2)); return { anthropic: ok(brandMatchJson(30)) }; } },
      { name: "one answered, one failed", severity: "info", setup: () => {
        seedThreats(raw, distinct(2));
        let n = 0;
        return { anthropic: () => (++n === 1 ? ok(brandMatchJson(90))() : api400()) };
      } },
      { name: "throttled (attempted === 0)", severity: "info", setup: () => { seedThreats(raw, distinct(2)); return { throttle: "budget emergency throttle (99.5% of $21.33)" }; } },
      { name: "all keyword pre-matched (attempted === 0)", severity: "info", setup: () => { seedKeywordBrand(raw); seedThreats(raw, keywordMatched(2)); return {}; } },
      { name: "nothing to process", severity: "info", setup: () => ({}) },
    ];

    it.each(scenarios)("$name -> $severity", async ({ setup, severity }) => {
      const { throttle, anthropic } = setup();
      if (anthropic) useFetch({ anthropic });

      const run = await runAnalyst(throttle);

      const { attempted, succeeded } = counters(run);
      expect(run.summary.severity).toBe(severity);
      // The severity is derived from the persisted counters, not independently.
      expect(run.summary.severity === "high").toBe(attempted > 0 && succeeded === 0);
      expect(/AI CALLS ALL FAILING/.test(run.summary.summary)).toBe(severity === "high");
      expect(run.result?.degraded !== undefined).toBe(severity === "high");
      expect(run.runRow.status).toBe(severity === "high" ? "partial" : "success");
    });

    it("the first-call probe row is hardcoded 'info' even in an outage — the SUMMARY row is the signal, not the probe", async () => {
      seedThreats(raw, distinct(2));
      useFetch({ anthropic: api400 });

      const run = await runAnalyst();

      expect(run.probe!.severity).toBe("info");
      expect(run.summary.severity).toBe("high");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 6: the live DoH fetches that the Anthropic-only stub collided with
  // ═══════════════════════════════════════════════════════════════════
  describe("phase 6 DoH lookups share the fetch stub without touching the AI counters", () => {
    it("20 DoH lookups are routed to the DoH answer, a resolving variant is persisted, and the AI counters see only the Anthropic calls", async () => {
      // Two model-bound threats (Anthropic answers 400) ...
      seedThreats(raw, distinct(2));
      // ... plus one already-attributed high-severity numbered domain so
      // phase 6 fans out ±10 variants. target_brand_id is set so it is not
      // an analyst candidate and cannot add an Anthropic call.
      raw.exec(
        `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, severity, target_brand_id, status, created_at)
         VALUES ('num0', 'otherfeed', 'phishing', 'kit50-zq.net', 'high', 'brand_x', 'active', datetime('now'))`,
      );
      useFetch({
        anthropic: api400,
        doh: (name) =>
          name === "kit51-zq.net"
            ? new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "203.0.113.9" }] }), { status: 200 })
            : new Response(JSON.stringify({ Status: 3 }), { status: 200 }),
      });

      const run = await runAnalyst();

      // DoH: 20 variants of kit50 (40..60 minus 50), all routed to the DoH handler.
      expect(net.dohCalls).toHaveLength(20);
      expect(net.dohCalls).toContain("kit51-zq.net");
      expect(net.dohCalls).not.toContain("kit50-zq.net");
      // The resolving variant was created — proof the DoH answer (not the
      // Anthropic fixture) reached phase 6.
      expect(run.details.numbered_variants_created).toBe(1);
      const created = raw.prepare(`SELECT malicious_domain FROM threats WHERE source_feed = 'numbered_variant_scan'`).all() as Array<{ malicious_domain: string }>;
      expect(created.map((r) => r.malicious_domain)).toEqual(["kit51-zq.net"]);

      // Anthropic: exactly the two model-bound threats, and ONLY those are counted.
      expect(net.anthropicCalls).toHaveLength(2);
      expect(counters(run)).toEqual({ attempted: 2, succeeded: 0, skipped: 0 });
      expect(run.status).toBe("partial");
      expect(run.summary.severity).toBe("high");
    });
  });
});
