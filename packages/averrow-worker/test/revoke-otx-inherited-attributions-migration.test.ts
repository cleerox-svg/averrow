/**
 * Migration 0309 — revoke OTX-inherited attributions (owner decision
 * 2026-10-22). Runs against a REAL SQLite (node:sqlite) built by applying
 * every migration in order (so 0309 has already run once on empty tables —
 * the fresh-DB case), with foreign keys ON as D1 enforces them. Then seeds
 * the prod shapes and re-applies 0309:
 *   - inherited rows (tat_otxinherit_*, source='nexus', inherited=1) are
 *     backed up and deleted;
 *   - a May-2026 source='nexus' row and an 'otx' row are untouched;
 *   - an inheritance-only cluster has its actor backed up and cleared;
 *   - a cluster with a manual attribution keeps its actor (its inherited
 *     rows are still revoked);
 *   - a cluster whose actor differs from the inherited one keeps it;
 *   - a strict-policy row written AFTER the #1860 deploy cutoff (same id
 *     prefix / source / inherited flag) and its cluster stamp are untouched;
 *   - a prefixed row that is not flagged inherited never makes its cluster a
 *     candidate (clusters_cleared stays exact);
 *   - status / attribution_attempted_at are never touched;
 *   - one summary row records the counts;
 *   - a further application is a no-op, and the restore recipe round-trips —
 *     skipping (not aborting on) a backed-up row whose actor was deleted.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { splitStatements } from "./migration-schema";
import { hasSqlite, openMigratedDb, type SqliteDb } from "./sqlite-d1-harness";

const MIGRATION = readFileSync(
  resolve(__dirname, "..", "migrations", "0309_revoke_otx_inherited_attributions.sql"),
  "utf8",
);
const REASON = "otx_inheritance_policy_2026-10";

function applyMigration(db: SqliteDb): void {
  // Statement-by-statement, like D1's runner: no BEGIN/COMMIT in the file.
  for (const stmt of splitStatements(MIGRATION)) db.exec(`${stmt};`);
}

type Row = Record<string, unknown>;
const all = (db: SqliteDb, sql: string): Row[] => db.prepare(sql).all() as Row[];
const count = (db: SqliteDb, sql: string): number =>
  Number((db.prepare(sql).get() as { n: number }).n);

const INHERITED_META = (cluster: string): string =>
  JSON.stringify({ inherited: true, inherit_origin: "otx", cluster_id: cluster, actor_name: "APT X" });

function seed(): SqliteDb {
  const db = openMigratedDb();
  db.exec("PRAGMA foreign_keys = ON");

  const actor = db.prepare("INSERT INTO threat_actors (id, name) VALUES (?, ?)");
  actor.run("ta_apt_x", "APT X");
  actor.run("ta_apt_y", "APT Y");

  const threat = db.prepare(
    "INSERT INTO threats (id, source_feed, threat_type, status, cluster_id) VALUES (?, 'test', 'phishing', 'active', ?)",
  );
  for (let i = 1; i <= 12; i++) threat.run(`t${i}`, null);

  const cluster = db.prepare(
    `INSERT INTO infrastructure_clusters (id, asns, status, actor_id, attribution_attempted_at, retired_reason)
     VALUES (?, '[]', ?, ?, '2026-10-20 00:00:00', ?)`,
  );
  cluster.run("cluster_ip_inherit_only", "active", "ta_apt_x", null);      // cleared
  cluster.run("cluster_asn_retired", "dormant", "ta_apt_x", "superseded"); // cleared (retired)
  cluster.run("cluster_ip_manual", "active", "ta_apt_x", null);            // kept: manual row
  cluster.run("cluster_ip_other_actor", "active", "ta_apt_y", null);       // kept: actor differs
  cluster.run("cluster_ip_untouched", "active", "ta_apt_y", null);         // kept: no inheritance
  cluster.run("cluster_ip_strict", "active", "ta_apt_x", null);            // kept: post-cutoff strict-policy row only
  cluster.run("cluster_ip_unflagged", "active", "ta_apt_x", null);         // kept: prefixed row lacks inherited=1

  const attr = db.prepare(
    `INSERT INTO threat_attributions
       (id, threat_id, actor_id, source, source_pulse_id, source_pulse_name, actor_name_raw, confidence, observed_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Inherited rows (the revocation set).
  attr.run("tat_otxinherit_aaa1", "t1", "ta_apt_x", "nexus", "cluster_ip_inherit_only", "APT X", "APT X", "low", "2026-08-01 00:00:00", INHERITED_META("cluster_ip_inherit_only"));
  attr.run("tat_otxinherit_aaa2", "t2", "ta_apt_x", "nexus", "cluster_ip_inherit_only", "APT X", "APT X", "low", "2026-08-01 00:00:00", INHERITED_META("cluster_ip_inherit_only"));
  attr.run("tat_otxinherit_bbb1", "t3", "ta_apt_x", "nexus", "cluster_asn_retired", "APT X", "APT X", "low", "2026-09-01 00:00:00", INHERITED_META("cluster_asn_retired"));
  attr.run("tat_otxinherit_ccc1", "t4", "ta_apt_x", "nexus", "cluster_ip_manual", "APT X", "APT X", "low", "2026-09-01 00:00:00", INHERITED_META("cluster_ip_manual"));
  attr.run("tat_otxinherit_ddd1", "t5", "ta_apt_x", "nexus", "cluster_ip_other_actor", "APT X", "APT X", "low", "2026-09-01 00:00:00", INHERITED_META("cluster_ip_other_actor"));
  // Strict-policy row written at/after #1860's deploy (2026-10-21 18:27 UTC)
  // — same prefix/source/flag, but outside the revocation window: untouched.
  attr.run("tat_otxinherit_eee1", "t11", "ta_apt_x", "nexus", "cluster_ip_strict", "APT X", "APT X", "low", "2026-10-21 18:27:00", INHERITED_META("cluster_ip_strict"));
  // Prefixed, pre-cutoff, but NOT flagged inherited — neither the row nor
  // its cluster is a candidate.
  attr.run("tat_otxinherit_fff1", "t12", "ta_apt_x", "nexus", "cluster_ip_unflagged", "APT X", "APT X", "low", "2026-09-01 00:00:00", null);
  // Manual attribution on cluster_ip_manual — keeps its actor stamp.
  attr.run("tat_manual_cluster_ip_manual_t6", "t6", "ta_apt_x", "manual", "cluster_ip_manual", null, null, "confirmed", "2026-10-01 00:00:00", null);
  // May-2026 non-inherited source='nexus' row — untouched.
  attr.run("tat_nexus_may_1", "t7", "ta_apt_y", "nexus", "cluster_ip_untouched", null, "APT Y", "medium", "2026-05-06 23:07:42", null);
  // Direct OTX row — untouched.
  attr.run("tat_otx_1", "t8", "ta_apt_x", "otx", "pulse_123", "Pulse", "APT X", "medium", "2026-07-01 00:00:00", null);
  // Prefix-adjacent ids that are NOT in the range — untouched.
  attr.run("tat_otxinherit", "t9", "ta_apt_x", "nexus", "cluster_ip_inherit_only", null, null, "low", "2026-08-01 00:00:00", INHERITED_META("x"));
  attr.run("tat_otxinherita", "t10", "ta_apt_x", "nexus", "cluster_ip_inherit_only", null, null, "low", "2026-08-01 00:00:00", INHERITED_META("x"));
  return db;
}

const SURVIVORS = [
  "tat_manual_cluster_ip_manual_t6",
  "tat_nexus_may_1",
  "tat_otx_1",
  "tat_otxinherit",
  "tat_otxinherit_eee1",
  "tat_otxinherit_fff1",
  "tat_otxinherita",
];
const REVOKED = [
  "tat_otxinherit_aaa1",
  "tat_otxinherit_aaa2",
  "tat_otxinherit_bbb1",
  "tat_otxinherit_ccc1",
  "tat_otxinherit_ddd1",
];

function snapshot(db: SqliteDb): unknown {
  return {
    attrs: all(db, "SELECT * FROM threat_attributions ORDER BY id"),
    revoked: all(db, "SELECT id, revoke_reason FROM threat_attributions_revoked ORDER BY id"),
    clusterRev: all(db, "SELECT cluster_id, actor_id, revoke_reason FROM cluster_actor_revocations ORDER BY cluster_id"),
    clusters: all(db, "SELECT id, actor_id, status, attribution_attempted_at, retired_reason FROM infrastructure_clusters ORDER BY id"),
    runs: all(db, "SELECT * FROM attribution_revocation_runs"),
  };
}

function runRestoreRecipe(db: SqliteDb): void {
  const block = MIGRATION.slice(
    MIGRATION.indexOf("── Restore recipe"),
    MIGRATION.indexOf("-- (The threats EXISTS guard"),
  );
  const recipe = block.split("\n")
    .filter((l) => l.startsWith("--"))
    .map((l) => l.replace(/^--\s?/, ""))
    .join("\n");
  const restoreSql = recipe.slice(recipe.indexOf("INSERT OR IGNORE INTO threat_attributions"));
  expect(restoreSql).toContain("UPDATE infrastructure_clusters");
  expect(restoreSql).toContain("FROM threat_actors a WHERE a.id = r.actor_id");
  for (const stmt of splitStatements(restoreSql)) db.exec(`${stmt};`);
}

describe.skipIf(!hasSqlite())("migration 0309 — revoke OTX-inherited attributions", () => {
  it("is a clean no-op on a fresh migrated DB (summary row with zero counts)", () => {
    const db = openMigratedDb();
    expect(all(db, "SELECT revoke_reason, actor, attributions_revoked, clusters_cleared, live_clusters_cleared FROM attribution_revocation_runs"))
      .toEqual([{ revoke_reason: REASON, actor: "system:migration_0309", attributions_revoked: 0, clusters_cleared: 0, live_clusters_cleared: 0 }]);
    expect(count(db, "SELECT COUNT(*) AS n FROM threat_attributions_revoked")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM cluster_actor_revocations")).toBe(0);
  });

  it("backs up and deletes inherited rows, clears inheritance-only cluster actors, writes the summary", () => {
    const db = seed();
    // The fresh-DB application already wrote a zero-count summary row; the
    // prod DB applies 0309 exactly once, so drop it to model that.
    db.exec("DELETE FROM attribution_revocation_runs");
    applyMigration(db);

    expect(all(db, "SELECT id FROM threat_attributions ORDER BY id").map((r) => r.id)).toEqual(SURVIVORS);

    const backup = all(db,
      `SELECT id, threat_id, actor_id, source, source_pulse_id, confidence, observed_at, metadata, revoke_reason
         FROM threat_attributions_revoked ORDER BY id`);
    expect(backup.map((r) => r.id)).toEqual(REVOKED);
    expect(backup.every((r) => r.revoke_reason === REASON && r.source === "nexus" && r.confidence === "low")).toBe(true);
    expect(backup[0]).toMatchObject({
      threat_id: "t1", actor_id: "ta_apt_x", source_pulse_id: "cluster_ip_inherit_only",
      observed_at: "2026-08-01 00:00:00", metadata: INHERITED_META("cluster_ip_inherit_only"),
    });

    expect(all(db, "SELECT cluster_id, actor_id, revoke_reason FROM cluster_actor_revocations ORDER BY cluster_id")).toEqual([
      { cluster_id: "cluster_asn_retired", actor_id: "ta_apt_x", revoke_reason: REASON },
      { cluster_id: "cluster_ip_inherit_only", actor_id: "ta_apt_x", revoke_reason: REASON },
    ]);

    expect(all(db, "SELECT id, actor_id, status, attribution_attempted_at, retired_reason FROM infrastructure_clusters ORDER BY id")).toEqual([
      { id: "cluster_asn_retired", actor_id: null, status: "dormant", attribution_attempted_at: "2026-10-20 00:00:00", retired_reason: "superseded" },
      { id: "cluster_ip_inherit_only", actor_id: null, status: "active", attribution_attempted_at: "2026-10-20 00:00:00", retired_reason: null },
      { id: "cluster_ip_manual", actor_id: "ta_apt_x", status: "active", attribution_attempted_at: "2026-10-20 00:00:00", retired_reason: null },
      { id: "cluster_ip_other_actor", actor_id: "ta_apt_y", status: "active", attribution_attempted_at: "2026-10-20 00:00:00", retired_reason: null },
      { id: "cluster_ip_strict", actor_id: "ta_apt_x", status: "active", attribution_attempted_at: "2026-10-20 00:00:00", retired_reason: null },
      { id: "cluster_ip_unflagged", actor_id: "ta_apt_x", status: "active", attribution_attempted_at: "2026-10-20 00:00:00", retired_reason: null },
      { id: "cluster_ip_untouched", actor_id: "ta_apt_y", status: "active", attribution_attempted_at: "2026-10-20 00:00:00", retired_reason: null },
    ]);

    const runs = all(db, "SELECT * FROM attribution_revocation_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      revoke_reason: REASON, actor: "system:migration_0309",
      attributions_revoked: 5, clusters_cleared: 2, live_clusters_cleared: 1,
    });
    expect(JSON.parse(String(runs[0]!.details))).toMatchObject({ migration: "0309_revoke_otx_inherited_attributions" });
  });

  it("is a no-op when applied again", () => {
    const db = seed();
    db.exec("DELETE FROM attribution_revocation_runs");
    applyMigration(db);
    const before = snapshot(db);
    applyMigration(db);
    expect(snapshot(db)).toEqual(before);
  });

  it("the cutoff is exclusive: the last pre-deploy second is revoked, the deploy second is not", () => {
    const db = seed();
    db.prepare(
      `INSERT INTO threat_attributions
         (id, threat_id, actor_id, source, source_pulse_id, confidence, observed_at, metadata)
       VALUES ('tat_otxinherit_zzz1', 't9', 'ta_apt_x', 'nexus', 'cluster_ip_inherit_only', 'low', '2026-10-21 18:26:59', ?)`,
    ).run(INHERITED_META("cluster_ip_inherit_only"));
    applyMigration(db);
    expect(count(db, "SELECT COUNT(*) AS n FROM threat_attributions WHERE id = 'tat_otxinherit_zzz1'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM threat_attributions_revoked WHERE id = 'tat_otxinherit_zzz1'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM threat_attributions WHERE id = 'tat_otxinherit_eee1'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM threat_attributions_revoked WHERE id = 'tat_otxinherit_eee1'")).toBe(0);
  });

  it("the header restore recipe puts rows and cluster actors back", () => {
    const db = seed();
    const original = {
      attrs: all(db, "SELECT * FROM threat_attributions ORDER BY id"),
      clusters: all(db, "SELECT id, actor_id FROM infrastructure_clusters ORDER BY id"),
    };
    applyMigration(db);

    runRestoreRecipe(db);

    expect(all(db, "SELECT * FROM threat_attributions ORDER BY id")).toEqual(original.attrs);
    expect(all(db, "SELECT id, actor_id FROM infrastructure_clusters ORDER BY id")).toEqual(original.clusters);
  });

  it("the restore recipe skips a backed-up row/cluster whose actor was deleted, without aborting", () => {
    const db = seed();
    db.prepare("INSERT INTO threat_actors (id, name) VALUES ('ta_apt_z', 'APT Z')").run();
    db.prepare(
      `INSERT INTO infrastructure_clusters (id, asns, status, actor_id, attribution_attempted_at, retired_reason)
       VALUES ('cluster_ip_gone_actor', '[]', 'active', 'ta_apt_z', '2026-10-20 00:00:00', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO threat_attributions
         (id, threat_id, actor_id, source, source_pulse_id, confidence, observed_at, metadata)
       VALUES ('tat_otxinherit_ggg1', 't10', 'ta_apt_z', 'nexus', 'cluster_ip_gone_actor', 'low', '2026-09-01 00:00:00', ?)`,
    ).run(INHERITED_META("cluster_ip_gone_actor"));
    const original = {
      attrs: all(db, "SELECT * FROM threat_attributions WHERE id <> 'tat_otxinherit_ggg1' ORDER BY id"),
      clusters: all(db, "SELECT id, actor_id FROM infrastructure_clusters WHERE id <> 'cluster_ip_gone_actor' ORDER BY id"),
    };
    applyMigration(db);
    expect(count(db, "SELECT COUNT(*) AS n FROM threat_attributions_revoked WHERE id = 'tat_otxinherit_ggg1'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM cluster_actor_revocations WHERE cluster_id = 'cluster_ip_gone_actor'")).toBe(1);

    // The actor is deleted after the revocation (the backups carry no FK).
    db.exec("DELETE FROM threat_actors WHERE id = 'ta_apt_z'");
    runRestoreRecipe(db);

    // Everything else is restored exactly; the orphaned row/cluster are skipped.
    expect(all(db, "SELECT * FROM threat_attributions ORDER BY id")).toEqual(original.attrs);
    expect(all(db, "SELECT id, actor_id FROM infrastructure_clusters WHERE id <> 'cluster_ip_gone_actor' ORDER BY id")).toEqual(original.clusters);
    expect(all(db, "SELECT actor_id FROM infrastructure_clusters WHERE id = 'cluster_ip_gone_actor'")).toEqual([{ actor_id: null }]);
  });
});
