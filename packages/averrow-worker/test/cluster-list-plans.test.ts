// Cluster list reads ordered by threat_count — query-plan pins on the fully
// migrated schema at production shape.
//
// GET /api/providers/clusters (handleListClusters) and the attribution
// backlog (handleAttributionBacklog) read the top-N clusters by
// threat_count. ~76K retired legacy rows (retired_reason='superseded',
// migration 0303) keep status 'active' / 'dormant' — the prod CHECK allows
// no other status — and their frozen counts dominate any threat_count
// order, so neither idx_clusters_threat_count nor 0301's full
// (status, threat_count) index can skip them.
// liveClusterStatusSql() (`status IN ('active', 'dormant', 'accelerating',
// 'pivot') AND retired_reason IS NULL`) + `ORDER BY +threat_count DESC`
// makes the planner seek the PARTIAL live-rows index (migration 0306) per
// status and sort only the few hundred live rows. Each plan is taken from
// the statements the handlers actually issued, without stats and after
// ANALYZE. The schema is the migrated one, which carries prod's
// CHECK (status IN ('active','dormant','disrupted')) (0136).

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
  const s = db.prepare(`INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status, retired_reason, asns, countries, actor_id)
    VALUES (?, ?, ?, ?, ?, '["AS4837"]', '["CN"]', ?)`);
  for (let i = 0; i < LEGACY; i++) {
    // Post-0303: every legacy row is retired (superseded) but keeps its
    // prod status (~92% active / 8% dormant) and a HIGH frozen count.
    s.run(`${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`,
      `legacy ${i}`, 5000 + Math.floor(rnd() * 20_000), rnd() < 0.92 ? "active" : "dormant", "superseded",
      rnd() < 0.05 ? "ta_1" : null);
  }
  const shapes: Array<[string, string | null]> = [
    ["active", null], ["active", null], ["dormant", null], ["disrupted", null],
    ["active", "shared_infra"], ["dormant", "shared_infra"], ["active", "superseded"],
  ];
  for (let i = 0; i < STABLE; i++) {
    const [status, retired] = shapes[i % shapes.length]!;
    s.run(`cluster_asn_${i}`, `stable ${i}`, Math.floor(rnd() ** 4 * 3000), status, retired,
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
  listBody: { data: Array<{ id: string; status: string; threat_count: number }> };
}> {
  const { env, log } = makeEnv(raw);
  const res = await handleListClusters(new Request("https://averrow.com/api/providers/clusters?limit=30"), env);
  expect(res.status, JSON.stringify(log.filter((e) => e.error))).toBe(200);
  const listBody = await res.json() as { data: Array<{ id: string; status: string; threat_count: number }> };
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
        it(`${which}: seeks the live statuses on the partial live-rows index, never walks a full index or scans`, () => {
          const p = modes[mode]![which];
          expect(p.sql).toContain("status IN ('active', 'dormant', 'accelerating', 'pivot') AND retired_reason IS NULL");
          if (which === "list" || which === "backlog") expect(p.sql).toMatch(/ORDER BY \+threat_count DESC/);
          expect(p.plan).toMatch(/SEARCH infrastructure_clusters USING (COVERING )?INDEX idx_clusters_live_status_threat_count \(status=\?\)/);
          expect(p.plan).not.toContain("idx_clusters_threat_count");
          expect(p.plan).not.toContain("idx_clusters_status_threat_count");
          expect(p.plan).not.toMatch(/INDEX idx_clusters_status \(/);
          expect(p.plan).not.toMatch(/SCAN infrastructure_clusters/);
        });
      }

      it("the seek reads only live rows (retired legacy rows are never visited)", () => {
        // Rows the partial index holds = the live population, not 77K —
        // even though ~70K retired rows share status 'active'.
        const live = (raw.prepare(
          "SELECT COUNT(*) AS n FROM infrastructure_clusters INDEXED BY idx_clusters_live_status_threat_count WHERE retired_reason IS NULL",
        ).all()[0] as { n: number }).n;
        const activeAll = (raw.prepare(
          "SELECT COUNT(*) AS n FROM infrastructure_clusters WHERE status = 'active'",
        ).all()[0] as { n: number }).n;
        expect(live).toBeLessThan(STABLE);
        expect(live).toBeGreaterThan(0);
        expect(activeAll).toBeGreaterThan(LEGACY / 2);
      });

      it("list returns live operations only, highest threat_count first", () => {
        const { listBody } = modes[mode]!;
        expect(listBody.data.length).toBe(30);
        const retired = new Set((raw.prepare(
          "SELECT id FROM infrastructure_clusters WHERE retired_reason IS NOT NULL",
        ).all() as Array<{ id: string }>).map((r) => r.id));
        for (const r of listBody.data) {
          expect(["active", "dormant", "accelerating", "pivot"]).toContain(r.status);
          expect(retired.has(r.id), r.id).toBe(false);
        }
        const counts = listBody.data.map((r) => r.threat_count);
        expect(counts).toEqual([...counts].sort((a, b) => b - a));
      });
    });
  }
});
