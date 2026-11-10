/**
 * D1 10-second overload window vs. run finalize (2026-11-10).
 *
 * Prod 2026-11-09/10: navigator's :25/:55 ticks, daily_snapshots and the
 * :07-:13 agents finished their body, but the finalize UPDATE — and 350 ms
 * later the failure UPDATE — were rejected with "D1 DB is overloaded. Too
 * many resources consumed within a 10 second window". withD1Retry's
 * 50/100/200 ms backoff retried inside that same window, so the row stayed
 * 'partial' / completed_at NULL until a reaper called it "worker terminated".
 *
 * Pins:
 *   1. d1RetryDelayMs: overload errors back off past the window only when the
 *      caller opts in (overloadBaseMs); other transient errors keep the short
 *      backoff; the default (no opt-in) is unchanged.
 *   2. withD1Retry with overloadBaseMs survives an overload burst and its
 *      total wait exceeds 10 s.
 *   3. executeAgent: a scheduled run whose finalize UPDATE is overloaded
 *      several times still lands status + completed_at; an 'api' run
 *      (inside an HTTP request) keeps the short backoff.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  d1RetryDelayMs,
  withD1Retry,
  isD1OverloadError,
  D1_OVERLOAD_RETRY_BASE_MS,
} from "../src/lib/d1-retry";
import { executeAgent, finalizeOverloadBaseMs } from "../src/lib/agentRunner";
import type { AgentModule } from "../src/lib/agentRunner";
import type { Env } from "../src/types";

const OVERLOAD = "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("d1RetryDelayMs", () => {
  const noJitter = (): number => 0;

  it("overload errors wait past the 10 s window when the caller opts in", () => {
    const opts = { overloadBaseMs: D1_OVERLOAD_RETRY_BASE_MS };
    const delays = [0, 1, 2].map((a) => d1RetryDelayMs(a, OVERLOAD, opts, noJitter));
    expect(delays).toEqual([3_000, 6_000, 12_000]);
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThan(10_000);
  });

  it("other transient errors keep the short backoff even with the opt-in", () => {
    const opts = { overloadBaseMs: D1_OVERLOAD_RETRY_BASE_MS };
    expect(d1RetryDelayMs(0, "D1_ERROR: Network connection lost.", opts, noJitter)).toBe(50);
    expect(d1RetryDelayMs(2, "D1_ERROR: Network connection lost.", opts, noJitter)).toBe(200);
  });

  it("without the opt-in an overload error uses the legacy short backoff", () => {
    expect(d1RetryDelayMs(0, OVERLOAD, {}, noJitter)).toBe(50);
    expect(d1RetryDelayMs(1, OVERLOAD, {}, noJitter)).toBe(100);
  });

  it("jitter stays within a quarter of the overload base", () => {
    const max = d1RetryDelayMs(0, OVERLOAD, { overloadBaseMs: 4_000 }, () => 0.999);
    expect(max).toBeGreaterThanOrEqual(4_000);
    expect(max).toBeLessThan(5_000);
  });

  it("isD1OverloadError matches the D1 message only", () => {
    expect(isD1OverloadError(OVERLOAD)).toBe(true);
    expect(isD1OverloadError("D1_ERROR: Network connection lost.")).toBe(false);
  });
});

describe("withD1Retry overload backoff", () => {
  it("rides out an overload burst longer than the old 350 ms retry span", async () => {
    // Zero jitter: withD1Retry draws jitter from Math.random (≤ base/4 per
    // retry), so the 2nd retry fires at 9 s + up to 1.5 s. With real
    // randomness it landed past the 10 s window ~1/3 of the time and the
    // burst cleared on the 3rd call ("expected 3 to be 4") — a coin flip,
    // not load. Pin the schedule to exactly t=0, 3 s, 9 s, 21 s.
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();
    const start = Date.now();
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      // Rejected for the first 10 s of the window, as in prod.
      if (Date.now() - start < 10_000) throw new Error(OVERLOAD);
      return "ok";
    };
    const p = withD1Retry(fn, { overloadBaseMs: D1_OVERLOAD_RETRY_BASE_MS });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(4); // t=0, ~3s, ~9s, ~21s
  });

  it("the legacy default still gives up inside the window", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const fn = async (): Promise<string> => {
      if (Date.now() - start < 10_000) throw new Error(OVERLOAD);
      return "ok";
    };
    const p = withD1Retry(fn);
    const settled = p.then(() => "resolved", (e: unknown) => (e instanceof Error ? e.message : String(e)));
    await vi.runAllTimersAsync();
    await expect(settled).resolves.toBe(OVERLOAD);
  });
});

// ─── executeAgent finalize ────────────────────────────────────────────

interface RunRow { status: string; completed_at: string | null }

/** Minimal D1: agent_configs enabled, approvals approved, agent_runs tracked.
 *  The finalize UPDATE (`completed_at = datetime('now')`) throws OVERLOAD on
 *  its first `overloads` executions. */
