// Cluster list reads ordered by threat_count — query-plan pins on the fully
// migrated schema at production shape.
//
// GET /api/providers/clusters (handleListClusters), the attribution
// backlog (handleAttributionBacklog), GET /api/providers/:id/clusters
// (handleProviderClusters), GET /api/trends/nexus-active and the critical
// banner's mass-impersonation read (handleIntelCriticalBanner) read
// clusters by threat_count. ~76K retired legacy rows (retired_reason='superseded',
// migration 0303) keep status 'active' / 'dormant' — the prod CHECK allows
// no other status — and their frozen counts dominate any threat_count
// order, so neither 0298's idx_clusters_threat_count nor 0301's full
// (status, threat_count) index could skip them; migration 0308 dropped both.
// The `not.toContain` checks below keep guarding against a re-added full
// threat_count index being picked.
// liveClusterStatusSql() (`status IN ('active', 'dormant', 'disrupted', 'accelerating',
// 'pivot') AND retired_reason IS NULL`) + `ORDER BY +threat_count DESC`
// makes the planner seek the PARTIAL live-rows index (migration 0306) per
// status and sort only the few hundred live rows. Each plan is taken from
// the statements the handlers actually issued, without stats and after
// ANALYZE. The schema is the migrated one, which carries prod's
// CHECK (status IN ('active','dormant','disrupted')) (0136).

import { describe, it, expect, beforeAll } from "vitest";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import { handleListClusters, handleProviderIntelligence, handleProviderClusters } from "../src/handlers/providers";
import { handleAttributionBacklog } from "../src/handlers/admin/attribution";
import { handleIntelCriticalBanner } from "../src/handlers/intel";
import { handleTrendNexusActive } from "../src/handlers/trends";
import { attributorAgent } from "../src/agents/attributor";
import type { Env } from "../src/types";

const LEGACY = 76_220;
const STABLE = 780;
/** cluster_ip_* rows (per-IP lane), every 3rd one retired. */
const IP_ROWS = 60;
/** Banner read: the PK range over cluster_ip_* ids, or a live-only partial index. */
const BANNER_PLAN = /SEARCH infrastructure_clusters USING INDEX (sqlite_autoindex_infrastructure_clusters_1 \(id>\? AND id<\?\)|idx_clusters_live_status_threat_count|idx_clusters_actor_live)/;

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
  // Per-IP rows for the critical-banner read. The retired ones carry the
  // biggest counts, so a plan that ignored retirement would return one.
  const ip = db.prepare(`INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status, retired_reason, asns, brand_ids)
    VALUES (?, ?, ?, 'active', ?, '["AS9009"]', ?)`);
  const brands = JSON.stringify(Array.from({ length: 120 }, (_, k) => `b${k}`));
  for (let i = 0; i < IP_ROWS; i++) {
    const retired = i % 3 === 0;
    ip.run(`cluster_ip_203.0.113.${i}`, `IP ${i}`, retired ? 90_000 + i : 100 + i, retired ? "shared_infra" : null, brands);
  }
  db.prepare("INSERT INTO hosting_providers (id, name, asn) VALUES ('hp_cu', 'China Unicom', 'AS4837')").run();
  db.exec("COMMIT");
}

function makeEnv(raw: SqliteDb): { env: Env; log: StatementLogEntry[] } {
  const log: StatementLogEntry[] = [];
  const db = d1FromSqlite(raw, { log });
  return { env: { DB: db, CACHE: fakeKv() } as unknown as Env, log };
}

interface Planned { sql: string; plan: string; rows: number }

type ClusterBody = { data: Array<{ id: string; status: string; threat_count: number }> };

