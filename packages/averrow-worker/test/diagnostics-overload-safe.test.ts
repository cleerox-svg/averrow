/**
 * platform-diagnostics overload safety (D1 overload, prod 2026-11-08).
 *
 * GET /api/internal/platform-diagnostics failed 5/5 with `D1 DB is
 * overloaded` because one call fired ~40 main-DB reads at once, several of
 * them full scans (threats, agent_runs, alerts, brands …). Pinned here:
 *
 *   1. softSection / runSequential (lib/run-sequential.ts) semantics.
 *   2. The handler never has more than one main-DB read in flight.
 *   3. A failing read degrades its own section and reports
 *      `<section>_error`; the endpoint still answers 200.
 *   4. The whole-table sections (enrichment_pipeline, platform_totals,
 *      alerts.by_tier) are KV-cached: a second call does not re-scan.
 *   5. Windowed reads seek an index (real SQLite, migration-derived schema
 *      incl. 0319) instead of walking the table, and the sargable started_at
 *      range returns exactly what the old datetime()-only filter did, for
 *      both stored timestamp formats.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSequential, softSection, type SectionErrors } from "../src/lib/run-sequential";
import { handlePlatformDiagnostics } from "../src/handlers/diagnostics";
import { hasSqlite, openMigratedDb, fakeKv, sqlContaining, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const DIAG_SRC = readFileSync(resolve(__dirname, "..", "src", "handlers", "diagnostics.ts"), "utf8");

// ── lib/run-sequential ──────────────────────────────────────────────

describe("softSection", () => {
  it("passes a successful value through and records nothing", async () => {
    const errors: SectionErrors = {};
    expect(await softSection(errors, "feeds", [], async () => [1, 2])()).toEqual([1, 2]);
    expect(errors).toEqual({});
  });

  it("returns the fallback and records `<section>_error` on a rejection", async () => {
    const errors: SectionErrors = {};
    const out = await softSection(errors, "agent_mesh", { results: [] as number[] }, async () => {
      throw new Error("D1_ERROR: D1 DB is overloaded");
    })();
    expect(out).toEqual({ results: [] });
    expect(errors).toEqual({ agent_mesh_error: "D1_ERROR: D1 DB is overloaded" });
  });

  it("catches a synchronous throw (e.g. from prepare) and joins messages per section", async () => {
    const errors: SectionErrors = {};
    const boom = (msg: string) => () => {
      throw new Error(msg);
    };
    await softSection(errors, "feeds", null, boom("first") as () => Promise<null>)();
    await softSection(errors, "feeds", null, boom("second") as () => Promise<null>)();
    expect(errors).toEqual({ feeds_error: "first; second" });
  });

  it("builds the fallback from the message when given a function", async () => {
    const errors: SectionErrors = {};
    const out = await softSection(errors, "d1_top_queries", (error) => ({ queries: [], error }), async () => {
      throw "plain string";
    })();
    expect(out).toEqual({ queries: [], error: "plain string" });
    expect(errors.d1_top_queries_error).toBe("plain string");
  });
});

describe("runSequential", () => {
  it("never overlaps tasks and keeps result order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const task = (v: number, ms: number) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return v;
    };
    expect(await runSequential([task(1, 5), task(2, 1), task(3, 3)])).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
  });
});

// ── handler: concurrency, fail-soft, caching ────────────────────────

const ENRICHMENT_SCAN = /COUNT\(\*\) AS total_threats/;
const TOTALS_SCAN = /\(SELECT COUNT\(\*\) FROM brands\) AS brands/;
const ALERTS_TIER_SCAN = /FROM alerts a\s+LEFT JOIN brands b/;

/**
 * Stub main DB: every read answers empty after a tick, counts concurrent
 * reads, and throws for any SQL matching `failOn`.
 */
function stubDb(failOn: RegExp[] = []) {
  const executed: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const run = async <T>(sql: string, value: T): Promise<T> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      executed.push(sql);
      if (failOn.some((re) => re.test(sql))) throw new Error(`D1_ERROR: simulated failure`);
      return value;
    } finally {
      inFlight--;
    }
  };
  const stmt = (sql: string): D1PreparedStatement => {
    const s = {
      bind: () => s,
      all: () => run(sql, { results: [], success: true, meta: {} }),
      first: () => run(sql, null),
      run: () => run(sql, { results: [], success: true, meta: { changes: 0 } }),
      raw: async () => [],
    };
    return s as unknown as D1PreparedStatement;
  };
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: (stmts: unknown[]) => run("BATCH", stmts.map(() => ({ results: [], success: true, meta: {} }))),
  } as unknown as D1Database;
  return { db, executed, maxInFlight: () => maxInFlight };
}

