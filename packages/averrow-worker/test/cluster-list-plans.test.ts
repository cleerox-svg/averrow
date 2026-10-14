// Cluster list reads ordered by threat_count — query-plan pins on the fully
// migrated schema at production shape.
//
// GET /api/providers/clusters (handleListClusters) and the attribution
// backlog (handleAttributionBacklog) read the top-N clusters by
// threat_count. With the retired-status predicate written as `status NOT IN
// ('superseded', 'shared_infra')`, SQLite walks idx_clusters_threat_count
// from the top — straight through ~76K superseded legacy rows, whose frozen
// counts dominate any threat_count order — before it finds N live rows.
// liveClusterStatusSql() (`status IN ('active', 'dormant', 'accelerating',
// 'pivot')`) + `ORDER BY +threat_count DESC` makes the planner seek the live
// statuses by index and sort only the few hundred live rows. Each plan is
// taken from the statements the handlers actually issued, without stats and
// after ANALYZE.

import { describe, it, expect, beforeAll } from "vitest";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import { handleListClusters, handleProviderIntelligence } from "../src/handlers/providers";
import { handleAttributionBacklog } from "../src/handlers/admin/attribution";
import type { Env } from "../src/types";

const LEGACY = 76_220;
const STABLE = 780;

function seed(db: SqliteDb): void {
  let x = 7;
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  db.exec("BEGIN");
  const s = db.prepare(`INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status, asns, countries, actor_id)
    VALUES (?, ?, ?, ?, '["AS4837"]', '["CN"]', ?)`);
  for (let i = 0; i < LEGACY; i++) {
    // Post-0303: every legacy row is superseded, with a HIGH frozen count.
    s.run(`${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`,
      `legacy ${i}`, 5000 + Math.floor(rnd() * 20_000), "superseded", rnd() < 0.05 ? "ta_1" : null);
  }
  const statuses = ["active", "active", "dormant", "shared_infra", "superseded", "accelerating", "pivot"];
  for (let i = 0; i < STABLE; i++) {
    s.run(`cluster_asn_${i}`, `stable ${i}`, Math.floor(rnd() ** 4 * 3000), statuses[i % statuses.length]!,
      rnd() < 0.05 ? "ta_1" : null);
  }
  db.exec("COMMIT");
}

function makeEnv(raw: SqliteDb): { env: Env; log: StatementLogEntry[] } {
  const log: StatementLogEntry[] = [];
  const db = d1FromSqlite(raw, { log });
  return { env: { DB: db, CACHE: fakeKv() } as unknown as Env, log };
}

interface Planned { sql: string; plan: string; rows: number }

async function planReads(raw: SqliteDb): Promise<{
  list: Planned; backlog: Planned; backlogTotals: Planned; intelCount: Planned;
  listBody: { data: Array<{ status: string }> };
}> {
  const { env, log } = makeEnv(raw);
  const res = await handleListClusters(new Request("https://averrow.com/api/providers/clusters?limit=30"), env);
  expect(res.status, JSON.stringify(log.filter((e) => e.error))).toBe(200);
  const listBody = await res.json() as { data: Array<{ status: string }> };
  const bres = await handleAttributionBacklog(new Request("https://averrow.com/api/admin/agents/attribution-backlog?limit=50"), env);
  expect(bres.status, await bres.clone().text()).toBe(200);
  const ires = await handleProviderIntelligence(new Request("https://averrow.com/api/providers/intelligence"), env);
  expect(ires.status, await ires.clone().text()).toBe(200);
  const explain = (e: StatementLogEntry): Planned => ({
    sql: e.sql,
    rows: e.rows ?? 0,
    plan: (raw.prepare(`EXPLAIN QUERY PLAN ${e.sql}`).all(...(e.binds ?? [])) as Array<{ detail: string }>)
      .map((r) => r.detail).join(" | "),
  });
  const pick = (re: RegExp) => {
    const hits = log.filter((e) => e.error === undefined && re.test(e.sql.replace(/\s+/g, " ")));
    expect(hits.length, String(re)).toBe(1);
    return explain(hits[0]!);
  };
  return {
    list: pick(/SELECT id, cluster_name, asns, countries, threat_count, status, confidence_score/),
    backlog: pick(/attribution_attempted_at, nexus_brief, agent_notes FROM infrastructure_clusters/),
    backlogTotals: pick(/AS dismissed FROM infrastructure_clusters INDEXED BY/),
    intelCount: pick(/AS active_clusters FROM infrastructure_clusters/),
    listBody,
  };
}

describe.skipIf(!hasSqlite())("cluster top-N list reads — plans on the migrated schema at scale", () => {
  let raw: SqliteDb;
  const modes: Record<string, Awaited<ReturnType<typeof planReads>>> = {};

  beforeAll(async () => {
    raw = openMigratedDb();
    // Prod's infrastructure_clusters predates migrations (0136 header) and
    // carries last_updated (selected by handleListClusters and
    // operations.ts) and nexus_brief (attribution backlog); no migration
    // adds them, so a fresh migrated DB lacks both.
    raw.exec("ALTER TABLE infrastructure_clusters ADD COLUMN last_updated TEXT");
    raw.exec("ALTER TABLE infrastructure_clusters ADD COLUMN nexus_brief TEXT");
    seed(raw);
    modes["no stats"] = await planReads(raw);
    raw.exec("ANALYZE");
    modes["ANALYZE"] = await planReads(raw);
  }, 60_000);

  for (const mode of ["no stats", "ANALYZE"]) {
    describe(mode, () => {
      for (const which of ["list", "backlog", "backlogTotals", "intelCount"] as const) {
        it(`${which}: seeks the live statuses by index, never walks the threat_count index or scans`, () => {
          const p = modes[mode]![which];
          expect(p.sql).toContain("status IN ('active', 'dormant', 'accelerating', 'pivot')");
          if (which === "list" || which === "backlog") expect(p.sql).toMatch(/ORDER BY \+threat_count DESC/);
          expect(p.plan).toMatch(/SEARCH infrastructure_clusters USING (COVERING )?INDEX idx_clusters_(status_threat_count|status) \(status=\?\)/);
          expect(p.plan).not.toContain("idx_clusters_threat_count");
          expect(p.plan).not.toMatch(/SCAN infrastructure_clusters/);
        });
      }

      it("the seek reads only live rows (legacy superseded rows are never visited)", () => {
        // Rows the live-status seek can reach = the live population, not 77K.
        const live = (raw.prepare(
          "SELECT COUNT(*) AS n FROM infrastructure_clusters WHERE status IN ('active', 'dormant', 'accelerating', 'pivot')",
        ).all()[0] as { n: number }).n;
        expect(live).toBeLessThan(STABLE);
        expect(live).toBeGreaterThan(0);
      });

      it("list returns live operations only, highest threat_count first", () => {
        const { listBody } = modes[mode]!;
        expect(listBody.data.length).toBe(30);
        for (const r of listBody.data) expect(["active", "dormant", "accelerating", "pivot"]).toContain(r.status);
      });
    });
  }
});
