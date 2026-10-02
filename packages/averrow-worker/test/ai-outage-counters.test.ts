/**
 * Strictly-API AI counters + honest run status — the agent-agnostic outage
 * contract, driven end to end through `executeAgent` against a REAL SQLite
 * instance whose schema is derived from migrations/, with only `fetch`
 * stubbed.
 *
 * This lane used to drive sentinel. AI_STRATEGY_2026-10 Phase 1 (Batch B)
 * moved sentinel onto rules — it makes no Anthropic call any more (see
 * phase1-rules-no-anthropic.test.ts) — so the traps below are now driven
 * through ANALYST, the remaining counter-instrumented agent. The
 * sentinel-only traps (rules-skip inflating `haikuSuccesses`, the sibling
 * classification cache, the opportunistic APT call) went away with the code
 * that had them. Analyst-specific shapes (keyword pre-match, confidence < 70,
 * DoH routing) live in analyst-ai-counters.test.ts.
 *
 * What must not regress:
 *
 *   3. A deliberate throttle / budget cap counts as SKIPPED, never
 *      ATTEMPTED — otherwise the cost guard doing its job raises the alert.
 *   6. A run where AI was attempted and wholly failed finalizes
 *      `status='partial'` with `completed_at` stamped: not 'success' (the
 *      defect), not 'failed' (dishonest — the fallback did real work).
 *      `completed_at` is what keeps it out of the orphan/stall paths.
 *
 * Case 5 (the Flight Control conjunction gate) lives in
 * flight-control-ai-calls-failing.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeAgent } from "../src/lib/agentRunner";
import { analystAgent } from "../src/agents/analyst";
import { computeIsStalled, isOrphanedRun } from "../src/agents/flightControl";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import {
  ANALYST_TABLES, CREDIT_BALANCE_400, anthropicOk, brandMatchJson,
  routedFetch, seedThreats, distinct, type RoutedFetch,
} from "./ai-fixtures";

interface Run {
  status: string;
  result: Awaited<ReturnType<typeof executeAgent>>["result"];
  runRow: { status: string; completed_at: string | null; error_message: string | null };
  /** `details` of the analyst summary diagnostic (the one carrying the AI counters). */
  details: Record<string, unknown>;
  summary: { summary: string; severity: string | null };
}

