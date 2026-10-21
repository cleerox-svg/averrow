// Regression: the attributor hung in prod on 2026-10-21 after PR #1859
// fixed its Step 2 bind error. With Step 2 passing, the OTX inheritance
// reached its write step for the first time: it read every un-attributed
// member of the 22 eligible clusters (~44K rows; one ASN cluster alone has
// 33K) and awaited ONE INSERT per member, up to the 5,000-row cap. At the
// observed ~170ms per D1 round-trip (~350 rows/min, prod threat_attributions
// observed_at 13:07:59 → 13:20:12) that is ~14 minutes, so both runs died
// with their host invocation mid-loop and were left agent_runs
// status='partial' with completed_at NULL.
//
// These tests pin the fix with a prod-shaped fixture: D1 round-trips per
// call are bounded independently of member count, a wall-clock budget stops
// the pass cleanly, and the backlog still drains completely over runs.

import { describe, it, expect, beforeEach } from "vitest";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { hasSqlite, openMigratedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import {
  inheritOtxActorsToClusters,
  inheritedAttributionId,
  INHERITED_ID_PREFIX,
  MAX_MEMBER_WRITES_PER_RUN,
  WRITE_BATCH,
} from "../src/lib/cluster-attribution-inherit";
import { attributorAgent } from "../src/agents/attributor";
import type { Env } from "../src/types";

const D1_MAX_BINDS = 100;

interface Counter {
  /** D1 round-trips: each standalone statement execution, each batch call. */
  roundTrips: number;
  maxBatch: number;
  maxBinds: number;
}

/** Count D1 round-trips the way the Workers runtime pays for them. */
function counting(db: D1Database, c: Counter): D1Database {
  let inBatch = 0;
  const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === "bind") {
          return (...args: unknown[]) => {
            c.maxBinds = Math.max(c.maxBinds, args.length);
            if (args.length > D1_MAX_BINDS) throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
            return wrapStmt(target.bind(...args));
          };
        }
        if (prop === "run" || prop === "all" || prop === "first" || prop === "raw") {
          const fn = Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown;
          return (...a: unknown[]) => {
            if (inBatch === 0) c.roundTrips++;
            return fn.apply(target, a);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") return (sql: string) => wrapStmt(target.prepare(sql));
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          c.roundTrips++;
          c.maxBatch = Math.max(c.maxBatch, stmts.length);
          inBatch++;
          try {
            return await target.batch(stmts);
          } finally {
            inBatch--;
          }
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

// Prod-shaped (2026-10-21), scaled down so the suite stays fast:
//   * one huge ASN-lane winner (prod: cluster_asn_as4837_malware_distribution,
//     33,118 un-attributed) — here 12,000, i.e. > 2 runs of the cap;
//   * 20 mid-size winners with no cluster actor yet (prod: 21 others, 77–2,999);
//   * 10 winners already fully inherited with actor set (prod: 12, 0 left);
//   * one ambiguous cluster (two OTX actors) and one retired winner.
const BIG = 12_000;
const MID_CLUSTERS = 20;
const MID_MEMBERS = 150;
const DONE_CLUSTERS = 10;
const EXPECTED_TOTAL = BIG + MID_CLUSTERS * MID_MEMBERS;

function seed(raw: SqliteDb): void {
  raw.exec("BEGIN");
  raw.prepare("INSERT INTO threat_actors (id, name) VALUES ('ta_big', 'Big'), ('ta_mid', 'Mid'), ('ta_done', 'Done'), ('ta_x', 'X')").run();
  const cluster = raw.prepare(
    "INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status, actor_id, retired_reason) VALUES (?, ?, ?, 'active', ?, ?)",
  );
  const threat = raw.prepare("INSERT INTO threats (id, source_feed, threat_type, cluster_id) VALUES (?, 'test', 'phishing', ?)");
  const attr = raw.prepare("INSERT INTO threat_attributions (id, threat_id, actor_id, source) VALUES (?, ?, ?, ?)");

  // Threat ids are short like prod's UUIDs, so the inherited row id stays
  // under recordAttribution's 100-char id slice.
  let n = 0;
  const addCluster = (id: string, members: number, actor: string, clusterActor: string | null, retired: string | null, inheritedAlready: boolean) => {
    cluster.run(id, id, members + 1, clusterActor, retired);
    const otxThreat = `thr_${n++}`;
    threat.run(otxThreat, id);
    attr.run(`otx_${id}`, otxThreat, actor, "otx");
    for (let i = 0; i < members; i++) {
      const tid = `thr_${n++}`;
      threat.run(tid, id);
      if (inheritedAlready) attr.run(`tat_otxinherit_${id}_${tid}`, tid, actor, "nexus");
    }
  };

  addCluster("cluster_asn_as4837_malware_distribution", BIG, "ta_big", null, null, false);
  for (let i = 0; i < MID_CLUSTERS; i++) addCluster(`cluster_subnet_mid_${String(i).padStart(2, "0")}`, MID_MEMBERS, "ta_mid", null, null, false);
  for (let i = 0; i < DONE_CLUSTERS; i++) addCluster(`cluster_asn_done_${i}`, 200, "ta_done", "ta_done", null, true);
  addCluster("cluster_retired", 50, "ta_mid", null, "shared_infra", false);
  addCluster("cluster_ambiguous", 50, "ta_mid", null, null, false);
  raw.prepare("INSERT INTO threats (id, source_feed, threat_type, cluster_id) VALUES ('amb_otx2', 'test', 'phishing', 'cluster_ambiguous')").run();
  raw.prepare("INSERT INTO threat_attributions (id, threat_id, actor_id, source) VALUES ('otx_amb2', 'amb_otx2', 'ta_x', 'otx')").run();
  raw.exec("COMMIT");
}

const inheritedCount = (raw: SqliteDb): number =>
  (raw.prepare("SELECT COUNT(*) AS n FROM threat_attributions WHERE id LIKE 'tat_otxinherit_%' AND source = 'nexus'").all()[0] as { n: number }).n
  - DONE_CLUSTERS * 200;

describe.skipIf(!hasSqlite())("attributor — OTX inheritance is bounded per run (2026-10-21 hang)", () => {
  let raw: SqliteDb;
  let c: Counter;
  let db: D1Database;

  beforeEach(() => {
    raw = openMigratedDb();
    seed(raw);
    c = { roundTrips: 0, maxBatch: 0, maxBinds: 0 };
    db = counting(d1FromSqlite(raw), c);
  });

  it("first run writes exactly the cap in a bounded number of D1 round-trips", async () => {
    const r = await inheritOtxActorsToClusters(db);

    expect(r.members_attributed).toBe(MAX_MEMBER_WRITES_PER_RUN);
    expect(r.stopped_reason).toBe("write_cap");
    expect(inheritedCount(raw)).toBe(MAX_MEMBER_WRITES_PER_RUN);

    // Old code: ~5,000 sequential INSERTs + 1 per stamped cluster. New code:
    // discovery + Step 2 + ≤1 read per eligible cluster reached + ceil(cap /
    // WRITE_BATCH) batches + ≤1 extra batch per cluster boundary.
    const eligible = 1 + MID_CLUSTERS + DONE_CLUSTERS;
    const bound = 2 + eligible + Math.ceil(MAX_MEMBER_WRITES_PER_RUN / WRITE_BATCH) + eligible;
    expect(c.roundTrips).toBeLessThanOrEqual(bound);
    expect(c.roundTrips).toBeLessThan(150);
    expect(c.maxBatch).toBeLessThanOrEqual(WRITE_BATCH);
    expect(c.maxBinds).toBeLessThanOrEqual(D1_MAX_BINDS);
  });

  it("drains the whole backlog over successive runs with correct results, then is a no-op", async () => {
    const runs: Array<Awaited<ReturnType<typeof inheritOtxActorsToClusters>>> = [];
    for (let i = 0; i < 10; i++) {
      const r = await inheritOtxActorsToClusters(db);
      runs.push(r);
      if (r.stopped_reason === null) break;
    }
    const total = runs.reduce((s, r) => s + r.members_attributed, 0);
    expect(total).toBe(EXPECTED_TOTAL);
    // A run that lands exactly on the cap reports 'write_cap' even if
    // nothing is left, so allow one trailing empty run.
    expect(runs.length).toBeLessThanOrEqual(Math.ceil(EXPECTED_TOTAL / MAX_MEMBER_WRITES_PER_RUN) + 1);
    expect(inheritedCount(raw)).toBe(EXPECTED_TOTAL);

    // Every member of every winning live cluster is attributed, with the
    // cluster's own actor; retired + ambiguous clusters untouched.
    const wrongActor = raw.prepare(`
      SELECT COUNT(*) AS n FROM threat_attributions ta JOIN threats t ON t.id = ta.threat_id
       WHERE ta.id LIKE 'tat_otxinherit_%'
         AND ta.actor_id != CASE WHEN t.cluster_id LIKE 'cluster_asn_as4837%' THEN 'ta_big'
                                 WHEN t.cluster_id LIKE 'cluster_subnet_mid_%' THEN 'ta_mid'
                                 ELSE 'ta_done' END`).all()[0] as { n: number };
    expect(wrongActor.n).toBe(0);
    const untouched = raw.prepare(`
      SELECT COUNT(*) AS n FROM threats t
       WHERE t.cluster_id IN ('cluster_retired', 'cluster_ambiguous')
         AND EXISTS (SELECT 1 FROM threat_attributions ta WHERE ta.threat_id = t.id AND ta.source = 'nexus')`).all()[0] as { n: number };
    expect(untouched.n).toBe(0);
    const actors = raw.prepare(`
      SELECT id, actor_id FROM infrastructure_clusters
       WHERE id IN ('cluster_asn_as4837_malware_distribution', 'cluster_subnet_mid_19', 'cluster_retired', 'cluster_ambiguous')
       ORDER BY id`).all();
    expect(actors).toEqual([
      { id: "cluster_ambiguous", actor_id: null },
      { id: "cluster_asn_as4837_malware_distribution", actor_id: "ta_big" },
      { id: "cluster_retired", actor_id: null },
      { id: "cluster_subnet_mid_19", actor_id: "ta_mid" },
    ]);
    expect(runs.reduce((s, r) => s + r.clusters_actor_set, 0)).toBe(1 + MID_CLUSTERS);

    // Idempotent once drained.
    const again = await inheritOtxActorsToClusters(db);
    expect(again.members_attributed).toBe(0);
    expect(again.clusters_actor_set).toBe(0);
    expect(again.stopped_reason).toBeNull();
  });

  it("stops cleanly at the wall-clock budget between round-trips and resumes next run", async () => {
    // Each clock read advances 1s; a 10s budget allows only a few batches.
    let t = 0;
    const now = () => (t += 1_000);
    const r = await inheritOtxActorsToClusters(db, { budgetMs: 10_000, now });

    expect(r.stopped_reason).toBe("deadline");
    expect(r.members_attributed).toBeGreaterThan(0);
    expect(r.members_attributed).toBeLessThan(MAX_MEMBER_WRITES_PER_RUN);
    expect(inheritedCount(raw)).toBe(r.members_attributed);
    // The cluster it was working on is already named.
    const big = raw.prepare("SELECT actor_id FROM infrastructure_clusters WHERE id = 'cluster_asn_as4837_malware_distribution'").all()[0];
    expect(big).toEqual({ actor_id: "ta_big" });

    const next = await inheritOtxActorsToClusters(db);
    expect(next.members_attributed).toBe(MAX_MEMBER_WRITES_PER_RUN);
    expect(inheritedCount(raw)).toBe(r.members_attributed + MAX_MEMBER_WRITES_PER_RUN);
  });

  it("attributorAgent.execute finishes on the prod-shaped fixture in bounded round-trips", async () => {
    const env = { DB: db } as unknown as Env;
    const result = await attributorAgent.execute({
      env, runId: "run_test", agentName: "attributor", input: {}, triggeredBy: null,
    });
    expect(result.itemsCreated).toBe(MAX_MEMBER_WRITES_PER_RUN);
    // + the pending-cluster SELECT and the stamp batch.
    expect(c.roundTrips).toBeLessThan(150);
  });
});

// QA 2026-10-21: the inherited id was `tat_otxinherit_${clusterId}_${threatId}`
// and recordAttributionStmt clips ids to 100 chars. Prod live cluster ids
// reach 77 chars and threat ids are 36-char UUIDs, so every member of a
// long-id cluster clipped to ONE id: INSERT OR IGNORE kept 1 row and ignored
// the rest forever, and since the cap was charged per attempted row those
// ignored members ate the per-run budget every run.
describe.skipIf(!hasSqlite())("attributor — inherited ids are unique for long cluster ids", () => {
  const LONG = `cluster_asn_as4837_malware_distribution_${"x".repeat(40)}`; // 80 chars
  const MEMBERS = 30;
  const uuid = (i: number) => `0000${String(i).padStart(4, "0")}-1111-4222-8333-444455556666`;
  let raw: SqliteDb;
  let db: D1Database;

  function seedLong(r: SqliteDb, id: string, members: number, offset: number): string[] {
    r.prepare("INSERT OR IGNORE INTO threat_actors (id, name) VALUES ('ta_long', 'Long')").run();
    r.prepare(
      "INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status) VALUES (?, ?, ?, 'active')",
    ).run(id, id, members + 1);
    const threat = r.prepare("INSERT INTO threats (id, source_feed, threat_type, cluster_id) VALUES (?, 'test', 'phishing', ?)");
    const otx = uuid(offset);
    threat.run(otx, id);
    r.prepare("INSERT INTO threat_attributions (id, threat_id, actor_id, source) VALUES (?, ?, 'ta_long', 'otx')").run(`otx_${otx}`, otx);
    const ids: string[] = [];
    for (let i = 1; i <= members; i++) {
      const tid = uuid(offset + i);
      threat.run(tid, id);
      ids.push(tid);
    }
    return ids;
  }

  beforeEach(() => {
    raw = openMigratedDb();
    db = d1FromSqlite(raw);
  });

  it("writes every member of a >=72-char cluster with distinct ids <= 100 chars; rerun writes 0", async () => {
    expect(LONG.length).toBeGreaterThanOrEqual(72);
    // The old scheme would have overflowed the 100-char clip.
    expect(`tat_otxinherit_${LONG}_${uuid(1)}`.length).toBeGreaterThan(100);
    const members = seedLong(raw, LONG, MEMBERS, 0);

    const r = await inheritOtxActorsToClusters(db);
    expect(r.members_attributed).toBe(MEMBERS);
    expect(r.stopped_reason).toBeNull();

    const rows = raw.prepare(
      "SELECT id, threat_id, actor_id FROM threat_attributions WHERE id LIKE 'tat_otxinherit_%'",
    ).all() as Array<{ id: string; threat_id: string; actor_id: string }>;
    expect(rows).toHaveLength(MEMBERS);
    expect(new Set(rows.map((x) => x.id)).size).toBe(MEMBERS);
    expect(new Set(rows.map((x) => x.threat_id))).toEqual(new Set(members));
    for (const x of rows) {
      expect(x.id.length).toBeLessThanOrEqual(100);
      expect(x.id.startsWith(INHERITED_ID_PREFIX)).toBe(true);
      expect(x.actor_id).toBe("ta_long");
      expect(x.id).toBe(await inheritedAttributionId(LONG, x.threat_id));
    }

    const again = await inheritOtxActorsToClusters(db);
    expect(again.members_attributed).toBe(0);
    expect(again.stopped_reason).toBeNull();
  });

  it("ignored inserts do not burn the write cap (later clusters still drain)", async () => {
    // Cluster A sorts first; its members' inherited ids are already taken by
    // rows on another threat, so every insert for A is ignored. With the cap
    // set to A's size, charging attempts would stop the run before B.
    const A = `cluster_a_${"y".repeat(70)}`;
    const B = `cluster_b_${"z".repeat(70)}`;
    const aMembers = seedLong(raw, A, MEMBERS, 0);
    seedLong(raw, B, 20, 1000);
    raw.prepare("INSERT INTO threats (id, source_feed, threat_type) VALUES ('squatter', 'test', 'phishing')").run();
    const squat = raw.prepare("INSERT INTO threat_attributions (id, threat_id, actor_id, source) VALUES (?, 'squatter', 'ta_long', 'manual')");
    for (const tid of aMembers) squat.run(await inheritedAttributionId(A, tid));

    const r = await inheritOtxActorsToClusters(db, { maxMemberWrites: MEMBERS });
    expect(r.members_attributed).toBe(20);
    const bRows = raw.prepare(
      "SELECT COUNT(*) AS n FROM threat_attributions ta JOIN threats t ON t.id = ta.threat_id WHERE t.cluster_id = ? AND ta.id LIKE 'tat_otxinherit_%'",
    ).all(B)[0] as { n: number };
    expect(bRows.n).toBe(20);
  });
});
