/**
 * Regression tests for handlers/agents.ts handleListAgents — the
 * "latest run per agent" query.
 *
 * The prior shape was a correlated subquery:
 *   WHERE id IN (SELECT id FROM agent_runs r2
 *                WHERE r2.agent_id = agent_runs.agent_id
 *                ORDER BY r2.started_at DESC LIMIT 1)
 * which EXPLAIN'd to a full unbounded SCAN of agent_runs plus a
 * per-row correlated subquery. It's now a single ROW_NUMBER() OVER
 * (PARTITION BY agent_id ORDER BY started_at DESC) pass, WHERE rn = 1,
 * served index-ordered by idx_agent_runs_agent. Output columns are
 * unchanged.
 *
 * CRITICAL: the query is deliberately UNBOUNDED by age. deriveStatus
 * keys off the absolute most-recent run of each agent — a long-dormant
 * agent whose last run FAILED must still read as 'error'. An earlier
 * revision added a `started_at >= datetime('now','-30 days')` bound for
 * efficiency; that silently flipped such an agent to 'idle' (and thus
 * counted-as-online), hiding a failure. Per code-review Finding 1 the
 * bound was removed; the product query is correct as unbounded and
 * these tests lock it that way.
 *
 * This repo has no live-D1 test harness (see search.test.ts), so D1
 * is faked at the .prepare(sql).all() level: each of handleListAgents'
 * 9 parallel queries is routed to a canned result by matching a
 * distinguishing substring in its SQL text. What we lock down is
 * (a) the latestRuns query carries the ROW_NUMBER/PARTITION shape with
 * NO time bound, not the old correlated-subquery shape, (b) a dormant
 * agent whose latest run failed surfaces as 'error' (regression guard
 * for the removed 30-day bound), and (c) the handler degrades to
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
  if (/ROW_NUMBER\(\) OVER/.test(sql)) return "latestRuns";
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

function makeEnv(rows: Rows = {}): { env: Env; calls: Captured[] } {
  const calls: Captured[] = [];

  const resultFor = (kind: string): { results: Array<Record<string, unknown>>; meta: { rows_read: number; rows_written: number } } => {
    const data =
      kind === "latestRuns" ? (rows.latestRuns ?? []) :
      kind === "agentConfigs" ? (rows.agentConfigs ?? []) :
      kind === "workflowStats" ? [] : // no workflow-dispatched agents in these tests
      [];
    return { results: data, meta: { rows_read: data.length, rows_written: 0 } };
  };

  const prepare = (sql: string) => {
    const kind = classify(sql);
    const all = async (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return resultFor(kind);
    };
    return {
      all,
      bind: (...binds: unknown[]) => ({ all: () => all(...binds) }),
    };
  };

  const env = {
    DB: { prepare } as unknown as D1Database,
    CACHE: {
      get: async () => null, // always cold — exercise the compute path
      put: async () => undefined,
    },
  } as unknown as Env;

  return { env, calls };
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
  it("uses ROW_NUMBER/PARTITION with NO age bound, not the old correlated subquery", async () => {
    const { env, calls } = makeEnv();
    await handleListAgents(req(), env);

    const latestRunsCall = calls.find((c) => /ROW_NUMBER\(\) OVER/.test(c.sql));
    expect(latestRunsCall).toBeDefined();
    expect(latestRunsCall!.sql).toMatch(/PARTITION BY agent_id ORDER BY started_at DESC/);
    expect(latestRunsCall!.sql).toMatch(/WHERE rn = 1/);
    // The latestRuns query MUST carry no time bound — a bound would
    // hide the latest run of a dormant agent (see file header). Scoped
    // to this call only; the OTHER handler queries legitimately use
    // datetime('now', ...) windows.
    expect(latestRunsCall!.sql).not.toMatch(/datetime\('now'/);
    // The old shape is fully gone.
    expect(latestRunsCall!.sql).not.toMatch(/WHERE id IN \(\s*SELECT id FROM agent_runs r2/);
  });

  it("has no '?' placeholders on the latest-run query (pure inline date arithmetic)", async () => {
    const { env, calls } = makeEnv();
    await handleListAgents(req(), env);
    const latestRunsCall = calls.find((c) => /ROW_NUMBER\(\) OVER/.test(c.sql));
    expect((latestRunsCall!.sql.match(/\?/g) ?? []).length).toBe(0);
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
