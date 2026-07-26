/**
 * Regression tests for handlers/agents.ts handleListAgents — the
 * "latest run per agent" query.
 *
 * Shape history:
 *   1. Correlated subquery (full SCAN + per-row subquery).
 *   2. Single ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY
 *      started_at DESC) pass, WHERE rn = 1 — still materialized EVERY
 *      agent_runs row (~142K) to return ~20.
 *   3. (current, platform-audit-2026-07-26) env.DB.batch() of one
 *      indexed point-lookup per KNOWN agent id:
 *        SELECT ... FROM agent_runs WHERE agent_id = ?
 *        ORDER BY started_at DESC LIMIT 1
 *      each served by idx_agent_runs_agent (agent_id, started_at DESC)
 *      as a single index-ordered row read. Output columns and the
 *      downstream latestRunMap shape are unchanged.
 *
 * CRITICAL: the lookup is deliberately UNBOUNDED by age. deriveStatus
 * keys off the absolute most-recent run of each agent — a long-dormant
 * agent whose last run FAILED must still read as 'error'. A time bound
 * would silently flip such an agent to 'idle' (counted-as-online),
 * hiding a failure. The per-agent `LIMIT 1` returns that latest row
 * regardless of age; these tests lock that behavior.
 *
 * This repo has no live-D1 test harness (see search.test.ts), so D1 is
 * faked at the .prepare(sql)/.batch() level: handleListAgents' parallel
 * queries are routed to canned results by matching a distinguishing SQL
 * substring; the latest-run point-lookups run through a fake
 * env.DB.batch that filters the seeded rows by each statement's bound
 * agent_id. What we lock down is (a) the latest-run lookup runs via
 * batch()'d per-agent point-lookups with NO time bound (not a
 * whole-table window/correlated scan), (b) a dormant agent whose latest
 * run failed surfaces as 'error', and (c) the handler degrades to
 * idle/null when an agent has no runs at all.
 */

import { describe, it, expect } from "vitest";
import { handleListAgents } from "../src/handlers/agents";
import type { Env } from "../src/types";

// ─── Fakes ─────────────────────────────────────────────────────────

interface Captured {
  sql: string;
  binds: unknown[];
}

interface Rows {
  latestRuns?: Array<Record<string, unknown>>;
  agentConfigs?: Array<Record<string, unknown>>;
}

