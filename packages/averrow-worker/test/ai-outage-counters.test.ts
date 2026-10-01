/**
 * Strictly-API AI counters + honest run status — sentinel, driven end to end
 * through `executeAgent` against a REAL SQLite instance whose schema is
 * derived from migrations/, with only `fetch` stubbed.
 *
 * Each describe block pins one trap that was found while building the
 * silent-AI-failure guard. They are the reason the fix is correct, so they
 * are what must not regress:
 *
 *   2. Sentinel increments the legacy `haikuSuccesses` for a rules-based
 *      skip that makes NO API call (`// count as success for stats`), which
 *      is why `haiku=N/0` read healthy through three months of total outage.
 *      The NEW counters must read zero attempts for a run that made no call.
 *   3. A deliberate throttle / budget cap must count as SKIPPED, never
 *      ATTEMPTED — otherwise the cost guard doing its job raises the alert.
 *   4. `getOrClassify` shares ONE promise across sibling threats; counting
 *      per threat would let `succeeded` exceed `attempted`.
 *   6. A run where AI was attempted and wholly failed finalizes
 *      `status='partial'` with `completed_at` stamped: not 'success' (the
 *      defect), not 'failed' (dishonest — the rule-based fallback did real
 *      work). `completed_at` is what keeps it out of the orphan/stall paths.
 *
 * Case 5 (the Flight Control conjunction gate) lives in
 * flight-control-ai-calls-failing.test.ts; this file produces the real
 * writer output that file's reader is also checked against.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeAgent } from "../src/lib/agentRunner";
import { sentinelAgent } from "../src/agents/sentinel";
import { computeIsStalled, isOrphanedRun } from "../src/agents/flightControl";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import {
  SENTINEL_TABLES, CLASSIFICATION_JSON, CREDIT_BALANCE_400, anthropicOk,
  RULE_SKIPPED, MODEL_BOUND, seedThreats, distinct, type SeedThreat,
} from "./ai-fixtures";

interface Run {
  runId: string;
  status: string;
  result: Awaited<ReturnType<typeof executeAgent>>["result"];
  runRow: { status: string; completed_at: string | null; error_message: string | null };
  /** `details` of the sentinel summary output (the one carrying the AI counters). */
  details: Record<string, unknown>;
  summary: { summary: string; severity: string | null };
}

