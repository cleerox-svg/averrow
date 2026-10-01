/**
 * Public /status agent-uptime accounting.
 *
 * `lib/platform-status.ts` feeds the UNAUTHENTICATED status page, so what
 * it counts as a failed agent run is a customer-facing availability claim.
 * Two things make that accounting subtle, and both were wrong:
 *
 *  1. `agent_runs.status = 'partial'` is NOT a failure. Only 'failed'
 *     means the agent threw. 'partial' is a COMPLETED run that did useful
 *     work in a degraded mode — held pending approval, or (since the
 *     AI-outage work) an agent whose Anthropic calls all failed and which
 *     fell through to its rule-based path. Counting it as a failure routes
 *     an INTERNAL AI outage onto the public page through the back door:
 *     analyst + sentinel + cartographer finalizing 'partial' hourly drag
 *     this category under the 'degraded' threshold. The whole reason
 *     `platform_ai_calls_failing` is severity 'high' and not 'critical' is
 *     to keep it off this page.
 *
 *  2. In-flight runs must not be in the denominator. agentRunner SEEDS
 *     every run as `status='partial', completed_at NULL` and only stamps a
 *     terminal status when execute() returns — so every currently-running
 *     agent was being counted as a failure. That was a pre-existing
 *     undercount, independent of (1).
 *
 * Tested through the real SQL extracted from source (not a retyped copy)
 * against real node:sqlite with the schema derived from migrations/, so a
 * phantom column or a reworded query is a failure rather than silently
 * dropping out of coverage.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  hasSqlite, openDerivedDb, sqlContaining, sqliteTimestampHoursAgo,
  type SqliteDb,
} from "./sqlite-d1-harness";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/lib/platform-status.ts", import.meta.url)),
  "utf8",
);

// Markers must distinguish the AGENT uptime queries from the PROCESSING
// (cron-writes) queries in the same file, which also read agent_runs over
// the same windows but count per-agent_id cron rows rather than
// success/failure. `AS successes` is unique to the two under test.
const REALTIME_SQL = sqlContaining(SRC, ["FROM agent_runs", "-6 hours", "AS successes"]);
const DAILY_SQL = sqlContaining(SRC, ["FROM agent_runs", "date(started_at) AS day", "AS successes"]);

describe.skipIf(!hasSqlite())("public /status agent uptime (real SQLite)", () => {
  let raw: SqliteDb;

  beforeEach(() => {
    raw = openDerivedDb(["agent_runs"]);
  });

  /** One agent_runs row. completed_at null = still in flight. */
  const run = (
    agentId: string,
    status: string,
    opts: { hoursAgo?: number; completed?: boolean } = {},
  ): void => {
    const started = sqliteTimestampHoursAgo(opts.hoursAgo ?? 1);
    raw.prepare(
      `INSERT INTO agent_runs (id, agent_id, started_at, completed_at, status, records_processed, outputs_generated)
       VALUES (?, ?, ?, ?, ?, 0, 0)`,
    ).run(`r-${Math.random()}`, agentId, started, opts.completed === false ? null : started, status);
  };

  const realtime = (): { total: number; successes: number } => {
    const r = raw.prepare(REALTIME_SQL).all() as Array<{ total: number; successes: number }>;
    return { total: r[0]?.total ?? 0, successes: r[0]?.successes ?? 0 };
  };

  const daily = (): Array<{ day: string; total_runs: number; successes: number }> =>
    raw.prepare(DAILY_SQL).all(sqliteTimestampHoursAgo(72).slice(0, 10)) as Array<{
      day: string; total_runs: number; successes: number;
    }>;

  // ── (1) 'partial' is a success ──────────────────────────────────────
  it("realtime: a COMPLETED 'partial' counts as a success, not a failure", () => {
    run("analyst", "partial");
    run("sentinel", "partial");
    run("cartographer", "success");

    expect(realtime()).toEqual({ total: 3, successes: 3 });
  });

  it("realtime: an hourly AI outage does NOT drag the public page off 100%", () => {
    // The exact regression: three instrumented agents degrade every hour
    // for 6h while everything else is fine. 18 'partial' + 6 'success'
    // used to read as 6/24 = 25% uptime → "outage" on the public page.
    for (let h = 1; h <= 6; h++) {
      run("analyst", "partial", { hoursAgo: h - 0.5 });
      run("sentinel", "partial", { hoursAgo: h - 0.5 });
      run("cartographer", "partial", { hoursAgo: h - 0.5 });
      run("navigator", "success", { hoursAgo: h - 0.5 });
    }

    const { total, successes } = realtime();
    expect(total).toBe(24);
    expect((successes / total) * 100).toBe(100);
  });

  it("realtime: 'failed' IS still a failure — the fix must not whitewash real crashes", () => {
    run("analyst", "failed");
    run("sentinel", "success");
    run("cartographer", "partial");

    expect(realtime()).toEqual({ total: 3, successes: 2 });
  });

  it("realtime: a reaped orphan (status 'failed', completed_at stamped) counts against uptime", () => {
    // The navigator reaper converts killed 'partial'/NULL rows to
    // 'failed' with completed_at set. Those are known-dead and belong in
    // the denominator — the exclusion below is only for runs still in
    // doubt.
    run("nexus", "failed", { hoursAgo: 2 });

    expect(realtime()).toEqual({ total: 1, successes: 0 });
  });

  // ── (2) in-flight rows are excluded ─────────────────────────────────
  it("realtime: an IN-FLIGHT run (seeded 'partial', completed_at NULL) is excluded from the denominator", () => {
    run("analyst", "success");
    run("cartographer", "partial", { completed: false }); // still executing

    expect(realtime()).toEqual({ total: 1, successes: 1 });
  });

  it("realtime: a page with ONLY in-flight runs reports no completed runs rather than a 0% outage", () => {
    run("analyst", "partial", { completed: false });
    run("sentinel", "partial", { completed: false });

    expect(realtime()).toEqual({ total: 0, successes: 0 });
  });

  it("realtime: a 'running' row with no completed_at is excluded too", () => {
    run("analyst", "success");
    run("nexus", "running", { completed: false });

    expect(realtime()).toEqual({ total: 1, successes: 1 });
  });

  it("realtime: the 6h window still bounds the query", () => {
    run("analyst", "success", { hoursAgo: 1 });
    run("analyst", "failed", { hoursAgo: 7 });

    expect(realtime()).toEqual({ total: 1, successes: 1 });
  });

  // ── the daily series carries the same two rules ──────────────────────
  it("daily: 'partial' counts as a success and in-flight rows are excluded", () => {
    run("analyst", "partial", { hoursAgo: 2 });
    run("sentinel", "success", { hoursAgo: 2 });
    run("cartographer", "failed", { hoursAgo: 2 });
    run("nexus", "partial", { hoursAgo: 2, completed: false });

    const days = daily();
    const totals = days.reduce(
      (a, d) => ({ total: a.total + d.total_runs, successes: a.successes + d.successes }),
      { total: 0, successes: 0 },
    );
    expect(totals).toEqual({ total: 3, successes: 2 });
  });

  it("both queries filter on completed_at — pinned statically so a rewrite cannot drop it", () => {
    expect(REALTIME_SQL).toMatch(/completed_at IS NOT NULL/);
    expect(DAILY_SQL).toMatch(/completed_at IS NOT NULL/);
    expect(REALTIME_SQL).toMatch(/status IN \('success', 'partial'\)/);
    expect(DAILY_SQL).toMatch(/status IN \('success', 'partial'\)/);
  });
});
