import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { handleObservatoryOperations } from "../src/handlers/observatory";
import type { Env } from "../src/types";
import { splitStatements } from "./migration-schema";
import { insertThreats, many } from "./nexus-fixtures";
import {
  legacyTargetClusterId,
  legacyClusterReport,
  runClusterRetirementBatch,
  parseRetirementParams,
  REPOINT_UPDATE_SQL,
} from "../src/lib/cluster-retirement";
import {
  notRetiredClusterSql,
  liveClusterStatusSql,
  isRetiredClusterStatus,
  RETIRED_CLUSTER_STATUSES,
  LIVE_CLUSTER_STATUSES,
} from "../src/lib/cluster-status";
import { OPERATION_STATUSES } from "../src/handlers/operations";
import { groupClusterComponents } from "../src/lib/cluster-components";
import { inheritOtxActorsToClusters } from "../src/lib/cluster-attribution-inherit";

const MIGRATIONS = resolve(__dirname, "..", "migrations");

// ─── Pure units ─────────────────────────────────────────────────────────

describe("legacyTargetClusterId", () => {
  it("maps asns[0] + attack_types[0] onto the ASN lane's stable id (normalised)", () => {
    expect(legacyTargetClusterId('["AS4837"]', '["malware_distribution"]'))
      .toEqual({ target: "cluster_asn_as4837_malware_distribution", reason: "mapped" });
    expect(legacyTargetClusterId('["AS4837 China Unicom, Ltd"]', '["phishing"]'))
      .toEqual({ target: "cluster_asn_as4837_phishing", reason: "mapped" });
  });

  it("shared-infra ASNs and IP-reputation types release instead of mapping", () => {
    expect(legacyTargetClusterId('["AS13335 Cloudflare, Inc."]', '["phishing"]').reason).toBe("shared_infra");
    expect(legacyTargetClusterId('["AS4134"]', '["scanning"]').reason).toBe("ip_reputation");
  });

  it("numeric asns entries map (JSON number → AS<digits>)", () => {
    expect(legacyTargetClusterId("[4837]", '["phishing"]'))
      .toEqual({ target: "cluster_asn_as4837_phishing", reason: "mapped" });
    expect(legacyTargetClusterId("[13335]", '["phishing"]').reason).toBe("shared_infra");
    expect(legacyTargetClusterId('["AS14618"]', '["phishing"]').reason).toBe("shared_infra"); // IaaS: ASN-only too
  });

  it("unparseable rows release", () => {
    expect(legacyTargetClusterId(null, '["phishing"]').reason).toBe("unparseable");
    expect(legacyTargetClusterId("not json", '["phishing"]').reason).toBe("unparseable");
    expect(legacyTargetClusterId('["AS4837"]', "[]").reason).toBe("unparseable");
    expect(legacyTargetClusterId('["Cloudflare"]', '["phishing"]').reason).toBe("unparseable");
  });
});

describe("parseRetirementParams", () => {
  it("is a dry run unless dry_run=0/false; clamps bounds", () => {
    expect(parseRetirementParams(new URLSearchParams("")).dryRun).toBe(true);
    expect(parseRetirementParams(new URLSearchParams("dry_run=1")).dryRun).toBe(true);
    expect(parseRetirementParams(new URLSearchParams("dry_run=0")).dryRun).toBe(false);
    expect(parseRetirementParams(new URLSearchParams("dry_run=false")).dryRun).toBe(false);
    const p = parseRetirementParams(new URLSearchParams("max_clusters=5000&max_threats=-3"));
    expect(p.maxClusters).toBe(90);
    expect(p.maxThreats).toBe(1);
    expect(parseRetirementParams(new URLSearchParams("max_clusters=abc")).maxClusters).toBe(50);
  });
});

