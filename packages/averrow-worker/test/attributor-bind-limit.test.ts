// Regression: the attributor auto-paused in prod on 2026-07-21 with
//   D1_ERROR: too many SQL variables at offset 281: SQLITE_ERROR
// D1 caps a statement at 100 bound parameters (local SQLite allows 999, so
// plain SQLite tests can't catch this). lib/cluster-attribution-inherit.ts
// chunked its IN(...) lists at 800; offset 281 is the 101st `?` of its
// Step 2 `infrastructure_clusters WHERE id IN (...)` lookup, which ran once
// more than 100 clusters won the OTX inheritance decision.
//
// The D1 shim below enforces the 100-variable cap the way D1 does, and the
// fixture has 150 winning clusters (and 150 pending ones for the agent).

import { describe, it, expect, beforeEach } from "vitest";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { hasSqlite, openMigratedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import { inheritOtxActorsToClusters } from "../src/lib/cluster-attribution-inherit";
import { attributorAgent } from "../src/agents/attributor";
import type { Env } from "../src/types";

const D1_MAX_BINDS = 100;
const WINNING_CLUSTERS = 150;

/** Wrap a D1 shim so any statement with >100 bound parameters throws, as D1 does. */
function withD1BindLimit(db: D1Database, seen: { max: number }): D1Database {
  const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === "bind") {
          return (...args: unknown[]) => {
            seen.max = Math.max(seen.max, args.length);
            if (args.length > D1_MAX_BINDS) {
              throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
            }
            return wrapStmt(target.bind(...args));
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") return (sql: string) => wrapStmt(target.prepare(sql));
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

const cid = (i: number) => `cluster_ip_10.0.${Math.floor(i / 250)}.${i % 250}`;

describe.skipIf(!hasSqlite())("attributor — D1 100-variable bind limit", () => {
  let raw: SqliteDb;
  let seen: { max: number };
  let db: D1Database;

  beforeEach(() => {
    raw = openMigratedDb();
    seen = { max: 0 };
    db = withD1BindLimit(d1FromSqlite(raw), seen);

    raw.prepare("INSERT INTO threat_actors (id, name) VALUES ('ta_1', 'Actor One'), ('ta_2', 'Actor Two')").run();
    const cluster = raw.prepare(
      "INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status, retired_reason) VALUES (?, ?, ?, 'active', ?)",
    );
    const threat = raw.prepare(
      "INSERT INTO threats (id, source_feed, threat_type, cluster_id) VALUES (?, 'test', 'phishing', ?)",
    );
    const otx = raw.prepare(
      "INSERT INTO threat_attributions (id, threat_id, actor_id, source) VALUES (?, ?, ?, 'otx')",
    );
    // 150 live per-IP clusters, each: two OTX members naming the same actor
    // (the inheritance quorum) + two un-attributed siblings.
    for (let i = 0; i < WINNING_CLUSTERS; i++) {
      cluster.run(cid(i), `c${i}`, 4, null);
      threat.run(`thr_${i}_otx`, cid(i));
      threat.run(`thr_${i}_otx2`, cid(i));
      threat.run(`thr_${i}_a`, cid(i));
      threat.run(`thr_${i}_b`, cid(i));
      otx.run(`tat_${i}`, `thr_${i}_otx`, "ta_1");
      otx.run(`tat_${i}_2`, `thr_${i}_otx2`, "ta_1");
    }
    // A retired cluster that would otherwise win, and an ambiguous one.
    cluster.run("cluster_retired", "retired", 2, "shared_infra");
    threat.run("thr_r_otx", "cluster_retired");
    threat.run("thr_r_a", "cluster_retired");
    otx.run("tat_r", "thr_r_otx", "ta_1");
    // Per-IP (specific lane) so it is the actor disagreement, not the lane
    // rule, that skips it.
    cluster.run("cluster_ip_192.0.2.250", "ambiguous", 3, null);
    threat.run("thr_x1", "cluster_ip_192.0.2.250");
    threat.run("thr_x2", "cluster_ip_192.0.2.250");
    threat.run("thr_x3", "cluster_ip_192.0.2.250");
    otx.run("tat_x1", "thr_x1", "ta_1");
    otx.run("tat_x2", "thr_x2", "ta_2");
  });

  it("the shim really enforces the cap (so the tests below are meaningful)", () => {
    const tooMany = new Array(D1_MAX_BINDS + 1).fill("x");
    expect(() =>
      db.prepare(`SELECT 1 WHERE 'x' IN (${tooMany.map(() => "?").join(",")})`).bind(...tooMany),
    ).toThrow(/too many SQL variables/);
  });

  it(`inheritOtxActorsToClusters handles ${WINNING_CLUSTERS} winning clusters without exceeding 100 binds`, async () => {
    const r = await inheritOtxActorsToClusters(db);

    expect(seen.max).toBeGreaterThan(0);
    expect(seen.max).toBeLessThanOrEqual(D1_MAX_BINDS);

    expect(r.clusters_scanned).toBe(WINNING_CLUSTERS + 2);
    expect(r.clusters_ambiguous).toBe(1);
    expect(r.clusters_retired_skipped).toBe(1);
    expect(r.clusters_inherited).toBe(WINNING_CLUSTERS);
    expect(r.members_attributed).toBe(WINNING_CLUSTERS * 2);
    expect(r.clusters_actor_set).toBe(WINNING_CLUSTERS);

    // Every chunk landed: the clusters past the first chunk got their actor too.
    const unset = raw.prepare(
      "SELECT COUNT(*) AS n FROM infrastructure_clusters WHERE id LIKE 'cluster_ip_10.0.%' AND actor_id IS NULL",
    ).all()[0] as { n: number };
    expect(unset.n).toBe(0);
    // Retired cluster untouched.
    const retired = raw.prepare("SELECT actor_id FROM infrastructure_clusters WHERE id = 'cluster_retired'").all()[0] as
      { actor_id: string | null };
    expect(retired.actor_id).toBeNull();
    // Ambiguous cluster untouched.
    const ambiguous = raw.prepare("SELECT actor_id FROM infrastructure_clusters WHERE id = 'cluster_ip_192.0.2.250'").all()[0] as
      { actor_id: string | null };
    expect(ambiguous.actor_id).toBeNull();

    // Idempotent re-run: nothing new written, still under the cap.
    const again = await inheritOtxActorsToClusters(db);
    expect(again.members_attributed).toBe(0);
    expect(again.clusters_actor_set).toBe(0);
    expect(seen.max).toBeLessThanOrEqual(D1_MAX_BINDS);
  });

  it("attributorAgent.execute completes end-to-end under the cap with >100 pending clusters", async () => {
    // 152 pending clusters (all actor_id NULL, never attempted) and 150
    // inheritance winners: the shape that tripped the prod run.
    const env = { DB: db } as unknown as Env;
    const result = await attributorAgent.execute({
      env,
      runId: "run_test",
      agentName: "attributor",
      input: {},
      triggeredBy: null,
    });

    expect(seen.max).toBeLessThanOrEqual(D1_MAX_BINDS);
    expect(result.itemsProcessed).toBe(25); // CLUSTER_BATCH stamp batch
    expect(result.itemsUpdated).toBe(WINNING_CLUSTERS);
    expect(result.itemsCreated).toBe(WINNING_CLUSTERS * 2);
  });
});