async function planReads(raw: SqliteDb): Promise<{
  list: Planned; backlog: Planned; backlogTotals: Planned; intelCount: Planned;
  providerClusters: Planned; trendsNexus: Planned; bannerIp: Planned; attributorPending: Planned;
  listBody: ClusterBody; providerBody: ClusterBody; trendsBody: ClusterBody;
  bannerBody: { data: { events: Array<{ kind: string; link: string }> } };
}> {
  const { env, log } = makeEnv(raw);
  const res = await handleListClusters(new Request("https://averrow.com/api/providers/clusters?limit=30"), env);
  expect(res.status, JSON.stringify(log.filter((e) => e.error))).toBe(200);
  const listBody = await res.json() as { data: Array<{ id: string; status: string; threat_count: number }> };
  const bres = await handleAttributionBacklog(new Request("https://averrow.com/api/admin/agents/attribution-backlog?limit=50"), env);
  expect(bres.status, await bres.clone().text()).toBe(200);
  const ires = await handleProviderIntelligence(new Request("https://averrow.com/api/providers/intelligence"), env);
  expect(ires.status, await ires.clone().text()).toBe(200);
  const pres = await handleProviderClusters(new Request("https://averrow.com/api/providers/hp_cu/clusters"), env, "hp_cu");
  expect(pres.status, await pres.clone().text()).toBe(200);
  const providerBody = await pres.json() as ClusterBody;
  const tres = await handleTrendNexusActive(new Request("https://averrow.com/api/trends/nexus-active"), env);
  expect(tres.status, await tres.clone().text()).toBe(200);
  const trendsBody = await tres.json() as ClusterBody;
  const bnres = await handleIntelCriticalBanner(new Request("https://averrow.com/api/intel/critical-banner"), env);
  expect(bnres.status, await bnres.clone().text()).toBe(200);
  const bannerBody = await bnres.json() as { data: { events: Array<{ kind: string; link: string }> } };
  // Drive the real attributor so its pending-cluster SELECT comes from
  // source. Run last: it stamps attribution_attempted_at on the batch it picks.
  const ares = await attributorAgent.execute({
    env, runId: "run_plan_pin", agentName: "attributor", input: {}, triggeredBy: null,
  });
  expect(ares.itemsProcessed, JSON.stringify(log.filter((e) => e.error))).toBeGreaterThan(0);
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
    list: pick(/first_detected, last_seen, last_updated FROM infrastructure_clusters/),
    backlog: pick(/attribution_attempted_at, nexus_brief, agent_notes FROM infrastructure_clusters/),
    backlogTotals: pick(/AS dismissed FROM infrastructure_clusters INDEXED BY/),
    intelCount: pick(/AS active_clusters FROM infrastructure_clusters/),
    providerClusters: pick(/agent_notes, first_detected, last_seen FROM infrastructure_clusters WHERE .* AND asns LIKE \?/),
    trendsNexus: pick(/first_detected AS created_at FROM infrastructure_clusters/),
    bannerIp: pick(/FROM infrastructure_clusters WHERE id >= 'cluster_ip_'/),
    attributorPending: pick(/SELECT id FROM infrastructure_clusters WHERE status = 'active' AND retired_reason IS NULL AND actor_id IS NULL/),
    listBody, providerBody, trendsBody, bannerBody,
  };
}

