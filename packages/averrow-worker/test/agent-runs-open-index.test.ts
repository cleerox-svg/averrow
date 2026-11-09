// Pins: the two agent_runs reads that used to read the whole table
// (~132.7K rows/call on prod 2026-11-08) now seek an index.
//
//   1. Navigator's orphan reaper (lib/agent-runs-reaper.ts, every 5 min)
//      seeks the partial open-runs index idx_agent_runs_open (migration
//      0320) through a plain started_at range, and returns EXACTLY the rows
//      the old datetime()-only predicate returned, for both stored
//      started_at formats (SQLite text and ISO).
//   2. /api/admin/pipeline-status's last-run-per-agent read seeks
//      idx_agent_runs_completed (migration 0321) with unchanged results.
//
// SQL is extracted from source (sqlContaining), so a reworded query changes
// what is tested instead of silently falling out of coverage.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, sqlContaining, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";

const SRC = resolve(__dirname, "..", "src");
const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");

const REAPER_SQL = sqlContaining(read("lib/agent-runs-reaper.ts"), [
  "FROM agent_runs INDEXED BY idx_agent_runs_open",
]);
const PIPELINE_SQL = sqlContaining(read("handlers/admin/pipeline.ts"), [
  "FROM agent_runs",
  "MAX(completed_at) AS last_run_at",
]);

const plan = (raw: SqliteDb, sql: string): string =>
  (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");

/** The pre-0320 reaper predicate: no INDEXED BY, no plain-range term. */
function legacyReaperSql(sql: string): string {
  const range = /\s+AND started_at <= [^\n]+/;
  if (!range.test(sql)) throw new Error("range term not found in reaper SQL");
  return sql.replace(" INDEXED BY idx_agent_runs_open", "").replace(range, "");
}

/** Freeze 'now' so the exact 15-minute boundary is deterministic. */
const NOW = "2026-11-08 12:00:00";
const frozen = (sql: string): string => sql.replace(/'now'/g, `'${NOW}'`);

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe.skipIf(!hasSqlite())("idx_agent_runs_open (migration 0320)", () => {
  it("is defined by 0320 with the reaper's exact open-run predicate", () => {
    const ddl = liveIndexDdl("agent_runs").get("idx_agent_runs_open");
    expect(ddl).toBeDefined();
    expect(norm(ddl!)).toContain("ON agent_runs(started_at) WHERE completed_at IS NULL AND status IN ('partial', 'running')");
    // The query must carry both index-WHERE terms or SQLite can't use a partial index.
    expect(REAPER_SQL).toContain("status IN ('partial', 'running')");
    expect(REAPER_SQL).toContain("completed_at IS NULL");
  });

  it("the reaper SELECT seeks the open-runs index, never scans agent_runs", () => {
    const p = plan(openMigratedDb(), REAPER_SQL);
    expect(p).toMatch(/SEARCH agent_runs USING INDEX idx_agent_runs_open \(started_at<\?\)/);
    expect(p).not.toMatch(/SCAN agent_runs/);
  });

  it("returns exactly the legacy rows for SQLite-text and ISO started_at", () => {
    const db = openMigratedDb();
    const ins = db.prepare(
      "INSERT INTO agent_runs (id, agent_id, started_at, status, completed_at) VALUES (?, ?, ?, ?, ?)",
    );
    // Offsets from NOW in seconds; 900 = the exact 15-minute boundary.
    const offsets = [0, 60, 899, 900, 901, 960, 3600, 86_400, 86_400 * 9];
    const base = Date.parse(NOW.replace(" ", "T") + "Z");
    const fmt = (secAgo: number, kind: "sqlite" | "iso" | "iso_ms" | "iso_no_z") => {
      const iso = new Date(base - secAgo * 1000).toISOString(); // ...T..:..:..sssZ
      switch (kind) {
        case "sqlite": return iso.slice(0, 19).replace("T", " ");
        case "iso": return iso.slice(0, 19) + "Z";
        case "iso_ms": return iso.slice(0, 19) + ".742Z";
        case "iso_no_z": return iso.slice(0, 19);
      }
    };
    let n = 0;
    for (const off of offsets) {
      for (const kind of ["sqlite", "iso", "iso_ms", "iso_no_z"] as const) {
        for (const [status, completed] of [
          ["partial", null], ["running", null], ["partial", NOW], ["success", null], ["failed", NOW],
        ] as const) {
          ins.run(`r${n++}`, "sentinel", fmt(off, kind), status, completed);
        }
      }
    }
    const ids = (sql: string) =>
      (db.prepare(frozen(sql)).all() as Array<{ id: string }>).map((r) => r.id).sort();
    const now = ids(REAPER_SQL);
    const legacy = ids(legacyReaperSql(REAPER_SQL));
    expect(now).toEqual(legacy);
    // Sanity: the fixture straddles the boundary (some in, some out).
    expect(now.length).toBeGreaterThan(0);
    expect(now.length).toBeLessThan(offsets.length * 4 * 2);
  });
});

describe.skipIf(!hasSqlite())("idx_agent_runs_completed (migration 0321)", () => {
  it("is defined by 0321", () => {
    expect(liveIndexDdl("agent_runs").get("idx_agent_runs_completed")).toBeDefined();
  });

  it("pipeline-status last-run read seeks completed_at, not a full walk", () => {
    const p = plan(openMigratedDb(), PIPELINE_SQL);
    expect(p).toMatch(/SEARCH agent_runs USING INDEX idx_agent_runs_completed \(completed_at>\?\)/);
    expect(p).not.toMatch(/SCAN agent_runs/);
  });

  it("GROUP BY +agent_id returns the same per-agent rows as GROUP BY agent_id", () => {
    const db = openMigratedDb();
    const ins = db.prepare(
      "INSERT INTO agent_runs (id, agent_id, started_at, completed_at, status, records_processed, duration_ms) VALUES (?, ?, ?, datetime('now', ?), ?, ?, ?)",
    );
    let n = 0;
    for (const agent of ["sentinel", "analyst", "navigator"]) {
      for (const [ago, status] of [["-1 hours", "success"], ["-3 hours", "failed"], ["-30 hours", "success"]] as const) {
        ins.run(`p${n}`, agent, "2026-11-01 00:00:00", ago, status, n, n * 10);
        n++;
      }
    }
    const rows = (sql: string) =>
      (db.prepare(sql).all() as Array<{ agent_id: string }>).sort((a, b) => a.agent_id.localeCompare(b.agent_id));
    const legacy = PIPELINE_SQL.replace("GROUP BY +agent_id", "GROUP BY agent_id");
    expect(legacy).not.toBe(PIPELINE_SQL);
    expect(rows(PIPELINE_SQL)).toEqual(rows(legacy));
    expect(rows(PIPELINE_SQL)).toHaveLength(3);
  });
});
