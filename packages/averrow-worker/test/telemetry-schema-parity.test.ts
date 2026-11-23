/**
 * migrations-telemetry/ vs migrations/: the telemetry tables (wave 1 + agent_outputs) must have the same
 * shape on both DBs until the cut-over (Track B1a).
 *
 * Core is built by replaying every migrations/*.sql file; telemetry by
 * replaying every migrations-telemetry/*.sql file. For each wave-1 table the
 * test compares columns (order, type, NOT NULL, default, PK), CHECK
 * constraints, every index (name, uniqueness, key columns + direction,
 * partial WHERE) and foreign keys.
 *
 * MIRROR RULE: a core migration that changes a wave-1 table must ship with a
 * matching migrations-telemetry/NNNN_*.sql. When this test fails, that is
 * what is missing.
 *
 * The only allowed differences: FKs pointing OUTSIDE the cluster
 * (feed_configs.updated_by -> users, agent_outputs.related_campaign_id ->
 * campaigns) are dropped on telemetry, because D1 enforces foreign keys and
 * users / campaigns stay on core.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, type SqliteDb } from "./sqlite-d1-harness";
import { splitStatements } from "./migration-schema";

const TELEMETRY_TABLES = [
  "agent_runs",
  "agent_configs",
  "agent_events",
  "agent_activity_log",
  "agent_approvals",
  "feed_configs",
  "feed_status",
  "feed_pull_history",
  "budget_ledger",
  "budget_config",
  "agent_budget_rollups",
  // Wave 2 (migrations-telemetry/0002_agent_outputs.sql): agents family.
  "agent_outputs",
] as const;

const MIRROR_HINT =
  "migrations-telemetry/ must mirror core migrations for the wave-1 tables until the cut-over: " +
  "add a migrations-telemetry/NNNN_*.sql that applies the same change";

const TELEMETRY_DIR = resolve(__dirname, "..", "migrations-telemetry");

function openTelemetryDb(): SqliteDb {
  const nodeRequire = createRequire(import.meta.url);
  const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); // D1 enforces FKs
  for (const file of readdirSync(TELEMETRY_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of splitStatements(readFileSync(resolve(TELEMETRY_DIR, file), "utf8"))) db.exec(stmt);
  }
  return db;
}

const norm = (sql: string): string =>
  sql
    .replace(/--[^\n]*/g, " ")
    .replace(/["`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=])\s*/g, "$1")
    .trim()
    .toLowerCase();

/** Every top-level CHECK (...) clause of a CREATE TABLE, normalised. */
function checks(createSql: string): string[] {
  const s = norm(createSql);
  const out: string[] = [];
  let i = s.indexOf("check(");
  while (i !== -1) {
    let depth = 0;
    let j = i + 5;
    for (; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")" && --depth === 0) break;
    }
    out.push(s.slice(i, j + 1));
    i = s.indexOf("check(", j);
  }
  return out.sort();
}

interface Shape {
  columns: unknown[];
  checks: string[];
  indexes: unknown[];
  fks: Array<{ from: string; table: string; to: string | null }>;
}

function shapeOf(db: SqliteDb, table: string): Shape | null {
  const master = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").all(table) as Array<{ sql: string }>;
  if (master.length === 0) return null;
  const columns = (db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<Record<string, unknown>>)
    .map((c) => ({ name: c.name, type: String(c.type).toUpperCase(), notnull: c.notnull, dflt: c.dflt_value == null ? null : norm(String(c.dflt_value)), pk: c.pk, hidden: c.hidden }));
  const indexes = (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number; origin: string; partial: number }>)
    .map((ix) => {
      const keys = (db.prepare(`PRAGMA index_xinfo(${ix.name})`).all() as Array<{ name: string | null; desc: number; key: number }>)
        .filter((k) => k.key === 1)
        .map((k) => `${k.name}${k.desc ? " desc" : ""}`);
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").all(ix.name) as Array<{ sql: string | null }>)[0]?.sql;
      const where = sql && / where /i.test(sql) ? norm(sql.slice(sql.search(/ where /i))) : null;
      // Autoindex names embed the table, so compare them by origin + keys only.
      const name = ix.origin === "c" ? ix.name : `(${ix.origin})`;
      return { name, unique: ix.unique, origin: ix.origin, partial: ix.partial, keys, where };
    })
    .sort((a, b) => `${a.name}|${a.keys.join(",")}`.localeCompare(`${b.name}|${b.keys.join(",")}`));
  const fks = (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string; table: string; to: string | null }>)
    .map((f) => ({ from: f.from, table: f.table, to: f.to }));
  return { columns, checks: checks(master[0]!.sql), indexes, fks };
}

describe.skipIf(!hasSqlite())("telemetry schema parity (migrations-telemetry/ == migrations/ for the telemetry tables)", () => {
  const core = hasSqlite() ? openMigratedDb() : null;
  const tel = hasSqlite() ? openTelemetryDb() : null;
  const cluster = new Set<string>(TELEMETRY_TABLES);

  it("telemetry holds exactly the telemetry tables", () => {
    const tables = (tel!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables, MIRROR_HINT).toEqual([...TELEMETRY_TABLES].sort());
  });

  for (const table of TELEMETRY_TABLES) {
    it(`${table}: same columns, CHECKs, indexes and in-cluster FKs`, () => {
      const c = shapeOf(core!, table);
      const t = shapeOf(tel!, table);
      expect(c, `${table} missing from core migrations`).not.toBeNull();
      expect(t, `${table} missing from migrations-telemetry. ${MIRROR_HINT}`).not.toBeNull();
      expect(t!.columns, `${table} columns differ. ${MIRROR_HINT}`).toEqual(c!.columns);
      expect(t!.checks, `${table} CHECK constraints differ. ${MIRROR_HINT}`).toEqual(c!.checks);
      expect(t!.indexes, `${table} indexes differ. ${MIRROR_HINT}`).toEqual(c!.indexes);
      expect(t!.fks, `${table} foreign keys differ (only FKs out of the cluster may be dropped). ${MIRROR_HINT}`)
        .toEqual(c!.fks.filter((f) => cluster.has(f.table)));
    });
  }

  it("the only FKs dropped on telemetry are feed_configs.updated_by -> users and agent_outputs.related_campaign_id -> campaigns", () => {
    const dropped = TELEMETRY_TABLES.flatMap((t) => shapeOf(core!, t)!.fks.filter((f) => !cluster.has(f.table)).map((f) => `${t}.${f.from}->${f.table}`));
    expect(dropped.sort()).toEqual(["agent_outputs.related_campaign_id->campaigns", "feed_configs.updated_by->users"]);
  });

  it("telemetry accepts rows with FK enforcement on (no FK to a table it lacks)", () => {
    tel!.exec("INSERT INTO feed_configs (feed_name, display_name, schedule_cron, updated_by) VALUES ('f', 'F', '* * * * *', 'usr_1')");
    tel!.exec("INSERT INTO feed_pull_history (id, feed_name) VALUES ('p1', 'f')");
    expect(() => tel!.exec("INSERT INTO feed_pull_history (id, feed_name) VALUES ('p2', 'missing')")).toThrow();
    // agent_outputs.related_campaign_id names a core campaign: no FK here.
    tel!.exec("INSERT INTO agent_outputs (id, agent_id, type, summary, related_campaign_id) VALUES ('o1', 'strategist', 'insight', 's', 'camp_on_core')");
  });
});