describe.skipIf(!hasSqlite())("cluster top-N list reads — plans on the migrated schema at scale", () => {
  let raw: SqliteDb;
  const modes: Record<string, Awaited<ReturnType<typeof planReads>>> = {};

  beforeAll(async () => {
    // last_updated (handleListClusters) and nexus_brief (attribution
    // backlog) come from 0136's base table, which mirrors prod's columns.
    raw = openMigratedDb();
    seed(raw);
    modes["no stats"] = await planReads(raw);
    raw.exec("ANALYZE");
    modes["ANALYZE"] = await planReads(raw);
  }, 60_000);

  it("0308 dropped the full threat_count indexes; the live partial ones remain", () => {
    const names = (raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'infrastructure_clusters'",
    ).all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).not.toContain("idx_clusters_threat_count");
    expect(names).not.toContain("idx_clusters_status_threat_count");
    expect(names).toEqual(expect.arrayContaining(["idx_clusters_live_status_threat_count", "idx_clusters_actor_live"]));
  });

  for (const mode of ["no stats", "ANALYZE"]) {
    describe(mode, () => {
      for (const which of ["list", "backlog", "backlogTotals", "intelCount"] as const) {
        it(`${which}: seeks the live statuses on the partial live-rows index, never walks a full index or scans`, () => {
          const p = modes[mode]![which];
          expect(p.sql).toContain("status IN ('active', 'dormant', 'disrupted', 'accelerating', 'pivot') AND retired_reason IS NULL");
          if (which === "list" || which === "backlog") expect(p.sql).toMatch(/ORDER BY \+threat_count DESC/);
          expect(p.plan).toMatch(/SEARCH infrastructure_clusters USING (COVERING )?INDEX idx_clusters_live_status_threat_count \(status=\?\)/);
          expect(p.plan).not.toContain("idx_clusters_threat_count");
          expect(p.plan).not.toContain("idx_clusters_status_threat_count");
          expect(p.plan).not.toMatch(/INDEX idx_clusters_status \(/);
          expect(p.plan).not.toMatch(/SCAN infrastructure_clusters/);
        });
      }

      it("providerClusters (GET /api/providers/:id/clusters): seeks the partial live-rows index, then LIKE-filters", () => {
        const p = modes[mode]!.providerClusters;
        expect(p.sql).toContain("status IN ('active', 'dormant', 'disrupted', 'accelerating', 'pivot') AND retired_reason IS NULL");
        expect(p.sql).toMatch(/ORDER BY \+threat_count DESC/);
        // Exact ASN match (asnKeySql over json_each) is a correlated
        // subquery on the already-seeked live rows — the access path is
        // unchanged (test/provider-clusters-asn-match.test.ts pins results).
        expect(p.sql).toMatch(/EXISTS \(SELECT 1 FROM json_each\(/);
        expect(p.plan).toMatch(/SEARCH infrastructure_clusters USING INDEX idx_clusters_live_status_threat_count \(status=\?\)/);
        expect(p.plan).toContain("SCAN j VIRTUAL TABLE");
        expect(p.plan).not.toContain("idx_clusters_threat_count");
        expect(p.plan).not.toMatch(/SCAN infrastructure_clusters/);
      });

      it("trendsNexus (GET /api/trends/nexus-active): seeks the partial live-rows index for status='active', in index order", () => {
        const p = modes[mode]!.trendsNexus;
        // One status equality: the (status, threat_count DESC) partial index
        // already yields threat_count order, so no `+` and no sort.
        expect(p.plan).toBe("SEARCH infrastructure_clusters USING INDEX idx_clusters_live_status_threat_count (status=?)");
        expect(p.plan).not.toContain("idx_clusters_threat_count");
        expect(p.plan).not.toMatch(/SCAN infrastructure_clusters/);
      });

      it("bannerIp (critical-banner mass-impersonation read): a bounded cluster_ip_* seek, never the threat_count walk", () => {
        const p = modes[mode]!.bannerIp;
        expect(p.sql).toMatch(/ORDER BY \+threat_count DESC/);
        expect(p.plan).toMatch(BANNER_PLAN);
        expect(p.plan).not.toContain("idx_clusters_threat_count");
        expect(p.plan).not.toMatch(/SCAN infrastructure_clusters/);
      });

      it("attributorPending (attributor pending-cluster read): seeks the partial live-rows index; sorts only live rows", () => {
        const p = modes[mode]!.attributorPending;
        // Depends on notRetiredClusterSql() emitting the bare `retired_reason IS NULL`
        // that matches the partial index predicate; otherwise it falls back to
        // idx_clusters_status and sorts ~70K retired rows.
        expect(p.sql.replace(/\s+/g, " ")).toContain("retired_reason IS NULL");
        expect(p.plan).toMatch(/SEARCH infrastructure_clusters USING INDEX idx_clusters_live_status_threat_count \(status=\?\)/);
        expect(p.plan).not.toMatch(/INDEX idx_clusters_status \(/);
        expect(p.plan).not.toContain("idx_clusters_threat_count");
        expect(p.plan).not.toMatch(/SCAN infrastructure_clusters/);
        expect(p.rows).toBeGreaterThan(0);
      });

      it("provider clusters / trends / banner return live operations only", () => {
        const { providerBody, trendsBody, bannerBody } = modes[mode]!;
        const retired = new Set((raw.prepare(
          "SELECT id FROM infrastructure_clusters WHERE retired_reason IS NOT NULL",
        ).all() as Array<{ id: string }>).map((r) => r.id));
        expect(providerBody.data.length).toBeGreaterThan(100);
        for (const r of [...providerBody.data, ...trendsBody.data]) expect(retired.has(r.id), r.id).toBe(false);
        // disrupted operations are live (lib/cluster-status.ts LIVE_CLUSTER_STATUSES)
        expect(providerBody.data.some((r) => r.status === "disrupted")).toBe(true);
        const pc = providerBody.data.map((r) => r.threat_count);
        expect(pc).toEqual([...pc].sort((a, b) => b - a));
        expect(trendsBody.data.length).toBe(5);
        const ipEvent = bannerBody.data.events.find((e) => e.kind === "mass_impersonation_ip");
        // Highest LIVE per-IP row (the retired ones carry bigger counts).
        expect(ipEvent?.link).toBe(`/operations/${encodeURIComponent(`cluster_ip_203.0.113.${IP_ROWS - 1}`)}`);
      });

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
          expect(["active", "dormant", "disrupted", "accelerating", "pivot"]).toContain(r.status);
          expect(retired.has(r.id), r.id).toBe(false);
        }
        const counts = listBody.data.map((r) => r.threat_count);
        expect(counts).toEqual([...counts].sort((a, b) => b - a));
      });
    });
  }
});