async function callDiag(env: Env) {
  const res = await handlePlatformDiagnostics(
    new Request("https://averrow.test/api/internal/platform-diagnostics?hours=6"),
    env,
  );
  return { status: res.status, body: (await res.json()) as { success: boolean; data: Record<string, unknown> } };
}

describe("handlePlatformDiagnostics overload safety", () => {
  it("never has more than one main-DB read in flight", async () => {
    const { db, executed, maxInFlight } = stubDb();
    const { status } = await callDiag({ DB: db, CACHE: fakeKv() } as unknown as Env);
    expect(status).toBe(200);
    expect(executed.length).toBeGreaterThan(20);
    expect(maxInFlight()).toBe(1);
  });

  it("a failing read reports `<section>_error` and keeps every other section", async () => {
    const { db } = stubDb([/GROUP BY \+agent_id\s+ORDER BY agent_id ASC/, ENRICHMENT_SCAN]);
    const { status, body } = await callDiag({ DB: db, CACHE: fakeKv() } as unknown as Env);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown> & {
      agent_mesh: { per_agent: unknown[] };
      enrichment_pipeline: { total_threats: number };
      feeds: { per_feed: unknown[] };
      _meta: { endpoint_version: number };
    };
    expect(data.agent_mesh_error).toBe("D1_ERROR: simulated failure");
    expect(data.enrichment_pipeline_error).toBe("D1_ERROR: simulated failure");
    expect(data.agent_mesh.per_agent).toEqual([]);
    expect(data.enrichment_pipeline.total_threats).toBe(0);
    // Untouched sections are present and report no error.
    expect(data.feeds.per_feed).toEqual([]);
    expect(data.feeds_error).toBeUndefined();
    expect(data._meta.endpoint_version).toBe(17);
  });

  it("serves the whole-table sections from KV on the next call", async () => {
    const kv = fakeKv();
    const first = stubDb();
    await callDiag({ DB: first.db, CACHE: kv } as unknown as Env);
    for (const re of [ENRICHMENT_SCAN, TOTALS_SCAN, ALERTS_TIER_SCAN]) {
      expect(first.executed.filter((s) => re.test(s))).toHaveLength(1);
    }

    const second = stubDb();
    await callDiag({ DB: second.db, CACHE: kv } as unknown as Env);
    for (const re of [ENRICHMENT_SCAN, TOTALS_SCAN, ALERTS_TIER_SCAN]) {
      expect(second.executed.filter((s) => re.test(s))).toHaveLength(0);
    }
    // Live windowed reads still run every call.
    expect(second.executed.some((s) => /FROM agent_runs/.test(s) && /GROUP BY \+agent_id/.test(s))).toBe(true);
  });

  it("does not cache a failed whole-table read", async () => {
    const kv = fakeKv();
    await callDiag({ DB: stubDb([ENRICHMENT_SCAN]).db, CACHE: kv } as unknown as Env);
    const retry = stubDb();
    const { body } = await callDiag({ DB: retry.db, CACHE: kv } as unknown as Env);
    expect(retry.executed.filter((s) => ENRICHMENT_SCAN.test(s))).toHaveLength(1);
    expect(body.data.enrichment_pipeline_error).toBeUndefined();
  });
});

// ── real SQLite: plans + window semantics ───────────────────────────

const AGENT_MESH_SQL = sqlContaining(DIAG_SRC, ["FROM agent_runs", "killed_runs", "GROUP BY +agent_id"]);
const CRON_HEALTH_SQL = sqlContaining(DIAG_SRC, ["FROM agent_runs", "'navigator', 'fast_tick'", "not_success"]);
const FEED_HEALTH_SQL = sqlContaining(DIAG_SRC, ["FROM feed_pull_history fph", "total_rejected"]);
const FEED_ERRORS_SQL = sqlContaining(DIAG_SRC, ["FROM feed_pull_history", "+status = 'failed'"]);
const WORKFLOW_MESH_SQL = sqlContaining(DIAG_SRC, ["FROM agent_activity_log a", "cooldown_skipped"]);
const AI_HEALTH_SQL = sqlContaining(DIAG_SRC, ["FROM agent_outputs", "$.aiCallsSkipped", "GROUP BY +agent_id"]);
const AI_SPEND_SQL = sqlContaining(DIAG_SRC, ["FROM budget_ledger", "ROUND(SUM(cost_usd), 4)"]);
const PLATFORM_ALERTS_SQL = sqlContaining(DIAG_SRC, ["FROM notifications", "type LIKE 'platform_%'"]);

