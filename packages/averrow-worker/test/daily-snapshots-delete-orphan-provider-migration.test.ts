/**
 * Migration 0297 — delete provider snapshots dated before 2026-05-01 whose
 * entity_id matches no hosting_providers row. Replayed statement-by-statement
 * against a real SQLite whose schema is derived from migrations/.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { splitStatements } from "./migration-schema";
import { hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";

const MIGRATION = readFileSync(
  resolve(__dirname, "..", "migrations", "0297_daily_snapshots_delete_orphan_provider_rows.sql"),
  "utf8",
);

function applyMigration(db: SqliteDb): void {
  for (const stmt of splitStatements(MIGRATION)) db.exec(`${stmt};`);
}

function seed(): SqliteDb {
  const db = openDerivedDb(["hosting_providers", "daily_snapshots"]);
  db.prepare("INSERT INTO hosting_providers (id, name, asn) VALUES (?, ?, ?)")
    .run("hp_AS13335", "Cloudflare, Inc.", "AS13335");

  const s = db.prepare(
    `INSERT INTO daily_snapshots (date, entity_type, entity_id, new_threats, active_threats, remediated_threats)
     VALUES (?, ?, ?, 1, 1, 0)`,
  );
  s.run("2026-04-01", "provider", "hp_03ai_ltd");                          // name-derived orphan → deleted
  s.run("2026-04-15", "provider", "001b59f2-e78d-425d-9ffa-afea3463e6fa"); // UUID orphan → deleted
  s.run("2026-04-15", "provider", "hp_AS13335");                           // live provider → kept
  s.run("2026-05-01", "provider", "hp_gone_later");                        // orphan on/after cutoff → kept
  s.run("2026-04-01", "brand", "brand_not_a_provider");                    // brand row → kept
  return db;
}

function keys(db: SqliteDb): string[] {
  return (db.prepare(
    "SELECT date || '|' || entity_type || '|' || entity_id AS k FROM daily_snapshots ORDER BY k",
  ).all() as Array<{ k: string }>).map((r) => r.k);
}

describe.skipIf(!hasSqlite())("migration 0297 — delete orphan provider snapshots", () => {
  it("deletes only pre-cutoff provider rows with no hosting_providers row", () => {
    const db = seed();
    applyMigration(db);
    expect(keys(db)).toEqual([
      "2026-04-01|brand|brand_not_a_provider",
      "2026-04-15|provider|hp_AS13335",
      "2026-05-01|provider|hp_gone_later",
    ]);
  });

  it("a second run is a no-op", () => {
    const db = seed();
    applyMigration(db);
    const once = keys(db);
    applyMigration(db);
    expect(keys(db)).toEqual(once);
  });

  it("uses no BEGIN/COMMIT (D1 migration runner)", () => {
    const stmts = splitStatements(MIGRATION);
    expect(stmts.some((s) => /^(BEGIN|COMMIT|END)\b/i.test(s))).toBe(false);
  });
});
