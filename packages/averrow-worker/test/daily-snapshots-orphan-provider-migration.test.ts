/**
 * Migration 0296 — merge orphaned "hp_AS<N> <name>" provider snapshots
 * (their hosting_providers row is already gone) into the canonical
 * provider's snapshot rows. Replayed statement-by-statement against a real
 * SQLite whose schema is derived from migrations/.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { splitStatements } from "./migration-schema";
import { hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";

const MIGRATION = readFileSync(
  resolve(__dirname, "..", "migrations", "0296_daily_snapshots_orphan_malformed_provider_ids.sql"),
  "utf8",
);

function applyMigration(db: SqliteDb): void {
  for (const stmt of splitStatements(MIGRATION)) db.exec(`${stmt};`);
}

type SnapRow = {
  date: string; entity_type: string; entity_id: string;
  new_threats: number; active_threats: number; remediated_threats: number;
  dominant_threat_type: string | null;
};

function seed(): SqliteDb {
  const db = openDerivedDb(["hosting_providers", "daily_snapshots"]);
  const hp = db.prepare("INSERT INTO hosting_providers (id, name, asn) VALUES (?, ?, ?)");
  hp.run("hp_AS13335", "Cloudflare, Inc.", "AS13335");
  hp.run("hp_digitalocean", "DigitalOcean", "AS14061"); // canonical under a legacy id

  const s = db.prepare(
    `INSERT INTO daily_snapshots
       (date, entity_type, entity_id, new_threats, active_threats, remediated_threats, dominant_threat_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Collision: both sides exist for the date → counters add.
  s.run("2026-04-30", "provider", "hp_AS13335", 160, 31409, 0, "malware_distribution");
  s.run("2026-04-30", "provider", "hp_AS13335 Cloudflare, Inc.", 0, 11608, 9, "phishing");
  // Collision where the canonical dominant type is NULL → takes the orphan's.
  s.run("2026-05-01", "provider", "hp_AS13335", 1, 2, 0, null);
  s.run("2026-05-01", "provider", "hp_AS13335 Cloudflare, Inc.", 3, 4, 5, "phishing");
  // No collision, canonical under a legacy id → re-keyed.
  s.run("2026-05-02", "provider", "hp_AS14061 DigitalOcean, LLC", 1, 7, 0, "c2");
  // No hosting_providers row for the ASN → left in place.
  s.run("2026-05-02", "provider", "hp_AS99999 Nobody LLC", 1, 1, 1, "c2");
  // Non-AS<digits> prefix → left in place.
  s.run("2026-05-02", "provider", "hp_ASX12 Weird Co", 1, 1, 1, "c2");
  // Name-derived orphan (out of scope) → untouched.
  s.run("2026-04-01", "provider", "hp_03ai_ltd", 1, 1, 1, "phishing");
  // Brand row with a spaced-looking id is not a provider row → untouched.
  s.run("2026-05-02", "brand", "hp_AS13335 Cloudflare, Inc.", 1, 1, 1, "phishing");
  return db;
}

function all(db: SqliteDb): SnapRow[] {
  return db.prepare(
    "SELECT * FROM daily_snapshots ORDER BY date, entity_type, entity_id",
  ).all() as SnapRow[];
}

function row(db: SqliteDb, date: string, id: string, type = "provider"): SnapRow | undefined {
  return db.prepare(
    "SELECT * FROM daily_snapshots WHERE date = ? AND entity_type = ? AND entity_id = ?",
  ).get(date, type, id) as SnapRow | undefined;
}

describe.skipIf(!hasSqlite())("migration 0296 — orphaned spaced provider snapshots", () => {
  it("merges colliding rows, re-keys the rest, and leaves out-of-scope rows alone", () => {
    const db = seed();
    applyMigration(db);

    expect(row(db, "2026-04-30", "hp_AS13335")).toMatchObject({
      new_threats: 160, active_threats: 43017, remediated_threats: 9,
      dominant_threat_type: "malware_distribution",
    });
    expect(row(db, "2026-05-01", "hp_AS13335")).toMatchObject({
      new_threats: 4, active_threats: 6, remediated_threats: 5, dominant_threat_type: "phishing",
    });
    expect(row(db, "2026-05-02", "hp_digitalocean")).toMatchObject({
      new_threats: 1, active_threats: 7, dominant_threat_type: "c2",
    });

    expect(row(db, "2026-04-30", "hp_AS13335 Cloudflare, Inc.")).toBeUndefined();
    expect(row(db, "2026-05-01", "hp_AS13335 Cloudflare, Inc.")).toBeUndefined();
    expect(row(db, "2026-05-02", "hp_AS14061 DigitalOcean, LLC")).toBeUndefined();

    expect(row(db, "2026-05-02", "hp_AS99999 Nobody LLC")).toBeDefined();
    expect(row(db, "2026-05-02", "hp_ASX12 Weird Co")).toBeDefined();
    expect(row(db, "2026-04-01", "hp_03ai_ltd")).toBeDefined();
    expect(row(db, "2026-05-02", "hp_AS13335 Cloudflare, Inc.", "brand")).toBeDefined();
  });

  it("a second run is a no-op", () => {
    const db = seed();
    applyMigration(db);
    const once = all(db);
    applyMigration(db);
    expect(all(db)).toEqual(once);
  });

  it("uses no BEGIN/COMMIT and no TEMP table (D1 migration runner)", () => {
    const stmts = splitStatements(MIGRATION);
    expect(stmts.some((s) => /^(BEGIN|COMMIT|END)\b/i.test(s))).toBe(false);
    expect(stmts.some((s) => /^CREATE\s+TEMP/i.test(s))).toBe(false);
  });
});
