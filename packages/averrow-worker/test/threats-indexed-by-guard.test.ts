/**
 * Guard for `INDEXED BY` on threats count queries (D1 read-spend fix,
 * 2026-10-14). SQLite raises "no query solution" when the query's WHERE
 * stops implying a partial index's predicate, and "no such index" when the
 * index is gone — both would only surface at runtime. This test extracts
 * every SELECT in the touched sources that pins an index, builds `threats`
 * with the partial indexes exactly as the migrations create them, and
 * checks each statement prepares and plans onto the pinned index.
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { splitStatements } from "./migration-schema";
import { PRIVATE_IP_SQL_FILTER } from "../src/lib/geoip";
import { stripIndexedBy, withIndexHintFallback } from "../src/lib/indexed-by-fallback";
import {
  GEO_AWAITING_MMDB_SQL,
  GEO_PHASE0_ELIGIBLE_SQL,
  GEO_TERMINAL_SQL,
  GEO_UNMAPPED_POPULATION_SQL,
  GEO_UNMAPPED_THREATS_FROM,
} from "../src/lib/geo-exhaustion";

interface RawStmt { all(...p: unknown[]): unknown[] }
interface RawDb { exec(sql: string): void; prepare(sql: string): RawStmt }
type SqliteCtor = new (path: string) => RawDb;

const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: SqliteCtor | null = null;
try {
  DatabaseSync = (nodeRequire("node:sqlite") as { DatabaseSync: SqliteCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}

const ROOT = resolve(__dirname, "..");
const PINNED = ["idx_threats_stuck_geo", "idx_threats_carto_phase0", "idx_threats_phase0_public"];

/**
 * The live definition of each index, replayed like deriveSchema
 * (test/migration-schema.ts): statements in migration file order, the LAST
 * `CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name>` wins, and a later
 * `DROP INDEX [IF EXISTS] <name>` removes it.
 */
function migrationIndexDdl(name: string): string {
  const dir = resolve(ROOT, "migrations");
  const create = new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${name}\s`, "i");
  const drop = new RegExp(String.raw`^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?${name}\s*$`, "i");
  let ddl: string | null = null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of splitStatements(readFileSync(resolve(dir, f), "utf8"))) {
      if (drop.test(stmt)) ddl = null;
      else if (create.test(stmt)) ddl = `${stmt};`;
    }
  }
  if (!ddl) throw new Error(`${name} is not created by any migration`);
  return ddl;
}

const SUBST: Record<string, string> = {
  PRIVATE_IP_SQL_FILTER,
  GEO_UNMAPPED_POPULATION_SQL,
  GEO_UNMAPPED_THREATS_FROM,
  GEO_TERMINAL_SQL,
  GEO_AWAITING_MMDB_SQL,
  GEO_PHASE0_ELIGIBLE_SQL,
};

function pinnedQueries(): Array<{ file: string; sql: string; index: string }> {
  const files = [
    "src/agents/flightControl.ts",
    "src/handlers/diagnostics.ts",
    "src/handlers/admin/metrics.ts",
    "src/handlers/cartographer-health.ts",
  ];
  const out: Array<{ file: string; sql: string; index: string }> = [];
  for (const file of files) {
    const src = readFileSync(resolve(ROOT, file), "utf8");
    for (const m of src.matchAll(/`(\s*SELECT[^`]*)`/g)) {
      const tpl = m[1]!;
      if (!/FROM threats INDEXED BY|\$\{GEO_UNMAPPED_THREATS_FROM\}/.test(tpl)) continue;
      const sql = tpl.replace(/\$\{(\w+)\}/g, (_, k: string) => {
        if (!(k in SUBST)) throw new Error(`${file}: unknown interpolation \${${k}}`);
        return SUBST[k]!;
      });
      const index = sql.match(/INDEXED BY (\w+)/)?.[1];
      if (!index) throw new Error(`${file}: no INDEXED BY after substitution`);
      out.push({ file, sql, index });
    }
  }
  return out;
}