function makeDb(overloads: number) {
  const runs = new Map<string, RunRow>();
  let finalizeCalls = 0;
  const prepare = (sql: string) => {
    const bind = (...args: unknown[]) => ({
      run: async () => {
        if (/INSERT INTO agent_runs/i.test(sql)) {
          runs.set(String(args[0]), { status: "partial", completed_at: null });
        } else if (/UPDATE agent_runs SET/i.test(sql) && /completed_at = datetime\('now'\)/.test(sql)) {
          finalizeCalls += 1;
          if (finalizeCalls <= overloads) throw new Error(OVERLOAD);
          const id = String(args[args.length - 1]);
          const row = runs.get(id);
          if (row) {
            row.status = /status = 'failed'/.test(sql) ? "failed" : String(args[0]);
            row.completed_at = "now";
          }
        }
        return { success: true, meta: {} };
      },
      first: async () => {
        if (/SELECT enabled, paused_reason FROM agent_configs/i.test(sql)) return { enabled: 1, paused_reason: null };
        if (/agent_approvals/i.test(sql)) return { state: "approved", reviewer_notes: null };
        if (/SELECT consecutive_failures/i.test(sql)) return { consecutive_failures: 0 };
        return null;
      },
      all: async () => ({ results: [] }),
    });
    return { bind, first: async () => null, run: async () => ({ success: true }), all: async () => ({ results: [] }) };
  };
  return {
    db: { prepare, batch: async () => [] } as unknown as D1Database,
    runs,
    finalizeCalls: () => finalizeCalls,
  };
}

const okAgent: AgentModule = {
  name: "test_finalize_agent",
  displayName: "Test",
  description: "test",
  color: "#000",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 60,
  parallelMax: 1,
  costGuard: "exempt",
  budget: { monthlyTokenCap: 0 },
  reads: [],
  writes: [],
  outputs: [],
  status: "active",
  category: "ops",
  pipelinePosition: 99,
  execute: async () => ({ itemsProcessed: 7, itemsCreated: 0, itemsUpdated: 0, output: {} }),
};

describe("executeAgent finalize under D1 overload", () => {
  it("maps trigger types: scheduled/event wait the window out, HTTP-awaited api/manual do not", () => {
    expect(finalizeOverloadBaseMs("scheduled")).toBe(D1_OVERLOAD_RETRY_BASE_MS);
    expect(finalizeOverloadBaseMs("event")).toBe(D1_OVERLOAD_RETRY_BASE_MS);
    expect(finalizeOverloadBaseMs("manual")).toBeUndefined();
    expect(finalizeOverloadBaseMs("api")).toBeUndefined();
  });

  it("every cron/orchestrator executeAgent call passes an explicit scheduled/event trigger", () => {
    // executeAgent defaults to 'manual' (short backoff), so a cron call that
    // omits the trigger would silently lose the overload backoff.
    for (const rel of ["../src/cron/orchestrator.ts", "../src/cron/navigator.ts", "../src/cron/enricher.ts"]) {
      const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      const calls = text.split("executeAgent(").slice(1).map((c) => c.slice(0, c.indexOf(");") + 1));
      for (const call of calls) {
        if (call.startsWith(")") || call.startsWith("env: Env")) continue; // a prose mention / signature, not a call
        expect(/'(scheduled|event)'|"(scheduled|event)"/.test(call), `${rel}: executeAgent(${call.slice(0, 80)}`).toBe(true);
      }
    }
  });

  it("a scheduled run whose finalize is overloaded 3× still lands success + completed_at", async () => {
    // Warm executeAgent's lazy import so it resolves promptly under load.
    await import("../src/lib/agent-approvals");
    // Fake only setTimeout: setImmediate stays real so the loop below can
    // yield to genuine I/O (module loading) between clock steps.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0); // fixed 3/6/12 s backoff
    const { db, runs, finalizeCalls } = makeDb(3);
    const env = { DB: db } as unknown as Env;
    let settled = false;
    const p = executeAgent(env, okAgent, {}, "cron", "scheduled").finally(() => { settled = true; });
    // Step the clock until it settles (~21 s of backoff in total).
    for (let i = 0; i < 2_000 && !settled; i++) {
      await new Promise<void>((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(250);
    }
    const res = await p;
    expect(res.status).toBe("success");
    expect(finalizeCalls()).toBe(4);
    const row = runs.get(res.runId);
    expect(row).toEqual({ status: "success", completed_at: "now" });
  });
});