describe("cluster-status helpers", () => {
  it("notRetiredClusterSql covers every retired status, alias-aware", () => {
    expect(notRetiredClusterSql()).toBe("status NOT IN ('superseded', 'shared_infra')");
    expect(notRetiredClusterSql("ic")).toBe("ic.status NOT IN ('superseded', 'shared_infra')");
    for (const s of RETIRED_CLUSTER_STATUSES) expect(isRetiredClusterStatus(s)).toBe(true);
    expect(isRetiredClusterStatus("active")).toBe(false);
    expect(isRetiredClusterStatus(null)).toBe(false);
  });

  it("liveClusterStatusSql is the positive list: every operation status, no retired one", () => {
    expect(liveClusterStatusSql()).toBe("status IN ('active', 'dormant', 'accelerating', 'pivot')");
    expect(liveClusterStatusSql("ic")).toBe("ic.status IN ('active', 'dormant', 'accelerating', 'pivot')");
    expect(new Set(LIVE_CLUSTER_STATUSES)).toEqual(OPERATION_STATUSES);
    for (const s of LIVE_CLUSTER_STATUSES) expect(isRetiredClusterStatus(s)).toBe(false);
  });
});

// ─── Migration 0303 ─────────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("migration 0303 — supersede legacy clusters", () => {
  it("flips exactly the non-`cluster_` ids, leaves actor/counts intact, and is idempotent", () => {
    const raw = openMigratedDb();
    const ins = raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, status, threat_count, actor_id) VALUES (?, 'n', ?, ?, ?)`,
    );
    const legacy = [
      "0f8e2b9c-1111-4000-8000-000000000000", "3a000000-0000-4000-8000-000000000000",
      "5b000000-0000-4000-8000-000000000000", "7c000000-0000-4000-8000-000000000000",
      "9d000000-0000-4000-8000-000000000000", "b1000000-0000-4000-8000-000000000000",
      "c0ffee00-0000-4000-8000-000000000000", "f0000000-0000-4000-8000-000000000000",
      "ABCDEF00-0000-4000-8000-000000000000", "cluster-hyphen", "clusterz", "cluster",
    ];
    const stable = ["cluster_asn_as4837_phishing", "cluster_ip_203.0.113.7", "cluster_"];
    legacy.forEach((id, i) => ins.run(id, i % 2 ? "dormant" : "active", 10 + i, i === 0 ? "actor_apt" : null));
    stable.forEach((id) => ins.run(id, "active", 5, null));

    const sql = readFileSync(join(MIGRATIONS, "0303_supersede_legacy_clusters.sql"), "utf8");
    const apply = () => { for (const s of splitStatements(sql)) raw.exec(s); };
    apply();
    const status = (id: string) => (raw.prepare("SELECT status FROM infrastructure_clusters WHERE id = ?").all(id)[0] as { status: string }).status;
    for (const id of legacy) expect(status(id), id).toBe("superseded");
    for (const id of stable) expect(status(id), id).toBe("active");
    const kept = raw.prepare("SELECT actor_id, threat_count FROM infrastructure_clusters WHERE id = ?").all(legacy[0]) as Array<{ actor_id: string; threat_count: number }>;
    expect(kept[0]).toEqual({ actor_id: "actor_apt", threat_count: 10 });
    apply(); // idempotent
    for (const id of legacy) expect(status(id)).toBe("superseded");
  });

  it("0305 adds cluster_repoint_log with an old_cluster_id-leading index", () => {
    const raw = openMigratedDb();
    const cols = (raw.prepare("PRAGMA table_info(cluster_repoint_log)").all() as Array<{ name: string; notnull: number }>);
    expect(cols.map((c) => c.name)).toEqual(["threat_id", "old_cluster_id", "new_cluster_id", "run_at"]);
    expect(cols.find((c) => c.name === "new_cluster_id")!.notnull).toBe(0);
    const idx = raw.prepare("PRAGMA index_info(idx_cluster_repoint_log_old)").all() as Array<{ name: string }>;
    expect(idx.map((c) => c.name)).toEqual(["old_cluster_id", "run_at"]);
  });

  it("0302 adds country_counts; 0304 adds the (actor_id, status) index", () => {
    const raw = openMigratedDb();
    const cols = (raw.prepare("PRAGMA table_info(infrastructure_clusters)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("country_counts");
    const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='infrastructure_clusters'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain("idx_clusters_actor_status");
  });
});

// ─── Report + bounded re-point batch ───────────────────────────────────

describe.skipIf(!hasSqlite())("legacy cluster report + re-point batch", () => {
  let raw: SqliteDb;
  let db: D1Database;
  const L1 = "11111111-0000-4000-8000-000000000001"; // AS4837 malware → stable row exists
  const L2 = "22222222-0000-4000-8000-000000000002"; // Cloudflare → release
  const L3 = "33333333-0000-4000-8000-000000000003"; // AS64500 phishing → stable row missing → release
  const L4 = "44444444-0000-4000-8000-000000000004"; // no threats referencing it

  const clusterOf = (id: string) =>
    (raw.prepare("SELECT cluster_id FROM threats WHERE id = ?").all(id)[0] as { cluster_id: string | null }).cluster_id;

  beforeEach(() => {
    raw = openMigratedDb();
    db = d1FromSqlite(raw);
    const ins = raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, asns, attack_types, status, threat_count, actor_id, attribution_attempted_at)
       VALUES (?, 'n', ?, ?, ?, 1, ?, ?)`,
    );
    ins.run(L1, '["AS4837"]', '["malware_distribution"]', "superseded", null, "2026-09-01");
    ins.run(L2, '["AS13335 Cloudflare, Inc."]', '["phishing"]', "superseded", "actor_spurious_apt", "2026-09-01");
    ins.run(L3, '["AS64500"]', '["phishing"]', "superseded", null, null);
    ins.run(L4, '["AS4837"]', '["phishing"]', "superseded", null, null);
    ins.run("cluster_asn_as4837_malware_distribution", '["AS4837"]', '["malware_distribution"]', "active", null, null);
    // Retired STABLE rows still holding threats.
    ins.run("cluster_asn_as13335_phishing", '["AS13335"]', '["phishing"]', "shared_infra", null, null);
    ins.run("cluster_asn_as4837_china_unicom_ltd_malware_distribution", '["AS4837 China Unicom, Ltd"]', '["malware_distribution"]', "superseded", null, null);
    insertThreats(raw, [
      ...many(5, (i) => ({ id: `t1_${i}`, asn: "AS4837", threat_type: "malware_distribution", cluster_id: L1 })),
      ...many(3, (i) => ({ id: `t2_${i}`, asn: "AS13335", cluster_id: L2 })),
      ...many(2, (i) => ({ id: `t3_${i}`, asn: "AS64500", cluster_id: L3 })),
      ...many(4, (i) => ({ id: `t4_${i}`, asn: "AS13335", cluster_id: "cluster_asn_as13335_phishing" })),
      ...many(2, (i) => ({ id: `t5_${i}`, asn: "AS4837 China Unicom, Ltd", threat_type: "malware_distribution", cluster_id: "cluster_asn_as4837_china_unicom_ltd_malware_distribution" })),
      { id: "t_ok", asn: "AS4837", threat_type: "malware_distribution", cluster_id: "cluster_asn_as4837_malware_distribution" },
      { id: "t_none", asn: "AS4837", cluster_id: null },
    ]);
  });

  it("report: legacy counts, threat refs, mapping coverage, retired stable rows", async () => {
    const r = await legacyClusterReport(db);
    expect(r.legacy_rows).toEqual({ total: 4, by_status: { superseded: 4 }, actor_linked: 1, attributor_processed: 2 });
    expect(r.legacy_threat_refs).toEqual({ threats: 10, distinct_cluster_ids: 3 });
    expect(r.mapping.clusters_evaluated).toBe(3);
    expect(r.mapping.truncated).toBe(false);
    expect(r.mapping.clusters).toEqual({ repoint: 1, release_shared_infra: 1, release_target_missing: 1 });
    expect(r.mapping.threats).toEqual({ repoint: 5, release_shared_infra: 3, release_target_missing: 2 });
    expect(r.retired_stable_rows).toEqual({ superseded: 1, shared_infra: 1, threats_referencing: 6 });
  });

  it("dry run writes nothing", async () => {
    const before = raw.prepare("SELECT id, cluster_id FROM threats ORDER BY id").all();
    const r = await runClusterRetirementBatch(db, { dryRun: true });
    expect(r.dry_run).toBe(true);
    expect(r.legacy).toMatchObject({ cluster_ids: 3, repoint: 1, release: 2, threats_repointed: 5, threats_released: 5 });
    expect(r.retired_stable).toMatchObject({ cluster_ids: 2, repoint: 1, release: 1, threats_repointed: 2, threats_released: 4 });
    expect(r.done).toBe(false);
    expect(raw.prepare("SELECT id, cluster_id FROM threats ORDER BY id").all()).toEqual(before);
  });

  it("apply: re-points mappable threats, releases the rest, is idempotent and reports done", async () => {
    const r = await runClusterRetirementBatch(db, { dryRun: false });
    expect(r.legacy.threats_repointed).toBe(5);
    expect(r.legacy.threats_released).toBe(5);
    expect(r.retired_stable.threats_repointed).toBe(2);
    expect(r.retired_stable.threats_released).toBe(4);
    expect(r.done).toBe(true);

    expect(clusterOf("t1_0")).toBe("cluster_asn_as4837_malware_distribution");
    expect(clusterOf("t2_0")).toBeNull();
    expect(clusterOf("t3_0")).toBeNull();
    expect(clusterOf("t4_0")).toBeNull();
    expect(clusterOf("t5_0")).toBe("cluster_asn_as4837_malware_distribution");
    expect(clusterOf("t_ok")).toBe("cluster_asn_as4837_malware_distribution");
    expect(clusterOf("t_none")).toBeNull();
    // Cluster rows untouched (reversible).
    const l2 = raw.prepare("SELECT status, actor_id FROM infrastructure_clusters WHERE id = ?").all(L2)[0];
    expect(l2).toEqual({ status: "superseded", actor_id: "actor_spurious_apt" });

    const again = await runClusterRetirementBatch(db, { dryRun: false });
    expect(again.legacy.cluster_ids + again.retired_stable.cluster_ids).toBe(0);
    expect(again.done).toBe(true);
  });

  it("apply records every moved threat in cluster_repoint_log, and the log undoes the move", async () => {
    const before = raw.prepare("SELECT id, cluster_id FROM threats ORDER BY id").all();
    const r = await runClusterRetirementBatch(db, { dryRun: false });
    const moved = r.legacy.threats_repointed + r.legacy.threats_released
      + r.retired_stable.threats_repointed + r.retired_stable.threats_released;
    const log = raw.prepare(
      "SELECT threat_id, old_cluster_id, new_cluster_id, run_at FROM cluster_repoint_log ORDER BY threat_id",
    ).all() as Array<{ threat_id: string; old_cluster_id: string; new_cluster_id: string | null; run_at: string }>;
    expect(log).toHaveLength(moved);
    expect(moved).toBe(16);
    const t1 = log.find((l) => l.threat_id === "t1_0")!;
    expect(t1).toMatchObject({ old_cluster_id: L1, new_cluster_id: "cluster_asn_as4837_malware_distribution" });
    expect(log.find((l) => l.threat_id === "t2_0")).toMatchObject({ old_cluster_id: L2, new_cluster_id: null });
    expect(new Set(log.map((l) => l.run_at)).size).toBe(1); // one run_at per call
    // Untouched threats are not logged.
    expect(log.some((l) => l.threat_id === "t_ok" || l.threat_id === "t_none")).toBe(false);
    // Each logged row matches the threat's new state...
    for (const l of log) expect(clusterOf(l.threat_id)).toBe(l.new_cluster_id);
    // ...the result carries the run_at the log was stamped with...
    expect(r.run_at).toBe(log[0]!.run_at);
    // ...and the documented per-run_at undo restores the pre-run state exactly.
    undoRun(r.run_at!);
    expect(raw.prepare("SELECT id, cluster_id FROM threats ORDER BY id").all()).toEqual(before);
  });

  // The documented undo (lib/cluster-retirement.ts header, migration 0305,
  // docs/API_REFERENCE.md): one run_at at a time, newest first.
  const undoRun = (runAt: string): void => {
    raw.prepare(`UPDATE threats SET cluster_id = l.old_cluster_id
                   FROM cluster_repoint_log l
                  WHERE threats.id = l.threat_id
                    AND l.run_at = ?
                    AND threats.cluster_id IS l.new_cluster_id`).run(runAt);
  };
  const nextMs = async (): Promise<void> => { await new Promise((res) => setTimeout(res, 5)); };

  it("a threat moved twice (U → X, then X → NULL) is restored to U by undoing per run_at, newest first", async () => {
    const before = raw.prepare("SELECT id, cluster_id FROM threats ORDER BY id").all();
    // Call 1: L1 (U) → cluster_asn_as4837_malware_distribution (X).
    const r1 = await runClusterRetirementBatch(db, { dryRun: false });
    expect(clusterOf("t1_0")).toBe("cluster_asn_as4837_malware_distribution");
    // X is later retired, so call 2 releases X → NULL.
    raw.prepare("UPDATE infrastructure_clusters SET status = 'shared_infra' WHERE id = 'cluster_asn_as4837_malware_distribution'").run();
    await nextMs();
    const r2 = await runClusterRetirementBatch(db, { dryRun: false });
    expect(r1.run_at).not.toBeNull();
    expect(r2.run_at).not.toBeNull();
    expect(r2.run_at! > r1.run_at!).toBe(true);
    expect(clusterOf("t1_0")).toBeNull();
    expect(clusterOf("t_ok")).toBeNull();

    const runs = (raw.prepare("SELECT DISTINCT run_at FROM cluster_repoint_log ORDER BY run_at DESC").all() as Array<{ run_at: string }>)
      .map((x) => x.run_at);
    expect(runs).toEqual([r2.run_at, r1.run_at]);
    for (const runAt of runs) undoRun(runAt);
    expect(clusterOf("t1_0")).toBe(L1);                                        // U, not X
    expect(clusterOf("t_ok")).toBe("cluster_asn_as4837_malware_distribution"); // only ever moved by call 2
    expect(raw.prepare("SELECT id, cluster_id FROM threats ORDER BY id").all()).toEqual(before);
  });

  it("oldest-first undo would NOT restore a twice-moved threat (why the order is documented)", async () => {
    const r1 = await runClusterRetirementBatch(db, { dryRun: false });
    raw.prepare("UPDATE infrastructure_clusters SET status = 'shared_infra' WHERE id = 'cluster_asn_as4837_malware_distribution'").run();
    await nextMs();
    const r2 = await runClusterRetirementBatch(db, { dryRun: false });
    undoRun(r1.run_at!); // t1_0 is on NULL, not X: guarded no-op
    undoRun(r2.run_at!); // NULL → X
    expect(clusterOf("t1_0")).toBe("cluster_asn_as4837_malware_distribution");
  });

  it("the undo guard skips a released threat that NEXUS has since re-claimed", async () => {
    const r = await runClusterRetirementBatch(db, { dryRun: false });
    expect(clusterOf("t2_0")).toBeNull(); // released (Cloudflare)
    raw.prepare("UPDATE threats SET cluster_id = 'cluster_ip_203.0.113.7' WHERE id = 't2_0'").run();
    undoRun(r.run_at!);
    expect(clusterOf("t2_0")).toBe("cluster_ip_203.0.113.7"); // the newer stamp survives
    expect(clusterOf("t2_1")).toBe(L2);                        // untouched siblings are restored
  });

  it("the move UPDATE drives from the log index into the threats PRIMARY KEY, not the cluster_id index", () => {
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${REPOINT_UPDATE_SQL}`).all("t", "s", "s", "r") as Array<{ detail: string }>)
      .map((p) => p.detail);
    expect(plan.some((d) => /^SEARCH threats USING INDEX sqlite_autoindex_threats_1 \(id=\?\)/.test(d)), plan.join(" | ")).toBe(true);
    expect(plan.some((d) => /idx_cluster_repoint_log_old \(old_cluster_id=\? AND run_at=\?\)/.test(d)), plan.join(" | ")).toBe(true);
    expect(plan.some((d) => /threats USING (COVERING )?INDEX idx_threats_cluster/.test(d)), plan.join(" | ")).toBe(false);
    expect(REPOINT_UPDATE_SQL).toMatch(/WHERE \+cluster_id = \?/);
  });

  it("dry run writes no cluster_repoint_log rows and returns run_at null", async () => {
    const r = await runClusterRetirementBatch(db, { dryRun: true });
    expect(r.run_at).toBeNull();
    expect((raw.prepare("SELECT COUNT(*) AS n FROM cluster_repoint_log").all()[0] as { n: number }).n).toBe(0);
  });

  it("counters skip source ids left untouched because the budget ran out", async () => {
    const r = await runClusterRetirementBatch(db, { dryRun: false, maxThreats: 3 });
    const handled = r.legacy.cluster_ids + r.retired_stable.cluster_ids;
    const logged = (raw.prepare("SELECT COUNT(DISTINCT old_cluster_id) AS n FROM cluster_repoint_log").all()[0] as { n: number }).n;
    // 5 source ids have threats; a 3-threat budget reaches at most 2 of them.
    expect(handled).toBe(logged);
    expect(handled).toBeLessThan(5);
    expect(r.legacy.repoint + r.legacy.release).toBe(r.legacy.cluster_ids);
    expect(r.retired_stable.repoint + r.retired_stable.release).toBe(r.retired_stable.cluster_ids);
    expect(r.plan_sample.length).toBe(handled);
  });

  it("respects the per-call threat budget and finishes over several calls", async () => {
    let calls = 0;
    let moved = 0;
    for (;;) {
      const r = await runClusterRetirementBatch(db, { dryRun: false, maxThreats: 3 });
      calls++;
      const n = r.legacy.threats_repointed + r.legacy.threats_released + r.retired_stable.threats_repointed + r.retired_stable.threats_released;
      expect(n).toBeLessThanOrEqual(3);
      moved += n;
      if (r.done) break;
      expect(calls).toBeLessThan(20);
    }
    expect(moved).toBe(16);
    expect(calls).toBeGreaterThan(1);
  });
});

// ─── Readers exclude retired rows ──────────────────────────────────────

describe.skipIf(!hasSqlite())("readers exclude retired clusters", () => {
  it("component grouping never groups a retired row and clears a stale component_id", async () => {
    const raw = openMigratedDb();
    const db = d1FromSqlite(raw);
    const ins = raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, brand_ids, agent_notes, status, component_id) VALUES (?, 'n', '[]', ?, ?, ?)`,
    );
    const certNotes = (s: string) => JSON.stringify({ cluster_type: "ssl_cert_serial", ssl_cert_serial: s });
    ins.run("cluster_cert_s1", certNotes("s1"), "active", null);
    ins.run("cluster_ip_192.0.2.9", "per-ip", "active", null);
    ins.run("55555555-0000-4000-8000-000000000005", null, "superseded", "component_cluster_ip_192.0.2.9");
    // Members: the serial and the IP share a threat; a legacy-stamped threat
    // shares the serial too.
    insertThreats(raw, [
      { id: "m1", serial: "s1", ip: "192.0.2.9", cluster_id: "cluster_cert_s1" },
      { id: "m2", serial: "s1", ip: "192.0.2.9", cluster_id: "cluster_ip_192.0.2.9" },
      { id: "m3", serial: "s1", cluster_id: "55555555-0000-4000-8000-000000000005" },
    ]);
    const r = await groupClusterComponents(db);
    expect(r.clustersRead).toBe(2);
    const rows = raw.prepare("SELECT id, component_id FROM infrastructure_clusters ORDER BY id").all() as Array<{ id: string; component_id: string | null }>;
    const byId = Object.fromEntries(rows.map((x) => [x.id, x.component_id]));
    expect(byId["55555555-0000-4000-8000-000000000005"]).toBeNull();
    expect(byId["cluster_cert_s1"]).not.toBeNull();
    expect(byId["cluster_cert_s1"]).toBe(byId["cluster_ip_192.0.2.9"]);
  });

  it("observatory operations (status=all) lists operations only", async () => {
    const raw = openMigratedDb();
    const d1 = d1FromSqlite(raw);
    const ins = raw.prepare(`INSERT INTO infrastructure_clusters (id, cluster_name, status, threat_count) VALUES (?, 'n', ?, ?)`);
    ins.run("77777777-0000-4000-8000-000000000007", "superseded", 9999);
    ins.run("cluster_asn_as13335_phishing", "shared_infra", 9000);
    ins.run("cluster_asn_as4837_phishing", "active", 10);
    ins.run("cluster_asn_as4837_malware_distribution", "dormant", 5);
    const env = {
      DB: Object.assign(d1, { withSession: () => ({ prepare: d1.prepare.bind(d1), getBookmark: () => null }) }),
      CACHE: fakeKv(),
    } as unknown as Env;
    const res = await handleObservatoryOperations(new Request("https://x/api/observatory/operations?limit=10"), env);
    const body = await res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((r) => r.id).sort()).toEqual([
      "cluster_asn_as4837_malware_distribution", "cluster_asn_as4837_phishing",
    ]);
  });

  it("OTX inheritance skips retired clusters", async () => {
    const raw = openMigratedDb();
    const db = d1FromSqlite(raw);
    raw.prepare(`INSERT INTO threat_actors (id, name) VALUES ('act_1', 'Actor One')`).run();
    raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, status) VALUES ('66666666-0000-4000-8000-000000000006', 'n', 'superseded')`,
    ).run();
    insertThreats(raw, [
      { id: "o1", cluster_id: "66666666-0000-4000-8000-000000000006" },
      { id: "o2", cluster_id: "66666666-0000-4000-8000-000000000006" },
    ]);
    raw.prepare(
      `INSERT INTO threat_attributions (id, threat_id, actor_id, source, confidence) VALUES ('ta1', 'o1', 'act_1', 'otx', 'medium')`,
    ).run();
    const r = await inheritOtxActorsToClusters(db);
    expect(r.clusters_scanned).toBe(1);
    expect(r.clusters_retired_skipped).toBe(1);
    expect(r.members_attributed).toBe(0);
    const actor = raw.prepare("SELECT actor_id FROM infrastructure_clusters WHERE id = '66666666-0000-4000-8000-000000000006'").all()[0];
    expect(actor).toEqual({ actor_id: null });
  });
});

// ─── Static reader audit ───────────────────────────────────────────────
//
// Every SQL literal under src/ that reads infrastructure_clusters must
// either exclude retired rows (notRetiredClusterSql / an explicit live
// status filter) or be a by-id / by-key read. A new reader that lists or
// counts clusters without one fails here instead of silently resurfacing
// ~76K superseded legacy duplicates.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const SAFE = [
  /notRetiredClusterSql\(/,
  /status = 'active'/,
  /liveClusterStatusSql\(/,                         // positive live-status list
  /status IN \(\$\{statusPlaceholders\}\)/,        // public-proof LIVE_OPERATION_STATUSES
  /WHERE (\w+\.)?id = \?/,                          // by-id
  /WHERE id IN \(/,                                 // by-id batch
  /ON ic\.id = t\.cluster_id AND/,                   // detail join, filtered
  /LEGACY_CLUSTER_ID_SQL|id >= 'cluster_/,          // retirement tooling / lane retire pass (reads retired rows on purpose)
];

describe("static audit — infrastructure_clusters readers", () => {
  it("every read excludes retired clusters or is keyed by id", () => {
    const root = resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const file of walk(root)) {
      if (file.includes("manifest.generated")) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/`([^`]*(?:FROM|JOIN) infrastructure_clusters[^`]*)`/g)) {
        const sql = m[1]!;
        if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) continue;
        if (!/\bSELECT\b/i.test(sql)) continue;
        if (SAFE.some((re) => re.test(sql))) continue;
        // A dynamically built `${where}` / `${statusFilter}` is accepted only
        // in a file that builds it with notRetiredClusterSql (operations /
        // observatory status=all branches; operations-geo is pinned
        // behaviourally in observatory-lenses.test.ts + observatory-lens-plans.test.ts).
        if (/\$\{(where|statusFilter)\}/.test(sql) && /notRetiredClusterSql\(/.test(text)) continue;
        offenders.push(`${relative(root, file)}: ${sql.replace(/\s+/g, " ").slice(0, 140)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
