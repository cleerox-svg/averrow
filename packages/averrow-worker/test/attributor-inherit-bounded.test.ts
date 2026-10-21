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
// Since the 2026-10-21 inheritance policy no single cluster can be that
// large (<= INHERIT_MAX_CLUSTER_MEMBERS), so the fixture reaches the cap
// with many qualifying clusters instead.
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
  INHERIT_MAX_CLUSTER_MEMBERS,
  INHERIT_MIN_OTX_COVERAGE,
} from "../src/lib/cluster-attribution-inherit";
import { attributorAgent } from "../src/agents/attributor";
import type { Env } from "../src/types";

const D1_MAX_BINDS = 100;

interface Counter {
  /** D1 round-trips: each standalone statement execution, each batch call. */
  roundTrips: number;
  /** db.batch() calls (write round-trips). */
  batches: number;
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
          c.batches++;
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

// Prod-shaped load, under the 2026-10-21 inheritance policy (only
// specific-evidence clusters of <= INHERIT_MAX_CLUSTER_MEMBERS members with
// >= 2 agreeing OTX members covering >= 10% may inherit). The cap is now
// reached by MANY qualifying clusters, not one huge one:
//   * QUAL qualifying clusters (half cert-serial, half per-IP), each at the
//     size cap with 10% OTX coverage → QUAL * TO_WRITE rows, > 2 runs of the
//     cap;
//   * DONE qualifying clusters already fully inherited with actor set;
//   * the prod ASN shape (cluster_asn_as4837_malware_distribution: one OTX
//     member among thousands) → lane-skipped, nothing written;
//   * a qualifying-looking per-IP cluster whose members sit on Hostinger
//     (AS47583) → multi-tenant skip, an oversize per-IP cluster → size skip;
//   * one ambiguous cluster (two OTX actors) and one retired winner.
const SIZE = INHERIT_MAX_CLUSTER_MEMBERS; // members incl. the OTX ones
const OTX_PER = Math.ceil(SIZE * INHERIT_MIN_OTX_COVERAGE); // 25 → exactly 10%
const TO_WRITE = SIZE - OTX_PER; // 225 un-attributed per cluster
const QUAL = 50;
const DONE_CLUSTERS = 10;
const DONE_INHERITED = 175;
const EXPECTED_TOTAL = QUAL * TO_WRITE; // 11,250
// Clusters that reach the member-stats read (rules 1 + 3 pass, not retired).
const STATS_READS = QUAL + DONE_CLUSTERS + 2;

const qualId = (i: number) =>
  i % 2 === 0
    ? `cluster_cert_${String(i).padStart(4, "0")}${"ab".repeat(8)}`
    : `cluster_ip_10.1.${Math.floor(i / 200)}.${i % 200}`;

function seed(raw: SqliteDb): void {
  raw.exec("BEGIN");
  raw.prepare("INSERT INTO threat_actors (id, name) VALUES ('ta_big', 'Big'), ('ta_q', 'Q'), ('ta_done', 'Done'), ('ta_x', 'X')").run();
  const cluster = raw.prepare(
    "INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status, actor_id, retired_reason, agent_notes) VALUES (?, ?, ?, 'active', ?, ?, ?)",
  );
  const threat = raw.prepare("INSERT INTO threats (id, source_feed, threat_type, cluster_id, asn) VALUES (?, 'test', 'phishing', ?, ?)");
  const attr = raw.prepare("INSERT INTO threat_attributions (id, threat_id, actor_id, source) VALUES (?, ?, ?, ?)");

  let n = 0;
  const addCluster = (o: {
    id: string; otx: number; plain: number; actor: string; clusterActor?: string | null;
    retired?: string | null; inheritedAlready?: boolean; asn?: string | null; notes?: string | null;
  }) => {
    cluster.run(o.id, o.id, o.otx + o.plain, o.clusterActor ?? null, o.retired ?? null, o.notes ?? null);
    for (let k = 0; k < o.otx; k++) {
      const tid = `thr_${n++}`;
      threat.run(tid, o.id, o.asn ?? "AS64500");
      attr.run(`otx_${tid}`, tid, o.actor, "otx");
    }
    for (let i = 0; i < o.plain; i++) {
      const tid = `thr_${n++}`;
      threat.run(tid, o.id, o.asn ?? "AS64500");
      if (o.inheritedAlready) attr.run(`tat_otxinherit_${o.id}_${tid}`, tid, o.actor, "nexus");
    }
  };

  const certNotes = JSON.stringify({ cluster_type: "ssl_cert_serial", ssl_cert_serial: "0a1b" });
  for (let i = 0; i < QUAL; i++) {
    addCluster({ id: qualId(i), otx: OTX_PER, plain: TO_WRITE, actor: "ta_q", notes: i % 2 === 0 ? certNotes : null });
  }
  for (let i = 0; i < DONE_CLUSTERS; i++) {
    addCluster({ id: `cluster_ip_10.9.0.${i}`, otx: OTX_PER, plain: DONE_INHERITED, actor: "ta_done", clusterActor: "ta_done", inheritedAlready: true });
  }
  addCluster({ id: "cluster_asn_as4837_malware_distribution", otx: 1, plain: 2_000, actor: "ta_big", asn: "AS4837" });
  addCluster({ id: "cluster_ip_192.0.2.10", otx: 5, plain: 20, actor: "ta_q", asn: "AS47583 Hostinger International Limited" });
  addCluster({ id: "cluster_ip_192.0.2.11", otx: 40, plain: SIZE, actor: "ta_q" });
  addCluster({ id: "cluster_ip_192.0.2.12", otx: 5, plain: 20, actor: "ta_q", retired: "shared_infra" });
  addCluster({ id: "cluster_ip_192.0.2.13", otx: 5, plain: 20, actor: "ta_q" });
  raw.prepare("INSERT INTO threats (id, source_feed, threat_type, cluster_id) VALUES ('amb_otx2', 'test', 'phishing', 'cluster_ip_192.0.2.13')").run();
  raw.prepare("INSERT INTO threat_attributions (id, threat_id, actor_id, source) VALUES ('otx_amb2', 'amb_otx2', 'ta_x', 'otx')").run();
  raw.exec("COMMIT");
}

const inheritedCount = (raw: SqliteDb): number =>
  (raw.prepare("SELECT COUNT(*) AS n FROM threat_attributions WHERE id LIKE 'tat_otxinherit_%' AND source = 'nexus'").all()[0] as { n: number }).n
  - DONE_CLUSTERS * DONE_INHERITED;

describe.skipIf(!hasSqlite())("attributor — OTX inheritance is bounded per run (2026-10-21 hang)", () => {
  let raw: SqliteDb;
  let c: Counter;
  let db: D1Database;

  beforeEach(() => {
    raw = openMigratedDb();
    seed(raw);
    c = { roundTrips: 0, batches: 0, maxBatch: 0, maxBinds: 0 };
    db = counting(d1FromSqlite(raw), c);
  });

  it("first run writes exactly the cap in a bounded number of D1 round-trips", async () => {
    const r = await inheritOtxActorsToClusters(db);

    expect(r.members_attributed).toBe(MAX_MEMBER_WRITES_PER_RUN);
    expect(r.stopped_reason).toBe("write_cap");
    expect(inheritedCount(raw)).toBe(MAX_MEMBER_WRITES_PER_RUN);
    expect(r.clusters_skipped_lane).toBe(1);
    expect(r.clusters_skipped_multitenant).toBe(1);
    expect(r.clusters_skipped_size).toBe(1);
    expect(r.clusters_ambiguous).toBe(1);
    expect(r.clusters_retired_skipped).toBe(1);

    // discovery + cluster-row chunks + one bounded stats read per candidate
    // + ≤1 member read per eligible cluster reached + ceil(cap / WRITE_BATCH)
    // batches + ≤1 extra batch per cluster boundary.
    const scanned = QUAL + DONE_CLUSTERS + 5;
    const reached = DONE_CLUSTERS + Math.ceil(MAX_MEMBER_WRITES_PER_RUN / TO_WRITE);
    const bound = 1 + Math.ceil(scanned / 90) + STATS_READS + reached + Math.ceil(MAX_MEMBER_WRITES_PER_RUN / WRITE_BATCH) + reached;
    expect(c.roundTrips).toBeLessThanOrEqual(bound);
    // Independent of member count: far fewer round-trips than rows written.
    expect(c.roundTrips).toBeLessThan(MAX_MEMBER_WRITES_PER_RUN / 20);
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
    expect(runs.length).toBeGreaterThanOrEqual(3);
    // A run that lands exactly on the cap reports 'write_cap' even if
    // nothing is left, so allow one trailing empty run.
    expect(runs.length).toBeLessThanOrEqual(Math.ceil(EXPECTED_TOTAL / MAX_MEMBER_WRITES_PER_RUN) + 1);
    expect(inheritedCount(raw)).toBe(EXPECTED_TOTAL);

    // Every inherited row carries its cluster's actor; skipped clusters are
    // untouched.
    const wrongActor = raw.prepare(`
      SELECT COUNT(*) AS n FROM threat_attributions ta JOIN threats t ON t.id = ta.threat_id
       WHERE ta.id LIKE 'tat_otxinherit_%'
         AND ta.actor_id != CASE WHEN t.cluster_id LIKE 'cluster_ip_10.9.%' THEN 'ta_done' ELSE 'ta_q' END`).all()[0] as { n: number };
    expect(wrongActor.n).toBe(0);
    const untouched = raw.prepare(`
      SELECT COUNT(*) AS n FROM threats t
       WHERE t.cluster_id IN ('cluster_asn_as4837_malware_distribution', 'cluster_ip_192.0.2.10',
                              'cluster_ip_192.0.2.11', 'cluster_ip_192.0.2.12', 'cluster_ip_192.0.2.13')
         AND EXISTS (SELECT 1 FROM threat_attributions ta WHERE ta.threat_id = t.id AND ta.source = 'nexus')`).all()[0] as { n: number };
    expect(untouched.n).toBe(0);
    const actors = raw.prepare(`
      SELECT id, actor_id FROM infrastructure_clusters
       WHERE id IN (?, ?, 'cluster_asn_as4837_malware_distribution', 'cluster_ip_192.0.2.10',
                    'cluster_ip_192.0.2.11', 'cluster_ip_192.0.2.12', 'cluster_ip_192.0.2.13')
       ORDER BY id`).all(qualId(0), qualId(QUAL - 1));
    expect(actors).toEqual([
      { id: "cluster_asn_as4837_malware_distribution", actor_id: null },
      { id: qualId(0), actor_id: "ta_q" },
      { id: qualId(QUAL - 1), actor_id: "ta_q" },
      { id: "cluster_ip_192.0.2.10", actor_id: null },
      { id: "cluster_ip_192.0.2.11", actor_id: null },
      { id: "cluster_ip_192.0.2.12", actor_id: null },
      { id: "cluster_ip_192.0.2.13", actor_id: null },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(runs.reduce((s, r) => s + r.clusters_actor_set, 0)).toBe(QUAL);

    // Idempotent once drained.
    const again = await inheritOtxActorsToClusters(db);
    expect(again.members_attributed).toBe(0);
    expect(again.clusters_actor_set).toBe(0);
    expect(again.stopped_reason).toBeNull();
  });

  it("stops cleanly at the wall-clock budget between write round-trips and resumes next run", async () => {
    // The clock advances 1s per write batch; a 10s budget allows ~10 batches.
    const now = () => c.batches * 1_000;
    const r = await inheritOtxActorsToClusters(db, { budgetMs: 10_000, now });

    expect(r.stopped_reason).toBe("deadline");
    expect(r.members_attributed).toBeGreaterThan(0);
    expect(r.members_attributed).toBeLessThan(MAX_MEMBER_WRITES_PER_RUN);
    expect(inheritedCount(raw)).toBe(r.members_attributed);
    // The first cluster it worked on is already named.
    const first = raw.prepare("SELECT actor_id FROM infrastructure_clusters WHERE id = ?").all(qualId(0))[0];
    expect(first).toEqual({ actor_id: "ta_q" });

    const next = await inheritOtxActorsToClusters(db);
    expect(next.members_attributed).toBe(MAX_MEMBER_WRITES_PER_RUN);
    expect(inheritedCount(raw)).toBe(r.members_attributed + MAX_MEMBER_WRITES_PER_RUN);
  });

  it("a deadline during the member-stats reads stops before any write", async () => {
    let t = 0;
    const now = () => (t += 1_000);
    const r = await inheritOtxActorsToClusters(db, { budgetMs: 5_000, now });
    expect(r.stopped_reason).toBe("deadline");
    expect(r.members_attributed).toBe(0);
    expect(r.clusters_actor_set).toBe(0);
    expect(c.batches).toBe(0);
    expect(inheritedCount(raw)).toBe(0);
  });

  it("attributorAgent.execute finishes on the prod-shaped fixture in bounded round-trips", async () => {
    const env = { DB: db } as unknown as Env;
    const result = await attributorAgent.execute({
      env, runId: "run_test", agentName: "attributor", input: {}, triggeredBy: null,
    });
    expect(result.itemsCreated).toBe(MAX_MEMBER_WRITES_PER_RUN);
    expect(c.roundTrips).toBeLessThan(MAX_MEMBER_WRITES_PER_RUN / 20);
  });
});

// QA 2026-10-21: the inherited id was `tat_otxinherit_${clusterId}_${threatId}`
// and recordAttributionStmt clips ids to 100 chars. Prod live cluster ids
// reach 77 chars and threat ids are 36-char UUIDs, so every member of a
// long-id cluster clipped to ONE id: INSERT OR IGNORE kept 1 row and ignored
// the rest forever, and since the cap was charged per attempted row those
// ignored members ate the per-run budget every run.
describe.skipIf(!hasSqlite())("attributor — inherited ids are unique for long cluster ids", () => {
  // cert-serial lane (agent_notes NULL → serial), so the policy admits it.
  const LONG = `cluster_cert_${"x".repeat(67)}`; // 80 chars
  const MEMBERS = 30;
  // >= 2 agreeing OTX members and >= 10% coverage for both fixtures.
  const OTX = 4;
  const uuid = (i: number) => `0000${String(i).padStart(4, "0")}-1111-4222-8333-444455556666`;
  let raw: SqliteDb;
  let db: D1Database;

  function seedLong(r: SqliteDb, id: string, members: number, offset: number): string[] {
    r.prepare("INSERT OR IGNORE INTO threat_actors (id, name) VALUES ('ta_long', 'Long')").run();
    r.prepare(
      "INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status) VALUES (?, ?, ?, 'active')",
    ).run(id, id, members + OTX);
    const threat = r.prepare("INSERT INTO threats (id, source_feed, threat_type, cluster_id) VALUES (?, 'test', 'phishing', ?)");
    for (let k = 0; k < OTX; k++) {
      const otx = uuid(offset + 500 + k);
      threat.run(otx, id);
      r.prepare("INSERT INTO threat_attributions (id, threat_id, actor_id, source) VALUES (?, ?, 'ta_long', 'otx')").run(`otx_${otx}`, otx);
    }
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
    const A = `cluster_cert_a_${"y".repeat(70)}`;
    const B = `cluster_cert_b_${"z".repeat(70)}`;
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