describe.skipIf(!hasSqlite())("sentinel — strictly-API counters and run status (real SQLite, stubbed fetch)", () => {
  let raw: SqliteDb;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    raw = openDerivedDb(SENTINEL_TABLES);
    raw.exec(`INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('sentinel', 'approved', datetime('now'))`);
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  async function runSentinel(throttleReason = ""): Promise<Run> {
    const env = {
      DB: d1FromSqlite(raw),
      CACHE: fakeKv({ "ai:throttle_reason": throttleReason }),
      ANTHROPIC_API_KEY: "sk-ant-test",
    } as never;
    const out = await executeAgent(env, sentinelAgent);
    expect(out.runId, "executeAgent refused to run (circuit/approval gate)").not.toBe("");

    const runRow = raw.prepare(`SELECT status, completed_at, error_message FROM agent_runs WHERE id = ?`).all(out.runId)[0] as Run["runRow"];
    // The summary output is the one with the strictly-API counters; Iranian-APT /
    // social / APT-pattern rows share type='classification' but carry other details.
    const rows = raw
      .prepare(`SELECT summary, severity, details FROM agent_outputs WHERE agent_id = 'sentinel' AND type = 'classification'`)
      .all() as Array<{ summary: string; severity: string | null; details: string }>;
    const summaryRow = rows.find((r) => "aiCallsAttempted" in (JSON.parse(r.details) as object));
    expect(summaryRow, "no sentinel summary output carrying aiCallsAttempted was persisted").toBeDefined();
    return {
      runId: out.runId,
      status: out.status,
      result: out.result,
      runRow,
      details: JSON.parse(summaryRow!.details) as Record<string, unknown>,
      summary: { summary: summaryRow!.summary, severity: summaryRow!.severity },
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 2. The rules-skip counter trap
  // ═══════════════════════════════════════════════════════════════════
  describe("every threat is rule-skipped (NO API call is made)", () => {
    it("the NEW counters read attempted === 0 even though the legacy haikuSuccesses is inflated", async () => {
      seedThreats(raw, distinct(6, RULE_SKIPPED));

      const run = await runSentinel();

      // Precondition that makes this THE trap: the legacy counter reads
      // "6 successes, 0 failures" for a run in which Anthropic was never called.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(run.details.aiSkippedByRules).toBe(6);
      expect(run.details.haikuSuccesses).toBe(6);
      expect(run.details.haikuFailures).toBe(0);

      // The property under test: the strictly-API counters are NOT fooled.
      expect(run.details.aiCallsAttempted).toBe(0);
      expect(run.details.aiCallsSucceeded).toBe(0);
      expect(run.details.aiCallsSkipped).toBe(0);
    });

    it("therefore the alert condition does not fire: not degraded, severity info, status 'success'", async () => {
      seedThreats(raw, distinct(6, RULE_SKIPPED));

      const run = await runSentinel();

      // attempted > 0 && succeeded === 0 is the alert predicate; with
      // attempted === 0 it is false, so nothing downstream sees an outage.
      const attempted = run.details.aiCallsAttempted as number;
      const succeeded = run.details.aiCallsSucceeded as number;
      expect(attempted > 0 && succeeded === 0).toBe(false);
      expect(run.result?.degraded).toBeUndefined();
      expect(run.summary.severity).toBe("info");
      expect(run.summary.summary).not.toMatch(/AI CALLS ALL FAILING/);
      expect(run.status).toBe("success");
      expect(run.runRow.status).toBe("success");
    });

    it("the batch-level APT detector IS a real call: >= 10 rule-skipped threats + HTTP 400 counts as attempted, and the summary sees it", async () => {
      // The summary output is pushed AFTER the APT block precisely so its
      // AI-health verdict sees this call ("Do not move it back up"). If the
      // summary were computed before the APT call, this run would read as
      // attempted === 0 / status success while the only real API call of the
      // run was failing.
      seedThreats(raw, distinct(10, RULE_SKIPPED));
      fetchSpy.mockImplementation(async () => new Response(CREDIT_BALANCE_400, { status: 400 }));

      const run = await runSentinel();

      expect(fetchSpy).toHaveBeenCalledTimes(1); // the APT call only; all 10 classifications were rule-skipped
      expect(run.details.aiCallsAttempted).toBe(1);
      expect(run.details.aiCallsSucceeded).toBe(0);
      expect(run.details.haikuSuccesses).toBe(10); // legacy counter still reads healthy
      expect(run.runRow.status).toBe("partial");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. A deliberate throttle must not look like an outage
  // ═══════════════════════════════════════════════════════════════════
  describe("deliberate skips are SKIPPED, never ATTEMPTED", () => {
    it("global budget throttle: attempted === 0, skipped incremented, no request leaves, no alert condition", async () => {
      seedThreats(raw, distinct(3));

      const run = await runSentinel("budget hard throttle (97% of $21.33)");

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(run.details.aiCallsAttempted).toBe(0);
      expect(run.details.aiCallsSucceeded).toBe(0);
      expect(run.details.aiCallsSkipped).toBe(3);
      // The legacy counter DOES see failures here (3) — which is exactly why it
      // cannot be the signal. The strictly-API counters do not.
      expect(run.details.haikuFailures).toBe(3);
      expect(run.details.aiFirstError).toBeNull();
      expect(run.details.aiFirstFailureKind).toBeNull();

      expect(run.result?.degraded).toBeUndefined();
      expect(run.summary.severity).toBe("info");
      expect(run.status).toBe("success");
    });

    it("throttle also covers the APT detector: 12 distinct threats -> 12 classification skips + 1 APT skip, still attempted === 0", async () => {
      seedThreats(raw, distinct(12));

      const run = await runSentinel("budget emergency throttle (99.5% of $21.33)");

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(run.details.aiCallsAttempted).toBe(0);
      expect(run.details.aiCallsSkipped).toBe(13);
      expect(run.status).toBe("success");
    });

    it("per-agent monthly token cap (budget_cap): attempted === 0, skipped incremented, no request leaves", async () => {
      const { agentModules } = await import("../src/agents");
      const cap = agentModules.sentinel!.budget.monthlyTokenCap;
      raw.prepare(
        `INSERT INTO agent_budget_rollups (agent_id, year_month, total_input_tokens, total_output_tokens, total_cost_usd, call_count)
         VALUES ('sentinel', strftime('%Y-%m', 'now'), ?, 0, 1, 1)`,
      ).run(cap + 1);
      seedThreats(raw, distinct(2));

      const run = await runSentinel();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(run.details.aiCallsAttempted).toBe(0);
      expect(run.details.aiCallsSkipped).toBe(2);
      expect(run.result?.degraded).toBeUndefined();
      expect(run.status).toBe("success");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. Sibling-cache accounting
  // ═══════════════════════════════════════════════════════════════════
  describe("sibling threats share ONE in-flight call", () => {
    const siblings = (apex: string, n: number, prefix: string): SeedThreat[] =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, domain: `host${i}.${apex}`, ...MODEL_BOUND }));

    it("5 siblings, call succeeds: exactly 1 attempted / 1 succeeded (succeeded <= attempted)", async () => {
      seedThreats(raw, siblings("shared-apex.net", 5, "s"));
      fetchSpy.mockImplementation(async () => anthropicOk(CLASSIFICATION_JSON));

      const run = await runSentinel();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(run.details.aiSkippedBySibling).toBe(4);
      expect(run.details.aiCallsAttempted).toBe(1);
      expect(run.details.aiCallsSucceeded).toBe(1);
      expect(run.details.aiCallsSucceeded as number).toBeLessThanOrEqual(run.details.aiCallsAttempted as number);
      // Per-threat bookkeeping is what the legacy counter does (5 successes
      // for ONE call) — the strictly-API pair must not follow it.
      expect(run.details.haikuSuccesses).toBe(5);
    });

    it("5 siblings, call fails: still exactly 1 attempted / 0 succeeded", async () => {
      seedThreats(raw, siblings("shared-apex.net", 5, "s"));
      fetchSpy.mockImplementation(async () => new Response(CREDIT_BALANCE_400, { status: 400 }));

      const run = await runSentinel();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(run.details.aiCallsAttempted).toBe(1);
      expect(run.details.aiCallsSucceeded).toBe(0);
      expect(run.details.haikuFailures).toBe(5); // per-threat, legacy
    });

    it("two sibling groups, one answered and one failing: attempted 2 / succeeded 1 — AI is alive, so no degraded run", async () => {
      seedThreats(raw, [...siblings("alive-apex.net", 3, "a"), ...siblings("dead-apex.net", 2, "b")]);
      fetchSpy.mockImplementation(async (_url: string, init: { body: string }) =>
        init.body.includes("alive-apex")
          ? anthropicOk(CLASSIFICATION_JSON)
          : new Response("upstream exploded", { status: 500 }),
      );

      const run = await runSentinel();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(run.details.aiCallsAttempted).toBe(2);
      expect(run.details.aiCallsSucceeded).toBe(1);
      expect(run.details.aiCallsSucceeded as number).toBeLessThanOrEqual(run.details.aiCallsAttempted as number);
      expect(run.result?.degraded).toBeUndefined();
      expect(run.status).toBe("success");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. Run status
  // ═══════════════════════════════════════════════════════════════════
  describe("a run where AI was attempted and wholly failed", () => {
    beforeEach(() => {
      seedThreats(raw, distinct(2));
      fetchSpy.mockImplementation(async () => new Response(CREDIT_BALANCE_400, { status: 400 }));
    });

    it("finalizes status 'partial' — not 'success' (the defect) and not 'failed' (dishonest)", async () => {
      const run = await runSentinel();

      expect(run.status).toBe("partial");
      expect(run.runRow.status).toBe("partial");
      expect(run.runRow.status).not.toBe("success");
      expect(run.runRow.status).not.toBe("failed");
      // It did not throw: no error recorded, and the rule-based fallback did real work.
      expect(run.runRow.error_message).toBeNull();
      const classified = raw.prepare(`SELECT COUNT(*) AS n FROM threats WHERE confidence_score IS NOT NULL`).all()[0] as { n: number };
      expect(classified.n).toBe(2);
    });

    it("stamps completed_at, which is what keeps the run out of the orphan / stall paths", async () => {
      const run = await runSentinel();

      expect(run.runRow.completed_at).not.toBeNull();
      // Same predicates Flight Control and the reaper apply: a 'partial' is an
      // orphan ONLY when completed_at is NULL.
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
      // Contrast: the SAME run with completed_at missing WOULD be recovered,
      // so the stamp is genuinely what protects it.
      expect(stalledAt50Min(null)).toBe(true);
      expect(isOrphanedRun({ status: run.runRow.status, completedAt: null })).toBe(true);
    });

    it("records the honest diagnosis: counters, first failure, severity 'high' and an AI-CALLS-ALL-FAILING summary", async () => {
      const run = await runSentinel();

      expect(run.details.aiCallsAttempted).toBe(2);
      expect(run.details.aiCallsSucceeded).toBe(0);
      expect(run.details.aiFirstFailureKind).toBe("api_error");
      expect(String(run.details.aiFirstError)).toMatch(/HTTP 400.*credit balance/);
      expect(run.summary.severity).toBe("high");
      expect(run.summary.summary).toMatch(/^AI CALLS ALL FAILING/);
      expect(run.result?.degraded?.reason).toMatch(/all 2 Anthropic call\(s\) failed/);
    });
  });

  it("control: a healthy run (every call answered) finalizes 'success' with attempted === succeeded", async () => {
    seedThreats(raw, distinct(2));
    fetchSpy.mockImplementation(async () => anthropicOk(CLASSIFICATION_JSON));

    const run = await runSentinel();

    expect(run.details.aiCallsAttempted).toBe(2);
    expect(run.details.aiCallsSucceeded).toBe(2);
    expect(run.status).toBe("success");
    expect(run.runRow.completed_at).not.toBeNull();
    expect(run.summary.severity).toBe("info");
  });
});
