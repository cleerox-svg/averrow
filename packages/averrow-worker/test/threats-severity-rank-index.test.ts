// Pin: migration 0318's expression index serves the default threats-list
// sort (handlers/threats.ts handleListThreats, `sort=severity&dir=desc`, no
// filter) without a full-table sort. Before 0318 that page load scanned and
// sorted the whole threats table (~5.4M rows read/call) and, stacked on the
// Threats aggregate burst, tripped `D1 DB is overloaded` on prod 2026-11-08.
//
// Runs the SQL extracted from source against the migration-derived threats
// shape + the live index set from migrations/.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";

const SRC = resolve(__dirname, "..", "src");
const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");

const SEVERITY_SORT = /severity:\s*"(CASE t\.severity [^"]+ END)"/;

function sortExpr(file: string): string {
  const m = read(file).match(SEVERITY_SORT);
  if (!m) throw new Error(`severity sort expression not found in ${file}`);
  return m[1];
}

function openThreats(): SqliteDb {
  const raw = openDerivedDb(["threats"]);
  for (const ddl of liveIndexDdl("threats").values()) raw.exec(ddl);
  return raw;
}

const plan = (raw: SqliteDb, sql: string, ...binds: unknown[]): string =>
  (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");

const listSql = (expr: string, dir: "ASC" | "DESC", where = "") =>
  `SELECT t.id FROM threats t ${where} ORDER BY ${expr} ${dir}, t.created_at DESC LIMIT ? OFFSET ?`;

describe.skipIf(!hasSqlite())("idx_threats_severity_rank_created (migration 0318)", () => {
  it("is defined by 0318 and survives replay", () => {
    expect(liveIndexDdl("threats").get("idx_threats_severity_rank_created")).toBeDefined();
  });

  it("ops and tenant severity sorts are the exact expression the index stores", () => {
    const ddl = liveIndexDdl("threats").get("idx_threats_severity_rank_created")!.replace(/\s+/g, " ");
    for (const file of ["handlers/threats.ts", "handlers/tenantData.ts"]) {
      const indexed = sortExpr(file).replace(/t\.severity/, "severity");
      expect(ddl).toContain(`(${indexed})`);
    }
  });

  it("the default unfiltered list walks the index with no full-table sort", () => {
    const p = plan(openThreats(), listSql(sortExpr("handlers/threats.ts"), "DESC"), 50, 0);
    expect(p).toContain("idx_threats_severity_rank_created");
    expect(p).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
  });

  it("still picks the index under prod-like planner stats", () => {
    const raw = openThreats();
    raw.exec("ANALYZE");
    raw.exec("DELETE FROM sqlite_stat1");
    const ins = raw.prepare("INSERT INTO sqlite_stat1(tbl, idx, stat) VALUES ('threats', ?, ?)");
    ins.run(null, "1500000");
    ins.run("idx_threats_severity_rank_created", "1500000 300000 2");
    ins.run("idx_threats_created_at", "1500000 2");
    raw.exec("ANALYZE sqlite_schema");
    const p = plan(raw, listSql(sortExpr("handlers/threats.ts"), "DESC"), 50, 0);
    expect(p).toContain("idx_threats_severity_rank_created");
    expect(p).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
  });
});
