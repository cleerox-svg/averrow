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

/**
 * The handler's FULL joined list SQL (5 LEFT JOINs + the tai GROUP BY
 * subquery) — the first `session.prepare` template in handleListThreats —
 * with the template holes filled for the default page load.
 */
function fullListSql(dir: "ASC" | "DESC" = "DESC"): string {
  const src = read("handlers/threats.ts");
  const start = src.indexOf("rows = await session.prepare(\n        `");
  if (start < 0) throw new Error("joined list SQL not found in handlers/threats.ts");
  const open = src.indexOf("`", start) + 1;
  const sql = src.slice(open, src.indexOf("`", open));
  if (!/LEFT JOIN threat_actors ta/.test(sql)) throw new Error("extracted SQL is not the joined list query");
  return sql
    .replace("${where}", "")
    .replace("${sortCol}", sortExpr("handlers/threats.ts"))
    .replace("${dir}", dir);
}

function openThreats(): SqliteDb {
  const raw = openDerivedDb(["threats", "brands", "hosting_providers", "saas_techniques",
                             "threat_actor_infrastructure", "threat_actors"]);
  // threats.registration_date exists in prod (cartographer's RDAP pass
  // writes it) but no migration adds it, so the derived schema lacks it.
  // Test-only shim so the handler's real SELECT list prepares.
  const cols = raw.prepare("PRAGMA table_info(threats)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "registration_date")) {
    raw.exec("ALTER TABLE threats ADD COLUMN registration_date TEXT");
  }
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

  it("the FULL joined list query (5 LEFT JOINs + tai subquery) still walks the index", () => {
    const sql = fullListSql();
    expect((sql.match(/LEFT JOIN/g) ?? []).length).toBe(5);
    const p = plan(openThreats(), sql, 50, 0);
    expect(p).toContain("idx_threats_severity_rank_created");
    // The tai subquery may materialise its own GROUP BY b-tree; what must not
    // appear is a sort of the outer result.
    expect(p).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
  });

  it("the FULL joined list query keeps the index walk under prod-like stats", () => {
    const raw = openThreats();
    raw.exec("ANALYZE");
    raw.exec("DELETE FROM sqlite_stat1");
    const ins = raw.prepare("INSERT INTO sqlite_stat1(tbl, idx, stat) VALUES ('threats', ?, ?)");
    ins.run(null, "1500000");
    ins.run("idx_threats_severity_rank_created", "1500000 300000 2");
    ins.run("idx_threats_created_at", "1500000 2");
    raw.exec("ANALYZE sqlite_schema");
    const p = plan(raw, fullListSql(), 50, 0);
    expect(p).toContain("idx_threats_severity_rank_created");
    expect(p).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
  });
});