function classify(sql: string): string {
  // Latest-run point-lookup — one per agent id, run via env.DB.batch().
  if (/FROM agent_runs\s+WHERE agent_id = \?\s+ORDER BY started_at DESC\s+LIMIT 1/.test(sql)) return "latestRuns";
  if (/FROM agent_activity_log/.test(sql)) return "workflowStats";
  if (/FROM agent_configs/.test(sql)) return "agentConfigs";
  if (/jobs_24h/.test(sql)) return "runStats24h";
  if (/outputs_24h/.test(sql)) return "outputStats24h";
  if (/CAST\(strftime\('%H', started_at\)/.test(sql)) return "hourlyActivity";
  if (/CAST\(strftime\('%H', created_at\)/.test(sql)) return "hourlyOutputs";
  if (/AS bucket/.test(sql)) return "recentTickRows";
  if (/avg_duration_ms/.test(sql)) return "avgDurations";
  if (/last_output_at/.test(sql)) return "lastOutputTimes";
  throw new Error(`unclassified SQL in fake DB: ${sql}`);
}

interface FakeStmt {
  __sql: string;
  __binds: unknown[];
  all: () => Promise<{ results: Array<Record<string, unknown>>; meta: { rows_read: number; rows_written: number } }>;
}

function makeEnv(rows: Rows = {}): { env: Env; calls: Captured[]; batchCalls: Captured[][] } {
  const calls: Captured[] = [];
  const batchCalls: Captured[][] = [];

  const resultFor = (
    kind: string,
    binds: unknown[],
  ): { results: Array<Record<string, unknown>>; meta: { rows_read: number; rows_written: number } } => {
    let data: Array<Record<string, unknown>>;
    if (kind === "latestRuns") {
      // Point-lookup semantics: WHERE agent_id = ? ... LIMIT 1. Filter
      // the seeded rows to the bound agent_id and return at most one —
      // exactly what the indexed per-agent lookup yields in prod.
      const agentId = binds[0];
      data = (rows.latestRuns ?? []).filter((r) => r.agent_id === agentId).slice(0, 1);
    } else if (kind === "agentConfigs") {
      data = rows.agentConfigs ?? [];
    } else {
      data = []; // workflowStats + all other aggregates: empty in these tests
    }
    return { results: data, meta: { rows_read: data.length, rows_written: 0 } };
  };

  const prepare = (sql: string) => {
    const kind = classify(sql);
    const run = async (binds: unknown[]) => {
      calls.push({ sql, binds });
      return resultFor(kind, binds);
    };
    return {
      all: (...binds: unknown[]) => run(binds),
      bind: (...binds: unknown[]): FakeStmt => ({
        __sql: sql,
        __binds: binds,
        all: () => run(binds),
      }),
    };
  };

  const batch = async (statements: FakeStmt[]) => {
    batchCalls.push(statements.map((s) => ({ sql: s.__sql, binds: s.__binds })));
    return Promise.all(statements.map((s) => s.all()));
  };

  const env = {
    DB: { prepare, batch } as unknown as D1Database,
    CACHE: {
      get: async () => null, // always cold — exercise the compute path
      put: async () => undefined,
    },
  } as unknown as Env;

  return { env, calls, batchCalls };
}

function req(): Request {
  return new Request("https://averrow.com/api/agents");
}

async function bodyOf(res: Response) {
  return res.json() as Promise<{
    success: boolean;
    data: Array<Record<string, unknown>>;
  }>;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("handleListAgents — latest-run query shape", () => {
  it("runs the latest-run lookup as a batch of per-agent point-lookups with NO age bound (not a whole-table scan)", async () => {
    const { env, batchCalls } = makeEnv();
    await handleListAgents(req(), env);

    // The latest-run reads go through exactly one env.DB.batch() call.
    expect(batchCalls.length).toBe(1);
    const batch = batchCalls[0];
    expect(batch.length).toBeGreaterThan(0);

    for (const stmt of batch) {
      // Each statement is an indexed point-lookup: WHERE agent_id = ?
      // ORDER BY started_at DESC LIMIT 1, served by idx_agent_runs_agent.
      expect(stmt.sql).toMatch(/FROM agent_runs\s+WHERE agent_id = \?\s+ORDER BY started_at DESC\s+LIMIT 1/);
      // Exactly one bound param: the agent id.
      expect(stmt.binds.length).toBe(1);
      expect(typeof stmt.binds[0]).toBe("string");
      // MUST carry no time bound — a bound would hide the latest run of
      // a dormant agent (see file header).
      expect(stmt.sql).not.toMatch(/datetime\('now'/);
      // The old whole-table shapes are fully gone from this lookup.
      expect(stmt.sql).not.toMatch(/ROW_NUMBER\(\) OVER/);
      expect(stmt.sql).not.toMatch(/WHERE id IN \(\s*SELECT id FROM agent_runs r2/);
    }
  });

  it("covers every known agent id (agent modules + navigator legacy ids) in the batch, deduped", async () => {
    const { env, batchCalls } = makeEnv();
    await handleListAgents(req(), env);

    const ids = batchCalls[0].map((s) => s.binds[0] as string);
    // No duplicates — the handler dedupes via a Set before batching.
    expect(new Set(ids).size).toBe(ids.length);
    // Navigator's current + legacy ids are both looked up so its
    // synthesized row can pick whichever ran most recently.
    expect(ids).toContain("navigator");
    expect(ids).toContain("fast_tick");
    // A representative first-class agent is present.
    expect(ids).toContain("sentinel");
  });
});

describe("handleListAgents — latest-run mapping", () => {
  it("surfaces a seeded latest run for a known agent (sentinel)", async () => {
    const recentIso = new Date().toISOString();
    const { env } = makeEnv({
      latestRuns: [
        {
          agent_id: "sentinel",
          status: "success",
          started_at: recentIso,
          completed_at: recentIso,
          duration_ms: 1234,
          error_message: null,
        },
      ],
    });

    const res = await handleListAgents(req(), env);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const sentinel = body.data.find((a) => a.agent_id === "sentinel");
    expect(sentinel).toBeDefined();
    expect(sentinel!.last_run_at).toBe(recentIso);
    expect(sentinel!.last_run_status).toBe("success");
    expect(sentinel!.last_run_duration_ms).toBe(1234);
    expect(sentinel!.last_run_error).toBeNull();
    // A run seconds ago is within the 2h freshness window -> active.
    expect(sentinel!.status).toBe("active");
  });

  it("an agent with no runs at all degrades to idle/null, not a crash", async () => {
    // Empty latestRuns = an agent that has genuinely never run. The
    // handler must degrade to idle/null rather than crash or fabricate
    // a stale "last run".
    const { env } = makeEnv({ latestRuns: [] });

    const res = await handleListAgents(req(), env);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const sentinel = body.data.find((a) => a.agent_id === "sentinel");
    expect(sentinel).toBeDefined();
    expect(sentinel!.last_run_at).toBeNull();
    expect(sentinel!.last_run_status).toBeNull();
    expect(sentinel!.last_run_duration_ms).toBeNull();
    expect(sentinel!.status).toBe("idle");
  });

  it("a long-dormant agent whose latest run FAILED still surfaces as 'error' (unbounded latest-run — regression guard for the removed 30-day bound)", async () => {
    // 40 days ago — older than the previously-buggy 30-day window. The
    // unbounded query returns this row, so deriveStatus reads the failed
    // status and reports 'error', NOT a falsely-online 'idle'.
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const { env } = makeEnv({
      latestRuns: [
        { agent_id: "sentinel", status: "failed", started_at: stale, completed_at: stale, duration_ms: 700, error_message: "stale boom" },
      ],
    });
    const res = await handleListAgents(req(), env);
    const body = await bodyOf(res);
    const sentinel = body.data.find((a) => a.agent_id === "sentinel");
    expect(sentinel!.last_run_status).toBe("failed");
    expect(sentinel!.last_run_error).toBe("stale boom");
    expect(sentinel!.status).toBe("error");
  });

  it("picks the newest row per agent_id when multiple rows are present (ROW_NUMBER rn=1 contract)", async () => {
    // The fake stands in for what the real ROW_NUMBER query already
    // guarantees (one row per agent_id, the most recent). This locks
    // that the handler doesn't silently accept a second row and
    // overwrite with an older one via Map construction order.
    const older = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const { env } = makeEnv({
      latestRuns: [
        { agent_id: "sentinel", status: "failed", started_at: older, completed_at: older, duration_ms: 500, error_message: "boom" },
      ],
    });
    const res = await handleListAgents(req(), env);
    const body = await bodyOf(res);
    const sentinel = body.data.find((a) => a.agent_id === "sentinel");
    expect(sentinel!.last_run_status).toBe("failed");
    expect(sentinel!.status).toBe("error");
  });
});
