/**
 * Tests for `agent_mesh.paused[]` (fetchPausedAgents).
 *
 * Background: `agent_mesh.per_agent` is a GROUP BY over agent_runs in the
 * window. An agent whose circuit breaker tripped (agent_configs.enabled = 0)
 * is skipped by executeAgent and writes no runs, so it vanished from
 * diagnostics — strategist / sparrow / attributor sat paused for weeks with
 * no hint. fetchPausedAgents reads the breaker state directly.
 *
 * What we verify:
 *   1. Only enabled = 0 rows are reported, with every breaker field.
 *   2. hours_paused is computed from SQLite UTC text (no zone suffix).
 *   3. last_error is the newest NON-NULL error among the bounded recent runs,
 *      truncated to 500 chars; null when no recent run carried one.
 *   4. The run lookup is bounded: per-agent agent_id = ? point lookup with
 *      ORDER BY started_at DESC LIMIT ? (index seek), issued as ONE batch.
 *   5. No paused agents → no agent_runs query at all.
 *   6. A failed paused read degrades to `paused: []` + `paused_error` (and
 *      `paused_count: null`) instead of 500-ing the whole endpoint.
 */

import { describe, it, expect } from "vitest";
import {
  fetchPausedAgents,
  fetchPausedAgentsSafe,
  handlePlatformDiagnostics,
  PAUSED_AGENT_RECENT_RUNS,
} from "../src/handlers/diagnostics";
import type { Env } from "../src/types";

interface ConfigRow {
  agent_id: string;
  enabled: number;
  paused_reason: string | null;
  paused_at: string | null;
  paused_after_n_failures: number | null;
  consecutive_failures: number;
}
interface RunRow {
  agent_id: string;
  started_at: string;
  error_message: string | null;
}

function makeDb(configs: ConfigRow[], runs: RunRow[]) {
  const sqls: string[] = [];
  let batchCalls = 0;
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      return {
        bind(...args: unknown[]) {
          return {
            sql,
            args,
            all: async () => {
              if (/FROM\s+agent_configs/i.test(sql)) {
                const limit = args[0] as number;
                const results = configs
                  .filter((c) => c.enabled === 0)
                  .sort((a, b) => (a.paused_at ?? "").localeCompare(b.paused_at ?? ""))
                  .slice(0, limit)
                  .map(({ enabled: _e, ...rest }) => rest);
                return { results };
              }
              throw new Error(`unexpected .all() for ${sql}`);
            },
          };
        },
      };
    },
    async batch(stmts: Array<{ sql: string; args: unknown[] }>) {
      batchCalls++;
      return stmts.map((s) => {
        const [agentId, limit] = s.args as [string, number];
        const results = runs
          .filter((r) => r.agent_id === agentId)
          .sort((a, b) => b.started_at.localeCompare(a.started_at))
          .slice(0, limit)
          .map((r) => ({ error_message: r.error_message, started_at: r.started_at }));
        return { results };
      });
    },
  } as unknown as D1Database;
  return { db, sqls, batchCalls: () => batchCalls };
}

const NOW = Date.parse("2026-10-21T12:00:00Z");