describe.skipIf(!hasSqlite())("strictly-API counters and run status — analyst (real SQLite, stubbed fetch)", () => {
  let raw: SqliteDb;
  let net: RoutedFetch;

  const useFetch = (opts: Parameters<typeof routedFetch>[0] = {}): void => {
    net = routedFetch(opts);
    globalThis.fetch = net.fn;
  };

  beforeEach(() => {
    raw = openDerivedDb(ANALYST_TABLES);
    raw.exec(`INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('analyst', 'approved', datetime('now'))`);
    useFetch();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    expect(net.unrouted, "analyst called a URL the stub has no route for").toEqual([]);
    vi.restoreAllMocks();
  });

  async function runAnalyst(throttleReason = ""): Promise<Run> {
    const env = {
      DB: d1FromSqlite(raw),
      CACHE: fakeKv({ "ai:throttle_reason": throttleReason }),
      ANTHROPIC_API_KEY: "sk-ant-test",
    } as never;
    const out = await executeAgent(env, analystAgent);
    expect(out.runId, "executeAgent refused to run (circuit/approval gate)").not.toBe("");

    const runRow = raw.prepare(`SELECT status, completed_at, error_message FROM agent_runs WHERE id = ?`).all(out.runId)[0] as Run["runRow"];
    const rows = raw
      .prepare(`SELECT summary, severity, details FROM agent_outputs WHERE agent_id = 'analyst' AND type = 'diagnostic'`)
      .all() as Array<{ summary: string; severity: string | null; details: string }>;
    const summaryRow = rows.find((r) => "aiCallsAttempted" in (JSON.parse(r.details) as object));
    expect(summaryRow, "no analyst summary output carrying aiCallsAttempted was persisted").toBeDefined();
    return {
      status: out.status,
      result: out.result,
      runRow,
      details: JSON.parse(summaryRow!.details) as Record<string, unknown>,
      summary: { summary: summaryRow!.summary, severity: summaryRow!.severity },
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. A deliberate throttle must not look like an outage
  // ═══════════════════════════════════════════════════════════════════
  describe("deliberate skips are SKIPPED, never ATTEMPTED", () => {
    it("global budget throttle: attempted === 0, skipped incremented, no request leaves, no alert condition", async () => {
      seedThreats(raw, distinct(3));

      const run = await runAnalyst("budget hard throttle (97% of $21.33)");

      expect(net.anthropicCalls).toHaveLength(0);
      expect(run.details.aiCallsAttempted).toBe(0);
      expect(run.details.aiCallsSucceeded).toBe(0);
      expect(run.details.aiCallsSkipped).toBe(3);
      expect(run.details.aiFirstError).toBeNull();
      expect(run.details.aiFirstFailureKind).toBeNull();
      expect(run.result?.degraded).toBeUndefined();
      expect(run.summary.severity).toBe("info");
      expect(run.status).toBe("success");
    });

    it("per-agent monthly token cap (budget_cap): attempted === 0, skipped incremented, no request leaves", async () => {
      const { agentModules } = await import("../src/agents");
      const cap = agentModules.analyst!.budget.monthlyTokenCap;
      raw.prepare(
        `INSERT INTO agent_budget_rollups (agent_id, year_month, total_input_tokens, total_output_tokens, total_cost_usd, call_count)
         VALUES ('analyst', strftime('%Y-%m', 'now'), ?, 0, 1, 1)`,
      ).run(cap + 1);
      seedThreats(raw, distinct(2));

      const run = await runAnalyst();

      expect(net.anthropicCalls).toHaveLength(0);
      expect(run.details.aiCallsAttempted).toBe(0);
      expect(run.details.aiCallsSkipped).toBe(2);
      expect(run.result?.degraded).toBeUndefined();
      expect(run.status).toBe("success");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. Run status
  // ═══════════════════════════════════════════════════════════════════
  describe("a run where AI was attempted and wholly failed", () => {
    beforeEach(() => {
      seedThreats(raw, distinct(3));
      useFetch({ anthropic: () => new Response(CREDIT_BALANCE_400, { status: 400 }) });
    });

    it("finalizes status 'partial' — not 'success' (the defect) and not 'failed' (dishonest)", async () => {
      const run = await runAnalyst();

      expect(run.status).toBe("partial");
      expect(run.runRow.status).toBe("partial");
      // It did not throw: no error recorded.
      expect(run.runRow.error_message).toBeNull();
    });

    it("stamps completed_at, which is what keeps the run out of the orphan / stall paths", async () => {
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
      // Contrast: the SAME run with completed_at missing WOULD be recovered.
      expect(stalledAt50Min(null)).toBe(true);
      expect(isOrphanedRun({ status: run.runRow.status, completedAt: null })).toBe(true);
    });

    it("records the honest diagnosis: counters, first failure, severity 'high' and an AI-CALLS-ALL-FAILING summary", async () => {
      const run = await runAnalyst();

      expect(run.details.aiCallsAttempted).toBe(3);
      expect(run.details.aiCallsSucceeded).toBe(0);
      expect(run.details.aiFirstFailureKind).toBe("api_error");
      expect(String(run.details.aiFirstError)).toMatch(/HTTP 400.*credit balance/);
      expect(run.summary.severity).toBe("high");
      expect(run.summary.summary).toMatch(/^AI CALLS ALL FAILING/);
      expect(run.result?.degraded?.reason).toMatch(/all 3 Anthropic call\(s\) failed/);
    });
  });

  it("control: a healthy run (every call answered) finalizes 'success' with attempted === succeeded", async () => {
    seedThreats(raw, distinct(2));
    useFetch({ anthropic: () => anthropicOk(brandMatchJson(90)) });

    const run = await runAnalyst();

    expect(run.details.aiCallsAttempted).toBe(2);
    expect(run.details.aiCallsSucceeded).toBe(2);
    expect(run.status).toBe("success");
    expect(run.runRow.completed_at).not.toBeNull();
    expect(run.summary.severity).toBe("info");
  });
});
