/**
 * Regression: D1 caps bound parameters at 100 per statement.
 *
 * Both NEXUS workflow runs on 2026-11-07 terminated with
 * `D1_ERROR: too many SQL variables at offset 457: SQLITE_ERROR`. The
 * overflowing statement was the infra-movement member aggregate in
 * lib/cluster-infra-movement.ts, which chunked its `cluster_id IN (…)` list
 * at 400 ids (sized for SQLite's 999 ceiling, not D1's 100). Offset 457 is
 * exactly the 101st `?` of that SQL with a 400-id chunk.
 *
 * The fake D1 below enforces the real cap — any statement bound with more
 * than 100 parameters throws the same error prod raised — and is driven with
 * a population far larger than one chunk, for every dynamic IN-list in the
 * NEXUS workflow's tail steps (infra-movement, update-provider-trends).
 */

import { describe, it, expect } from "vitest";
import {
  detectClusterInfraMovement,
  MEMBER_QUERY_CHUNK,
} from "../src/lib/cluster-infra-movement";
import {
  updateProviderTrends,
  PROVIDER_TRENDS_BIND_CHUNK,
} from "../src/lib/provider-trends";

const D1_MAX_BINDS = 100;

interface BindCapDb {
  db: D1Database;
  maxBindsSeen: () => number;
  statements: Array<{ sql: string; binds: unknown[] }>;
}

/** Fake D1 that rejects >100 binds the way prod does. `respond` returns rows
 *  for `.all()` given the SQL + binds. */
function bindCapDb(respond: (sql: string, binds: unknown[]) => unknown[]): BindCapDb {
  let maxSeen = 0;
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  const enforce = (sql: string, binds: unknown[]) => {
    maxSeen = Math.max(maxSeen, binds.length);
    if (binds.length > D1_MAX_BINDS) {
      throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
    }
    statements.push({ sql, binds });
  };
  const prepare = (sql: string) => {
    let binds: unknown[] = [];
    const stmt = {
      sql,
      get binds() { return binds; },
      bind(...args: unknown[]) { binds = args; return stmt; },
      async all() { enforce(sql, binds); return { results: respond(sql, binds) }; },
      async first() { enforce(sql, binds); return respond(sql, binds)[0] ?? null; },
      async run() { enforce(sql, binds); return { success: true, meta: { changes: 0 } }; },
    };
    return stmt;
  };
  const db = {
    prepare,
    async batch(stmts: Array<{ sql: string; binds: unknown[] }>) {
      return stmts.map((s) => { enforce(s.sql, s.binds); return { success: true, meta: { changes: 0 } }; });
    },
  };
  return {
    db: db as unknown as D1Database,
    maxBindsSeen: () => maxSeen,
    statements,
  };
}

describe("NEXUS tail steps stay under D1's 100-bind cap", () => {
  it("chunk constants are under the cap", () => {
    expect(MEMBER_QUERY_CHUNK).toBeLessThanOrEqual(90);
    expect(PROVIDER_TRENDS_BIND_CHUNK).toBeLessThanOrEqual(90);
  });

  it("infra-movement member aggregate chunks 1,000 bridge clusters into ≤100-bind statements", async () => {
    const N = 1000;
    const clusters = Array.from({ length: N }, (_, i) => ({
      id: `cluster_ip_10.0.${Math.floor(i / 250)}.${i % 250}`,
      cluster_name: `op ${i}`,
      brand_fanout: 2,
      agent_notes: null,
      confidence_score: 80,
      infra_fingerprint: null,
      last_movement_pivot_at: null,
    }));
    const { db, maxBindsSeen, statements } = bindCapDb((sql, binds) => {
      if (sql.includes("FROM infrastructure_clusters")) return clusters;
      if (sql.includes("FROM threats")) {
        return (binds as string[]).map((id) => ({ cluster_id: id, asns: "AS1", ips: "1.1.1.1", serials: null }));
      }
      return [];
    });

    const r = await detectClusterInfraMovement(db, Date.parse("2026-11-07T12:00:00Z"));

    expect(maxBindsSeen()).toBeLessThanOrEqual(D1_MAX_BINDS);
    const memberReads = statements.filter((s) => s.sql.includes("WHERE cluster_id IN"));
    expect(memberReads).toHaveLength(Math.ceil(N / MEMBER_QUERY_CHUNK));
    // Every cluster was covered exactly once (no drop at chunk boundaries).
    const covered = memberReads.flatMap((s) => s.binds as string[]);
    expect(new Set(covered).size).toBe(N);
    expect(r.bridgeClustersConsidered).toBe(N);
  });

  it("provider-trends current-trend read + zeroing UPDATE chunk 1,000 providers into ≤100-bind statements", async () => {
    const N = 1000;
    const agg = Array.from({ length: N }, (_, i) => ({
      hosting_provider_id: `hp_${i}`,
      count_7d: i,
      count_30d: i * 2,
    }));
    const stale = Array.from({ length: N }, (_, i) => ({ id: `hp_stale_${i}` }));
    const { db, maxBindsSeen, statements } = bindCapDb((sql) => {
      if (sql.includes("threat_cube_provider")) return agg;
      if (sql.includes("WHERE COALESCE(trend_7d, 0) != 0 OR")) return stale;
      return [];
    });

    const r = await updateProviderTrends(db);

    expect(maxBindsSeen()).toBeLessThanOrEqual(D1_MAX_BINDS);
    expect(r.providers_evaluated).toBe(N);
    const reads = statements.filter((s) => /SELECT id, trend_7d, trend_30d FROM hosting_providers WHERE id IN/.test(s.sql));
    expect(reads).toHaveLength(Math.ceil(N / PROVIDER_TRENDS_BIND_CHUNK));
    const zeroes = statements.filter((s) => /trend_7d = 0/.test(s.sql));
    expect(zeroes).toHaveLength(Math.ceil(N / PROVIDER_TRENDS_BIND_CHUNK));
  });

  it("the fake really rejects the pre-fix 400-id chunk (guards the guard)", async () => {
    const { db } = bindCapDb(() => []);
    const ids = Array.from({ length: 400 }, (_, i) => `c${i}`);
    await expect(
      db.prepare(`SELECT 1 FROM threats WHERE cluster_id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids).all(),
    ).rejects.toThrow(/too many SQL variables/);
  });
});
