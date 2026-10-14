/**
 * Migration 0294 — fold legacy "hp_AS<N> <name>" hosting_providers rows into
 * their canonical ASN row. Replayed against a REAL SQLite (node:sqlite) whose
 * schema is derived from migrations/, with foreign keys ON (D1 enforces
 * them), so the final DELETE proves every FK reference was repointed.
 *
 * Cases: a twin under the canonical id, a twin under a legacy (non-hp_AS)
 * id, a no-twin row (canonical row inserted), threat_cube_provider merge on
 * a colliding PK and a move on a non-colliding one, the same for
 * daily_snapshots provider rows, threats.asn normalisation (and non-AS<digits>
 * prefixes left alone), count recompute, and a second run being a no-op.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { splitStatements } from "./migration-schema";
import { hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";

const MIGRATION = readFileSync(
  resolve(__dirname, "..", "migrations", "0294_hosting_provider_malformed_id_cleanup.sql"),
  "utf8",
);

function applyMigration(db: SqliteDb): void {
  // Statement-by-statement, like D1's runner: no BEGIN/COMMIT in the file.
  for (const stmt of splitStatements(MIGRATION)) db.exec(`${stmt};`);
}

/** FK parents of threats are materialised so FK enforcement can be ON. */
function openDb(): SqliteDb {
  const db = openDerivedDb([
    "brands", "campaigns", "saas_techniques", "named_threats",
    "hosting_providers", "threats", "threat_cube_provider", "daily_snapshots",
  ]);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function seed(): SqliteDb {
  const db = openDb();

  const hp = db.prepare(
    `INSERT INTO hosting_providers (id, name, asn, country, active_threat_count, total_threat_count, trend_7d)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Twin under the canonical id.
  hp.run("hp_AS200350", "Yandex Cloud", "AS200350", "RU", 1, 1, 7);
  hp.run("hp_AS200350 Yandex.Cloud LLC", "Yandex.Cloud LLC", "AS200350 Yandex.Cloud LLC", "RU", 2, 2, 0);
  // Twin under a legacy id — must be reused, not duplicated.
  hp.run("hp_digitalocean", "DigitalOcean", "AS14061", "US", 0, 0, 3);
  hp.run("hp_AS14061 DigitalOcean, LLC", "DigitalOcean", "AS14061 DigitalOcean, LLC", "US", 1, 1, 0);
  // No twin — canonical row must be created.
  hp.run("hp_AS62955 eBay, Inc", "eBay, Inc", "AS62955 eBay, Inc", "US", 2, 2, 0);
  // Clean, unrelated provider — untouched.
  hp.run("hp_AS13335", "Cloudflare, Inc.", "AS13335", "US", 1, 1, 9);

  const t = db.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, hosting_provider_id, asn, status)
     VALUES (?, 'test', 'phishing', ?, ?, ?)`,
  );
  t.run("t1", "hp_AS200350", "AS200350", "active");
  t.run("t2", "hp_AS200350 Yandex.Cloud LLC", "AS200350 Yandex.Cloud LLC", "active");
  t.run("t3", "hp_AS200350 Yandex.Cloud LLC", "AS200350 Yandex.Cloud LLC", "down");
  t.run("t4", "hp_AS14061 DigitalOcean, LLC", "AS14061 DigitalOcean, LLC", "active");
  t.run("t5", "hp_AS62955 eBay, Inc", "AS62955 eBay, Inc", "active");
  t.run("t6", "hp_AS62955 eBay, Inc", null, "active");
  t.run("t7", "hp_AS13335", "AS13335", "active");
  t.run("t8", null, "AS9009 M247 Europe SRL", "active"); // asn-only normalisation
  t.run("t9", null, "ASX12 Not An ASN", "active");       // non-AS<digits> prefix → untouched
  t.run("t10", null, "AS12x3 Odd Tail", "active");       // digits then non-digit → untouched

  const c = db.prepare(
    `INSERT INTO threat_cube_provider (hour_bucket, hosting_provider_id, threat_type, severity, source_feed, threat_count)
     VALUES (?, ?, 'phishing', 'high', 'test', ?)`,
  );
  // Collides with the canonical row's PK → counts must add.
  c.run("2026-03-14 18:00:00", "hp_AS200350", 4);
  c.run("2026-03-14 18:00:00", "hp_AS200350 Yandex.Cloud LLC", 3);
  // No canonical row for this bucket → moved.
  c.run("2026-03-15 01:00:00", "hp_AS62955 eBay, Inc", 2);
  c.run("2026-03-15 01:00:00", "hp_AS13335", 5);

  const d = db.prepare(
    `INSERT INTO daily_snapshots (date, entity_type, entity_id, new_threats, active_threats, remediated_threats,
       dominant_threat_type, dominant_hosting_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Collision: canonical keeps its dominant type, counters add.
  d.run("2026-10-01", "provider", "hp_AS200350", 1, 5, 2, "phishing", null);
  d.run("2026-10-01", "provider", "hp_AS200350 Yandex.Cloud LLC", 2, 3, 1, "c2", null);
  // Collision where the canonical side has no dominant type → takes the malformed one.
  d.run("2026-10-02", "provider", "hp_AS200350", 0, 1, 0, null, null);
  d.run("2026-10-02", "provider", "hp_AS200350 Yandex.Cloud LLC", 1, 1, 0, "botnet", null);
  // No collision → re-keyed to the canonical id.
  d.run("2026-10-01", "provider", "hp_AS62955 eBay, Inc", 4, 4, 0, "phishing", null);
  // Brand row whose dominant_hosting_provider is a provider NAME → untouched.
  d.run("2026-10-01", "brand", "brand_x", 1, 1, 0, "phishing", "Yandex.Cloud LLC");
  return db;
}

type Row = Record<string, unknown>;
const all = (db: SqliteDb, sql: string): Row[] => db.prepare(sql).all() as Row[];

describe.skipIf(!hasSqlite())("migration 0294 — malformed hosting_provider ids", () => {
  it("repoints every reference, merges cubes, recounts, and deletes the malformed rows", () => {
    const db = seed();
    applyMigration(db);

    expect(all(db, "SELECT id FROM hosting_providers WHERE id LIKE 'hp_AS% %' OR asn LIKE '% %'")).toEqual([]);

    const providers = all(db,
      "SELECT id, name, asn, country, active_threat_count, total_threat_count, trend_7d FROM hosting_providers ORDER BY id");
    expect(providers).toEqual([
      // twin kept its own name; counts recomputed; trend untouched
      { id: "hp_AS13335", name: "Cloudflare, Inc.", asn: "AS13335", country: "US", active_threat_count: 1, total_threat_count: 1, trend_7d: 9 },
      { id: "hp_AS200350", name: "Yandex Cloud", asn: "AS200350", country: "RU", active_threat_count: 2, total_threat_count: 3, trend_7d: 7 },
      // no-twin case: canonical row created from the parsed string
      { id: "hp_AS62955", name: "eBay, Inc", asn: "AS62955", country: "US", active_threat_count: 2, total_threat_count: 2, trend_7d: 0 },
      // legacy-id twin reused (no second AS14061 row)
      { id: "hp_digitalocean", name: "DigitalOcean", asn: "AS14061", country: "US", active_threat_count: 1, total_threat_count: 1, trend_7d: 3 },
    ]);

    const threats = all(db, "SELECT id, hosting_provider_id, asn FROM threats ORDER BY CAST(substr(id, 2) AS INTEGER)");
    expect(threats).toEqual([
      { id: "t1", hosting_provider_id: "hp_AS200350", asn: "AS200350" },
      { id: "t2", hosting_provider_id: "hp_AS200350", asn: "AS200350" },
      { id: "t3", hosting_provider_id: "hp_AS200350", asn: "AS200350" },
      { id: "t4", hosting_provider_id: "hp_digitalocean", asn: "AS14061" },
      { id: "t5", hosting_provider_id: "hp_AS62955", asn: "AS62955" },
      { id: "t6", hosting_provider_id: "hp_AS62955", asn: null },
      { id: "t7", hosting_provider_id: "hp_AS13335", asn: "AS13335" },
      { id: "t8", hosting_provider_id: null, asn: "AS9009" },
      { id: "t9", hosting_provider_id: null, asn: "ASX12 Not An ASN" },
      { id: "t10", hosting_provider_id: null, asn: "AS12x3 Odd Tail" },
    ]);

    const snaps = all(db,
      `SELECT date, entity_type, entity_id, new_threats, active_threats, remediated_threats,
              dominant_threat_type, dominant_hosting_provider
         FROM daily_snapshots ORDER BY entity_type, entity_id, date`);
    expect(snaps).toEqual([
      { date: "2026-10-01", entity_type: "brand", entity_id: "brand_x", new_threats: 1, active_threats: 1, remediated_threats: 0, dominant_threat_type: "phishing", dominant_hosting_provider: "Yandex.Cloud LLC" },
      { date: "2026-10-01", entity_type: "provider", entity_id: "hp_AS200350", new_threats: 3, active_threats: 8, remediated_threats: 3, dominant_threat_type: "phishing", dominant_hosting_provider: null },
      { date: "2026-10-02", entity_type: "provider", entity_id: "hp_AS200350", new_threats: 1, active_threats: 2, remediated_threats: 0, dominant_threat_type: "botnet", dominant_hosting_provider: null },
      { date: "2026-10-01", entity_type: "provider", entity_id: "hp_AS62955", new_threats: 4, active_threats: 4, remediated_threats: 0, dominant_threat_type: "phishing", dominant_hosting_provider: null },
    ]);

    const cube = all(db,
      "SELECT hour_bucket, hosting_provider_id, threat_count FROM threat_cube_provider ORDER BY hour_bucket, hosting_provider_id");
    expect(cube).toEqual([
      { hour_bucket: "2026-03-14 18:00:00", hosting_provider_id: "hp_AS200350", threat_count: 7 },
      { hour_bucket: "2026-03-15 01:00:00", hosting_provider_id: "hp_AS13335", threat_count: 5 },
      { hour_bucket: "2026-03-15 01:00:00", hosting_provider_id: "hp_AS62955", threat_count: 2 },
    ]);

    // Staging table cleaned up; FK integrity holds.
    expect(all(db, "SELECT name FROM sqlite_master WHERE name = '_hp_malformed_0294'")).toEqual([]);
    expect(all(db, "PRAGMA foreign_key_check(threats)")).toEqual([]);
  });

  it("a second run is a no-op", () => {
    const db = seed();
    applyMigration(db);
    const snapshot = (): Row[][] => [
      all(db, "SELECT * FROM hosting_providers ORDER BY id"),
      all(db, "SELECT id, hosting_provider_id, asn FROM threats ORDER BY id"),
      all(db, "SELECT hour_bucket, hosting_provider_id, threat_count FROM threat_cube_provider ORDER BY 1, 2"),
      all(db, "SELECT * FROM daily_snapshots ORDER BY 1, 2, 3"),
    ];
    const before = snapshot();
    applyMigration(db);
    expect(snapshot()).toEqual(before);
  });

  it("leaves a malformed row alone when its canonical id is taken by a different ASN", () => {
    const db = openDb();
    db.exec(`INSERT INTO hosting_providers (id, name, asn) VALUES ('hp_AS777', 'Squatter', NULL)`);
    db.exec(`INSERT INTO hosting_providers (id, name, asn) VALUES ('hp_AS777 Odd Net', 'Odd Net', 'AS777 Odd Net')`);
    db.exec(`INSERT INTO threats (id, source_feed, threat_type, hosting_provider_id) VALUES ('t1', 'test', 'phishing', 'hp_AS777 Odd Net')`);
    applyMigration(db);
    expect(all(db, "SELECT hosting_provider_id FROM threats")).toEqual([{ hosting_provider_id: "hp_AS777 Odd Net" }]);
    expect(all(db, "SELECT id FROM hosting_providers ORDER BY id")).toEqual([{ id: "hp_AS777" }, { id: "hp_AS777 Odd Net" }]);
  });

  it("uses no BEGIN/COMMIT and no TEMP table (D1 migration runner)", () => {
    const stmts = splitStatements(MIGRATION);
    expect(stmts.some((s) => /^(BEGIN|COMMIT|END)\b/i.test(s))).toBe(false);
    expect(stmts.some((s) => /^CREATE\s+TEMP/i.test(s))).toBe(false);
  });
});