describe.skipIf(!DatabaseSync)("threats INDEXED BY sites", () => {
  it("every pinned index is created by a migration", () => {
    for (const name of PINNED) expect(migrationIndexDdl(name)).toContain("WHERE");
  });

  it("finds every pinned query (FC ×2, diagnostics ×4, metrics ×2, cartographer-health ×1)", () => {
    const q = pinnedQueries();
    const by = (f: string) => q.filter((x) => x.file.endsWith(f)).length;
    expect(by("flightControl.ts")).toBe(2);
    expect(by("diagnostics.ts")).toBe(4);
    expect(by("metrics.ts")).toBe(2);
    expect(by("cartographer-health.ts")).toBe(1);
  });

  it("each query prepares and plans onto its pinned partial index", () => {
    const raw = new DatabaseSync!(":memory:");
    raw.exec(`
      CREATE TABLE threats (
        id TEXT PRIMARY KEY, status TEXT, source_feed TEXT, threat_type TEXT,
        ip_address TEXT, is_private_ip INTEGER DEFAULT 0, lat REAL,
        enriched_at TEXT, enrichment_attempts INTEGER DEFAULT 0,
        geo_mmdb_checked_at TEXT, created_at TEXT
      );
      ${migrationIndexDdl("idx_threats_ip_source_feed")}
      ${PINNED.map(migrationIndexDdl).join("\n")}
    `);
    for (const { file, sql, index } of pinnedQueries()) {
      let plan: Array<{ detail: string }>;
      try {
        plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
      } catch (err) {
        throw new Error(`${file}: ${(err as Error).message}\n${sql}`);
      }
      expect(plan.map((p) => p.detail).join(" | "), file).toContain(index);
    }
  });
});

describe("withIndexHintFallback", () => {
  it("strips every INDEXED BY hint", () => {
    expect(stripIndexedBy("SELECT 1 FROM threats INDEXED BY idx_a WHERE x")).toBe("SELECT 1 FROM threats WHERE x");
    expect(stripIndexedBy(`SELECT 1 FROM ${GEO_UNMAPPED_THREATS_FROM}`)).toBe("SELECT 1 FROM threats");
  });

  it("re-runs unhinted on 'no such index' / 'no query solution' only", async () => {
    for (const msg of ["D1_ERROR: no such index: idx_a", "no query solution"]) {
      const seen: string[] = [];
      const r = await withIndexHintFallback("SELECT 1 FROM t INDEXED BY idx_a", async (q) => {
        seen.push(q);
        if (q.includes("INDEXED BY")) throw new Error(msg);
        return 7;
      });
      expect(r).toBe(7);
      expect(seen).toEqual(["SELECT 1 FROM t INDEXED BY idx_a", "SELECT 1 FROM t"]);
    }
  });

  it("propagates other errors, and hint errors from an unhinted query", async () => {
    await expect(withIndexHintFallback("SELECT 1 FROM t INDEXED BY idx_a", async () => {
      throw new Error("no such column: foo");
    })).rejects.toThrow("no such column");
    await expect(withIndexHintFallback("SELECT 1 FROM t", async () => {
      throw new Error("no such index: x");
    })).rejects.toThrow("no such index");
  });
});

describe.skipIf(!DatabaseSync)("withIndexHintFallback on real SQLite", () => {
  it("a dropped pinned index degrades to the unhinted plan with the same count", async () => {
    const raw = new DatabaseSync!(":memory:");
    raw.exec(`CREATE TABLE threats (id TEXT, enriched_at TEXT, lat REAL, ip_address TEXT, created_at TEXT);
              INSERT INTO threats VALUES ('a', 'x', NULL, '1.2.3.4', 'c'), ('b', NULL, NULL, '1.2.3.5', 'c');`);
    const sql = `SELECT COUNT(*) AS n FROM threats INDEXED BY idx_threats_stuck_geo
                  WHERE enriched_at IS NOT NULL AND lat IS NULL AND ip_address IS NOT NULL AND ip_address != ''`;
    const n = await withIndexHintFallback(sql, async (q) => (raw.prepare(q).all()[0] as { n: number }).n);
    expect(n).toBe(1);
  });
});