const plan = (raw: SqliteDb, sql: string, ...binds: unknown[]): string =>
  (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");

describe.skipIf(!hasSqlite())("diagnostics windowed reads seek an index", () => {
  const raw = (): SqliteDb => openMigratedDb();

  it("agent_mesh seeks idx_agent_runs_started (migration 0319)", () => {
    const p = plan(raw(), AGENT_MESH_SQL, 6, 6);
    expect(p).toMatch(/SEARCH agent_runs USING INDEX idx_agent_runs_started \(started_at>\?\)/);
    expect(p).not.toMatch(/SCAN agent_runs/);
  });

  it("cron_health seeks (agent_id, started_at)", () => {
    expect(plan(raw(), CRON_HEALTH_SQL, 6, 6))
      .toMatch(/SEARCH agent_runs USING (COVERING )?INDEX idx_agent_runs_agent \(agent_id=\? AND started_at>\?\)/);
  });

  it("feeds per_feed and recent_errors seek idx_feed_pulls_started (migration 0319)", () => {
    const db = raw();
    const health = plan(db, FEED_HEALTH_SQL, 6, 6);
    expect(health).toMatch(/SEARCH fph USING INDEX idx_feed_pulls_started \(started_at>\?\)/);
    expect(health).not.toMatch(/SCAN fph/);
    const errors = plan(db, FEED_ERRORS_SQL, 6, 6);
    expect(errors).toMatch(/SEARCH feed_pull_history USING INDEX idx_feed_pulls_started \(started_at>\?\)/);
  });

  it("workflow mesh, ai_health, ai_spend and platform alerts seek their time/prefix index", () => {
    const db = raw();
    expect(plan(db, WORKFLOW_MESH_SQL, 6, 6)).toMatch(/SEARCH a USING INDEX idx_activity_recent \(created_at>\?\)/);
    expect(plan(db, AI_HEALTH_SQL, 6)).toMatch(/SEARCH agent_outputs USING INDEX idx_agent_outputs_created_at \(created_at>\?\)/);
    expect(plan(db, AI_SPEND_SQL)).toMatch(/SEARCH budget_ledger USING INDEX idx_ledger_month \(created_at>\?\)/);
    expect(plan(db, PLATFORM_ALERTS_SQL, 6)).toMatch(/SEARCH notifications USING INDEX idx_notifications_dedup \(type>\? AND type<\?\)/);
  });
});

describe.skipIf(!hasSqlite())("sargable started_at window == the old datetime() window", () => {
  /** The pre-fix predicate: drop the plain-range term the fix added. */
  const exactOnly = (sql: string, col: string): string => {
    const term = new RegExp(`${col.replace(".", "\\.")} >= datetime\\('now', '-' \\|\\| \\? \\|\\| ' hours'\\)\\s+AND `);
    if (!term.test(sql)) throw new Error("range term not found");
    return sql.replace(term, "");
  };
  const at = (minutesAgo: number, iso: boolean): string => {
    const d = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    return iso ? d : d.slice(0, 19).replace("T", " ");
  };

  it("agent_mesh: same groups and counts for SQLite-text and ISO timestamps", () => {
    const db = openMigratedDb();
    const ins = db.prepare(
      "INSERT INTO agent_runs (id, agent_id, started_at, status) VALUES (?, ?, ?, 'success')",
    );
    let n = 0;
    // Around a 6h boundary, both formats, plus rows days old.
    for (const minutesAgo of [5, 120, 355, 359, 361, 365, 600, 60 * 30, 60 * 24 * 3]) {
      ins.run(`r${n++}`, "navigator", at(minutesAgo, false));
      ins.run(`r${n++}`, "nexus", at(minutesAgo, true));
    }
    const fixed = db.prepare(AGENT_MESH_SQL).all(6, 6);
    const exact = db.prepare(exactOnly(AGENT_MESH_SQL, "started_at")).all(6);
    expect(fixed).toEqual(exact);
    expect((fixed as Array<{ agent_id: string; total_runs: number }>).map((r) => [r.agent_id, r.total_runs]))
      .toEqual([["navigator", 4], ["nexus", 4]]);
  });

  it("feeds per_feed: same result for ISO started_at (what feedRunner writes)", () => {
    const db = openMigratedDb();
    const ins = db.prepare(
      "INSERT INTO feed_pull_history (id, feed_name, started_at, status) VALUES (?, 'urlhaus', ?, 'success')",
    );
    let n = 0;
    for (const minutesAgo of [1, 200, 359, 361, 60 * 20, 60 * 24 * 2]) ins.run(`p${n++}`, at(minutesAgo, true));
    const fixed = db.prepare(FEED_HEALTH_SQL).all(6, 6);
    const exact = db.prepare(exactOnly(FEED_HEALTH_SQL, "fph.started_at")).all(6);
    expect(fixed).toEqual(exact);
    expect((fixed as Array<{ total_pulls: number }>)[0]!.total_pulls).toBe(3);
  });
});