describe("fetchPausedAgents", () => {
  it("reports only enabled = 0 agents with breaker state, hours_paused and last_error", async () => {
    const { db, sqls, batchCalls } = makeDb(
      [
        { agent_id: "analyst", enabled: 1, paused_reason: null, paused_at: null, paused_after_n_failures: null, consecutive_failures: 0 },
        { agent_id: "strategist", enabled: 0, paused_reason: "auto:consecutive_failures", paused_at: "2026-10-02 12:00:00", paused_after_n_failures: 3, consecutive_failures: 3 },
        { agent_id: "sparrow", enabled: 0, paused_reason: "manual", paused_at: "2026-10-21 06:00:00", paused_after_n_failures: null, consecutive_failures: 0 },
      ],
      [
        { agent_id: "strategist", started_at: "2026-10-02 11:00:00", error_message: "older error" },
        { agent_id: "strategist", started_at: "2026-10-02 11:50:00", error_message: "D1_ERROR: timeout" },
        // Newest run has no error — must be skipped in favour of the newest non-null.
        { agent_id: "strategist", started_at: "2026-10-02 11:55:00", error_message: null },
        { agent_id: "sparrow", started_at: "2026-10-20 00:00:00", error_message: null },
        { agent_id: "analyst", started_at: "2026-10-21 11:00:00", error_message: "not paused, ignored" },
      ],
    );

    const out = await fetchPausedAgents(db, NOW);
    expect(out.map((a) => a.agent_id)).toEqual(["strategist", "sparrow"]);

    const strategist = out[0]!;
    expect(strategist).toEqual({
      agent_id: "strategist",
      paused_reason: "auto:consecutive_failures",
      paused_at: "2026-10-02 12:00:00",
      paused_after_n_failures: 3,
      consecutive_failures: 3,
      hours_paused: 19 * 24,
      last_error: "D1_ERROR: timeout",
      last_error_at: "2026-10-02 11:50:00",
    });

    const sparrow = out[1]!;
    expect(sparrow.paused_reason).toBe("manual");
    expect(sparrow.hours_paused).toBe(6);
    expect(sparrow.last_error).toBeNull();
    expect(sparrow.last_error_at).toBeNull();

    // Bounded lookup: one batch, per-agent seek on (agent_id, started_at DESC).
    expect(batchCalls()).toBe(1);
    const runSql = sqls.find((s) => /FROM\s+agent_runs/i.test(s))!;
    expect(runSql).toMatch(/WHERE\s+agent_id\s*=\s*\?/i);
    expect(runSql).toMatch(/ORDER BY\s+started_at\s+DESC/i);
    expect(runSql).toMatch(/LIMIT\s+\?/i);
    expect(runSql).not.toMatch(/GROUP BY/i);
    expect(PAUSED_AGENT_RECENT_RUNS).toBeLessThanOrEqual(50);
  });

  it("only looks for last_error within the recent-run bound and truncates it", async () => {
    const runs: RunRow[] = [
      // Error older than the bound — must NOT be reported.
      { agent_id: "attributor", started_at: "2026-07-01 00:00:00", error_message: "ancient" },
    ];
    for (let i = 0; i < PAUSED_AGENT_RECENT_RUNS; i++) {
      runs.push({ agent_id: "attributor", started_at: `2026-07-20 ${String(i).padStart(2, "0")}:00:00`, error_message: null });
    }
    const { db } = makeDb(
      [{ agent_id: "attributor", enabled: 0, paused_reason: "auto:consecutive_failures", paused_at: "2026-07-21 00:00:00", paused_after_n_failures: 3, consecutive_failures: 3 }],
      runs,
    );
    const [a] = await fetchPausedAgents(db, NOW);
    expect(a!.last_error).toBeNull();

    const long = "x".repeat(900);
    const { db: db2 } = makeDb(
      [{ agent_id: "attributor", enabled: 0, paused_reason: "auto:consecutive_failures", paused_at: null, paused_after_n_failures: 3, consecutive_failures: 3 }],
      [{ agent_id: "attributor", started_at: "2026-07-20 23:00:00", error_message: long }],
    );
    const [b] = await fetchPausedAgents(db2, NOW);
    expect(b!.last_error).toHaveLength(500);
    expect(b!.hours_paused).toBeNull(); // paused_at missing
  });

  it("issues no agent_runs query when nothing is paused", async () => {
    const { db, sqls, batchCalls } = makeDb(
      [{ agent_id: "analyst", enabled: 1, paused_reason: null, paused_at: null, paused_after_n_failures: null, consecutive_failures: 0 }],
      [],
    );
    expect(await fetchPausedAgents(db, NOW)).toEqual([]);
    expect(batchCalls()).toBe(0);
    expect(sqls.some((s) => /FROM\s+agent_runs/i.test(s))).toBe(false);
  });
});

describe("paused read failure degrades instead of failing the endpoint", () => {
  const failingConfigsDb = (inner: () => D1Database) => {
    const base = inner();
    return {
      ...base,
      prepare(sql: string) {
        if (/FROM\s+agent_configs/i.test(sql) && /enabled\s*=\s*0/i.test(sql)) {
          throw new Error("D1_ERROR: no such column: paused_after_n_failures");
        }
        return base.prepare(sql);
      },
    } as unknown as D1Database;
  };

  it("fetchPausedAgentsSafe returns paused: [] + paused_error", async () => {
    const db = failingConfigsDb(() => makeDb([], []).db);
    await expect(fetchPausedAgents(db, NOW)).rejects.toThrow(/no such column/);
    expect(await fetchPausedAgentsSafe(db, NOW)).toEqual({
      paused: [],
      paused_error: "D1_ERROR: no such column: paused_after_n_failures",
    });
  });

  it("fetchPausedAgentsSafe passes rows through with paused_error null", async () => {
    const { db } = makeDb(
      [{ agent_id: "sparrow", enabled: 0, paused_reason: "manual", paused_at: "2026-10-21 06:00:00", paused_after_n_failures: null, consecutive_failures: 0 }],
      [],
    );
    const out = await fetchPausedAgentsSafe(db, NOW);
    expect(out.paused_error).toBeNull();
    expect(out.paused.map((a) => a.agent_id)).toEqual(["sparrow"]);
  });

  it("handlePlatformDiagnostics still returns 200 with paused_error when the paused read fails", async () => {
    // Every other query answers empty; only the paused agent_configs read throws.
    const empty = (): D1PreparedStatement => {
      const stmt = {
        bind: () => stmt,
        all: async () => ({ results: [], success: true, meta: {} }),
        first: async () => null,
        run: async () => ({ results: [], success: true, meta: { changes: 0 } }),
        raw: async () => [],
      };
      return stmt as unknown as D1PreparedStatement;
    };
    const db = {
      prepare(sql: string) {
        if (/FROM\s+agent_configs/i.test(sql) && /enabled\s*=\s*0/i.test(sql)) {
          throw new Error("D1_ERROR: simulated paused read failure");
        }
        return empty();
      },
      batch: async (stmts: unknown[]) => stmts.map(() => ({ results: [], success: true, meta: {} })),
    } as unknown as D1Database;
    const kv = { get: async () => null, put: async () => undefined, delete: async () => undefined };
    const env = { DB: db, CACHE: kv } as unknown as Env;

    const res = await handlePlatformDiagnostics(
      new Request("https://averrow.test/api/internal/platform-diagnostics?hours=6"),
      env,
    );
    const body = (await res.json()) as {
      success: boolean;
      data: { agent_mesh: { paused: unknown[]; paused_error?: string; summary: { paused_count: number | null } } };
    };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.agent_mesh.paused).toEqual([]);
    expect(body.data.agent_mesh.paused_error).toBe("D1_ERROR: simulated paused read failure");
    expect(body.data.agent_mesh.summary.paused_count).toBeNull();
  });
});
