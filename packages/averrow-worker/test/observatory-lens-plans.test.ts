// Observatory Phase B lens endpoints — query-plan pins at production shape.
//
// Why a separate file: a plan pin is only meaningful against the index set
// production actually has. The handler tests (observatory-lenses*.test.ts)
// use openDerivedDb, which materialises NO indexes; the original 0298 pin
// added only 0298's indexes on top. That hid a planner trap: with
// idx_clusters_status present (migration-era index the derived DB omitted),
// SQLite answered `WHERE status = 'active' ORDER BY threat_count DESC, id`
// with an equality seek on idx_clusters_status + a TEMP B-TREE sort of every
// active cluster (~71K rows per cache miss), so 0298's
// idx_clusters_threat_count served only status=all. Migration 0301 added
// (status, threat_count DESC, id); after retirement (0303) both were
// superseded by partial live-row indexes and the PK range, and 0308 dropped
// them.
//
// Here the DB is built by applying EVERY migration file (openMigratedDb),
// seeded at realistic production scale (77K clusters: 76K random-UUID legacy
// rows + 780 stable `cluster_*` rows, 27.6K
// agent_events, 12.8K providers, 90 days of cubes), and every lens handler
// is RUN — the plans are taken from the statements the handlers actually
// issued (SQL + binds from the harness log), not restated SQL. Each plan is
// checked twice: without sqlite_stat1 and after ANALYZE, since the planner
// can flip on stats and we don't control when production has them.

import { describe, it, expect, beforeAll } from "vitest";
import {
  handleObservatoryOperationsGeo,
  handleObservatoryMovements,
  handleObservatoryProvidersGeo,
  handleObservatoryOverindex,
  handleObservatoryCampaignsGeo,
  handleObservatoryTimeline,
  handleObservatoryActors,
  handleObservatoryTakedownsGeo,
  handleObservatoryVelocityNodes,
  STABLE_CLUSTER_ID_LO,
  STABLE_CLUSTER_ID_HI,
  OPERATIONS_GEO_SCAN_CAP,
} from "../src/handlers/observatoryLenses";
import { hasSqlite, openMigratedDb, d1FromSqlite, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const SCALE = {
  // Prod shape 2026-10-14: ~70K ACTIVE random-UUID legacy rows (pre-2026-09-11
  // ASN-lane bug) + ~780 stable `cluster_*` rows, ~370 of them active.
  legacyClusters: 76_220,
  stableClusters: 780,
  actors: 300,
  agentEvents: 27_600,
  providers: 12_800,
  actorInfra: 5_000,
  attributions: 30_000,
  cubeHours: 90 * 24,
} as const;

function makeEnv(raw: SqliteDb) {
  const log: StatementLogEntry[] = [];
  const db = d1FromSqlite(raw, { log });
  const withSession = () => ({ prepare: db.prepare.bind(db), getBookmark: () => null });
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  };
  const env = { DB: { ...db, prepare: db.prepare, batch: db.batch, withSession }, CACHE: kv } as unknown as Env;
  return { env, log };
}

const req = (path: string) => new Request(`https://averrow.com${path}`);

function hourBucket(hoursAgo: number): string {
  const d = new Date(Date.now() - hoursAgo * 3_600_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** Deterministic PRNG so the seeded distribution (and the plans) are stable. */
function prng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function seedAtScale(db: SqliteDb): void {
  const rnd = prng(42);
  const sev = ["critical", "high", "medium", "low"];
  db.exec("BEGIN");
  let s = db.prepare("INSERT INTO threat_actors (id, name, country_code, status) VALUES (?, ?, 'RU', 'active')");
  for (let i = 0; i < SCALE.actors; i++) s.run(`ta_${i}`, `Actor ${i}`);

  // Legacy: ~92% active, frozen HIGH threat_count (they dominate any
  // threat_count order), ~5% attributed, retired by migration 0303
  // (retired_reason='superseded' — status keeps its prod value, the CHECK
  // allows nothing else). Stable: ~47% active, smaller counts, ~30% in a
  // component, every NEXUS id prefix represented, ~1/13 retired by NEXUS.
  s = db.prepare(`INSERT INTO infrastructure_clusters
    (id, cluster_name, threat_count, status, retired_reason, first_detected, last_seen, countries, asns, attack_types, brand_ids, agent_notes, actor_id, component_id)
    VALUES (?, ?, ?, ?, ?, '2026-01-01', '2026-10-01', '["US"]', ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < SCALE.legacyClusters; i++) {
    const hex = (i * 2654435761 >>> 0).toString(16).padStart(8, "0");
    s.run(`${hex}-${String(i).padStart(4, "0").slice(-4)}-4a1c-9b2d-${String(i).padStart(12, "0")}`, `op ${i}`,
      5000 + Math.floor(rnd() * 20_000), i % 12 === 0 ? "dormant" : "active", "superseded",
      '["AS13335"]', '["malware_distribution"]', '["b1","b2"]', null,
      rnd() < 0.05 ? `ta_${Math.floor(rnd() ** 3 * SCALE.actors)}` : null, null);
  }
  const prefixes = ["cluster_asn_", "cluster_subnet_", "cluster_cert_", "cluster_registrar_", "cluster_ip_", "cluster_dev_"];
  for (let i = 0; i < SCALE.stableClusters; i++) {
    const prefix = prefixes[i % prefixes.length]!;
    s.run(`${prefix}${i}`, `stable ${i}`, Math.floor(rnd() ** 4 * 3000), rnd() < 0.47 ? "active" : "dormant",
      i % 13 === 0 ? "shared_infra" : null,
      i % 3 === 0 ? '["AS13335"]' : `["AS${2000 + i}"]`, i % 7 === 0 ? '["scanning"]' : '["phishing"]',
      JSON.stringify(Array.from({ length: i % 11 === 0 ? 200 : 3 }, (_, k) => `b${k}`)),
      prefix === "cluster_cert_" ? JSON.stringify({ cluster_type: i % 2 ? "ssl_san_hash" : "ssl_cert_serial" }) : null,
      rnd() < 0.05 ? `ta_${Math.floor(rnd() ** 3 * SCALE.actors)}` : null,
      rnd() < 0.3 ? `component_cluster_cert_${(i % 40) * 6 + 2}` : null);
  }

  // ~1% pivot_detected over 120 days; pivots carry v2 ASN lists + a cluster id
  // without a name, so the movements handler issues its follow-up lookups.
  s = db.prepare(`INSERT INTO agent_events (id, event_type, source_agent, payload_json, created_at, status)
    VALUES (?, ?, 'nexus', ?, ?, 'done')`);
  const other = ["feed_pulled", "threats_enriched", "nexus_complete", "briefing_generated", "pages_captured"];
  for (let i = 0; i < SCALE.agentEvents; i++) {
    const pivot = rnd() < 0.01;
    const at = new Date(Date.now() - rnd() * 120 * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
    s.run(`ev_${i}`, pivot ? "pivot_detected" : other[i % other.length]!,
      pivot ? JSON.stringify({ kind: "infra_movement", payload_v: 2, cluster_id: `cluster_asn_${i}`,
        prev_asn_list: ["AS1001"], new_asn_list: ["AS1002"], new_asns: 1 }) : "{}", at);
  }

  s = db.prepare(`INSERT INTO hosting_providers (id, name, asn, country, active_threat_count, total_threat_count, is_bulletproof)
    VALUES (?, ?, ?, 'US', ?, 100, ?)`);
  for (let i = 0; i < SCALE.providers; i++) {
    s.run(`hp_${i}`, `Provider ${i}`, `AS${1000 + i}`, Math.floor(rnd() ** 5 * 3000), rnd() < 0.01 ? 1 : 0);
  }

  s = db.prepare(`INSERT INTO threat_actor_infrastructure (id, threat_actor_id, asn, country_code, confidence, last_observed)
    VALUES (?, ?, 'AS1001', 'RU', 'medium', ?)`);
  for (let i = 0; i < SCALE.actorInfra; i++) s.run(`tai_${i}`, `ta_${Math.floor(rnd() ** 3 * SCALE.actors)}`, hourBucket(i % 2000));
  s = db.prepare(`INSERT INTO threat_attributions (id, threat_id, actor_id, confidence, source, observed_at)
    VALUES (?, ?, ?, 'medium', 'otx', ?)`);
  for (let i = 0; i < SCALE.attributions; i++) s.run(`attr_${i}`, `t_${i}`, `ta_${Math.floor(rnd() ** 3 * SCALE.actors)}`, hourBucket(i % 2000));

  s = db.prepare("INSERT INTO takedown_outcome_daily (day, dim, key, submitted, taken_down) VALUES (?, ?, ?, 2, 1)");
  for (let d = 0; d < 90; d++) {
    for (let k = 0; k < 20; k++) {
      s.run(hourBucket(d * 24).slice(0, 10), "country", `C${String.fromCharCode(65 + k)}`);
      s.run(hourBucket(d * 24).slice(0, 10), "provider", `hp_${k}`);
    }
  }

  const geo = db.prepare(`INSERT OR IGNORE INTO threat_cube_geo
    (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed, threat_count)
    VALUES (?, ?, 1, ?, 'phishing', ?, ?, 2)`);
  const status = db.prepare(`INSERT OR IGNORE INTO threat_cube_status
    (hour_bucket, threat_type, severity, source_feed, status, threat_count) VALUES (?, ?, ?, ?, ?, 2)`);
  const vel = db.prepare(`INSERT OR IGNORE INTO threat_cube_velocity (hour_bucket, country_code, flag, threat_count)
    VALUES (?, ?, ?, 3)`);
  for (let h = 0; h < SCALE.cubeHours; h++) {
    const hb = hourBucket(h);
    for (let k = 0; k < 30; k++) {
      geo.run(hb, k % 7, ["US", "RU", "CN", "DE", "NL", "BR", "IN", "FR"][k % 8]!, sev[k % 4]!, `feed_${k % 5}`);
    }
    for (let k = 0; k < 12; k++) status.run(hb, `type_${k % 3}`, sev[k % 4]!, `feed_${k % 5}`, ["active", "down", "remediated"][k % 3]!);
    for (const cc of ["US", "RU", "CN", "DE"]) for (const f of ["very_fast", "fast"]) vel.run(hb, cc, f);
  }

  s = db.prepare(`INSERT INTO radar_country_snapshots (snapshot_date, metric, country_code, value_pct) VALUES (?, ?, ?, 5)`);
  for (let d = 0; d < 60; d++) {
    for (const m of ["attack_origin", "attack_target", "bot_density"]) for (const cc of ["US", "RU", "CN", "DE"]) s.run(hourBucket(d * 24).slice(0, 10), m, cc);
  }
  db.exec("COMMIT");
}

interface Planned { sql: string; plan: string }

/** Run every lens handler (cold KV) and EXPLAIN each read it issued. */
async function planAllLensReads(db: SqliteDb): Promise<Planned[]> {
  const { env, log } = makeEnv(db);
  const calls: Array<() => Promise<Response>> = [
    () => handleObservatoryOperationsGeo(req("/api/observatory/operations-geo"), env),
    () => handleObservatoryOperationsGeo(req("/api/observatory/operations-geo?status=all&limit=50"), env),
    () => handleObservatoryMovements(req("/api/observatory/movements?period=90d&limit=100"), env),
    () => handleObservatoryProvidersGeo(req("/api/observatory/providers-geo"), env, { role: "analyst" }),
    () => handleObservatoryProvidersGeo(req("/api/observatory/providers-geo?bulletproof=1"), env, { role: "analyst" }),
    () => handleObservatoryOverindex(req("/api/observatory/overindex?period=30d"), env),
    () => handleObservatoryCampaignsGeo(req("/api/observatory/campaigns-geo"), env),
    () => handleObservatoryTimeline(req("/api/observatory/timeline?period=30d"), env),
    () => handleObservatoryTimeline(req("/api/observatory/timeline?period=7d&country=US"), env),
    () => handleObservatoryTimeline(req("/api/observatory/timeline?period=7d&country=US&velocity=fast"), env),
    () => handleObservatoryActors(req("/api/observatory/actors"), env),
    () => handleObservatoryActors(req("/api/observatory/actors?actor_id=ta_0"), env),
    () => handleObservatoryTakedownsGeo(req("/api/observatory/takedowns-geo?period=90d&by=provider"), env),
    () => handleObservatoryVelocityNodes(req("/api/observatory/velocity-nodes?period=90d"), env),
    () => handleObservatoryVelocityNodes(req("/api/observatory/velocity-nodes?period=7d&flag=fast"), env),
  ];
  for (const call of calls) expect((await call()).status).toBe(200);
  return log
    .filter((e) => e.error === undefined && /^\s*SELECT/i.test(e.sql))
    .map((e) => ({
      sql: e.sql,
      plan: (db.prepare(`EXPLAIN QUERY PLAN ${e.sql}`).all(...(e.binds ?? [])) as Array<{ detail: string }>)
        .map((r) => r.detail).join(" | "),
    }));
}

const find = (planned: Planned[], marker: RegExp): Planned[] => {
  const hits = planned.filter((p) => marker.test(p.sql.replace(/\s+/g, " ")));
  expect(hits.length, `no statement matched ${marker}`).toBeGreaterThan(0);
  return hits;
};

describe.skipIf(!hasSqlite())("observatory lens reads — plans on the fully migrated schema at scale", () => {
  let db: SqliteDb;
  const modes: Record<string, Planned[]> = {};

  beforeAll(async () => {
    db = openMigratedDb();
    seedAtScale(db);
    modes["no stats"] = await planAllLensReads(db);
    db.exec("ANALYZE");
    modes["ANALYZE"] = await planAllLensReads(db);
  }, 60_000);

  for (const mode of ["no stats", "ANALYZE"]) {
    describe(mode, () => {
      it("the migrated schema carries the competing index (the trap's precondition)", () => {
        const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'infrastructure_clusters'`)
          .all() as Array<{ name: string }>).map((r) => r.name);
        expect(names).toEqual(expect.arrayContaining([
          "idx_clusters_status", "idx_clusters_live_status_threat_count",
        ]));
        // 0298's / 0301's full threat_count indexes are dropped by 0308.
        expect(names).not.toContain("idx_clusters_threat_count");
        expect(names).not.toContain("idx_clusters_status_threat_count");
      });

      it("operations-geo: both statuses read the stable-id PRIMARY KEY range, never a status / threat_count index; no sort", () => {
        const ops = find(modes[mode]!, /FROM infrastructure_clusters c LEFT JOIN threat_actors a/);
        expect(ops).toHaveLength(2);
        const [active, all] = ops[0]!.sql.includes("+c.status = 'active'") ? [ops[0]!, ops[1]!] : [ops[1]!, ops[0]!];
        expect(active.sql).toContain("+c.status = 'active'");
        expect(all.sql).not.toContain("c.status = 'active'");
        // Both statuses drop retired rows (retirement leaves status alone)
        // with the same unary-`+` guard, so the predicate can't pull the
        // planner off the PK range onto the partial live-rows index either.
        for (const p of ops) expect(p.sql).toContain("+c.retired_reason IS NULL");
        for (const p of ops) {
          expect(p.plan).toContain("SEARCH c USING INDEX sqlite_autoindex_infrastructure_clusters_1 (id>? AND id<?)");
          expect(p.plan).not.toMatch(/idx_clusters_status|idx_clusters_threat_count|idx_clusters_live_status_threat_count/);
          expect(p.plan).not.toContain("SCAN c");
          expect(p.plan).not.toContain("TEMP B-TREE");
        }
      });

      it("operations-geo: the range it reads is the stable population only (rows read bounded, legacy never touched)", () => {
        const [p] = find(modes[mode]!, /FROM infrastructure_clusters c LEFT JOIN threat_actors a/);
        const [lo, hi] = [STABLE_CLUSTER_ID_LO, STABLE_CLUSTER_ID_HI];
        const inRange = (db.prepare("SELECT COUNT(*) AS n FROM infrastructure_clusters WHERE id >= ? AND id < ?").all(lo, hi) as Array<{ n: number }>)[0]!.n;
        const total = (db.prepare("SELECT COUNT(*) AS n FROM infrastructure_clusters").all() as Array<{ n: number }>)[0]!.n;
        expect(inRange).toBe(SCALE.stableClusters);
        expect(total).toBe(SCALE.legacyClusters + SCALE.stableClusters);
        // The bounds the handler bound are exactly the stable range.
        const entry = p!;
        expect(entry.sql).toMatch(/WHERE c\.id >= \? AND c\.id < \?/);
        expect(inRange).toBeLessThan(OPERATIONS_GEO_SCAN_CAP);
      });

      it("movements: (event_type, created_at) range in order; follow-up lookups by key", () => {
        const [mv] = find(modes[mode]!, /FROM agent_events WHERE event_type = 'pivot_detected'/);
        expect(mv!.plan).toContain("idx_agent_events_type_created (event_type=? AND created_at>?)");
        expect(mv!.plan).not.toContain("TEMP B-TREE");
        const [names] = find(modes[mode]!, /SELECT id, cluster_name FROM infrastructure_clusters WHERE id IN/);
        expect(names!.plan).toMatch(/SEARCH infrastructure_clusters USING (COVERING )?INDEX sqlite_autoindex_infrastructure_clusters_1 \(id=\?\)/);
        for (const asn of find(modes[mode]!, /FROM hosting_providers WHERE asn IN/)) {
          expect(asn.plan).toMatch(/SEARCH hosting_providers USING INDEX \w+ \(asn=\?\)/);
        }
      });

      it("providers-geo: walks idx_providers_active_threats (both bulletproof modes); takedown rollup is a (dim, day) range", () => {
        for (const p of find(modes[mode]!, /FROM hosting_providers .*ORDER BY active_threat_count DESC/)) {
          expect(p.plan).toContain("SCAN hosting_providers USING INDEX idx_providers_active_threats");
          expect(p.plan).not.toContain("TEMP B-TREE");
        }
        for (const p of find(modes[mode]!, /FROM takedown_outcome_daily WHERE dim = \?/)) {
          expect(p.plan).toContain("idx_takedown_outcome_dim_day (dim=? AND day>?)");
        }
        const [pk] = find(modes[mode]!, /SELECT id, name, country FROM hosting_providers WHERE id IN/);
        expect(pk!.plan).toMatch(/SEARCH hosting_providers USING INDEX sqlite_autoindex_hosting_providers_1 \(id=\?\)/);
      });

      it("overindex: the geo cube read is the window's hour range, never a whole-cube index scan", () => {
        const [geo] = find(modes[mode]!, /FROM threat_cube_geo WHERE hour_bucket >= \? AND country_code != 'XX'/);
        expect(geo!.plan).toContain("SEARCH threat_cube_geo USING INDEX idx_cube_geo_hour (hour_bucket>?)");
        expect(geo!.plan).not.toContain("SCAN threat_cube_geo");
        const [radar] = find(modes[mode]!, /FROM radar_country_snapshots WHERE metric = 'attack_origin'/);
        expect(radar!.plan).toContain("idx_radar_country_snapshots_metric_date (metric=? AND snapshot_date=?)");
      });

      it("timeline: every cube read is an index range on the window", () => {
        const [st] = find(modes[mode]!, /FROM threat_cube_status WHERE hour_bucket >= \? AND status = 'active'/);
        expect(st!.plan).toContain("idx_cube_status_status_hour (status=? AND hour_bucket>?)");
        const [cc] = find(modes[mode]!, /FROM threat_cube_geo WHERE hour_bucket >= \? AND country_code = \?/);
        expect(cc!.plan).toContain("idx_cube_geo_country_hour (country_code=? AND hour_bucket>?)");
        const [v] = find(modes[mode]!, /FROM threat_cube_velocity WHERE hour_bucket >= \? AND country_code = \?/);
        expect(v!.plan).toContain("sqlite_autoindex_threat_cube_velocity_1 (hour_bucket>?)");
      });

      it("actors: list counts come from covering per-actor indexes; detail reads are actor-keyed", () => {
        const [list] = find(modes[mode]!, /SELECT a\.id, a\.name, \(SELECT COUNT\(\*\)/);
        // Retired clusters are excluded (retired_reason IS NULL,
        // lib/cluster-status.ts); migration 0304's partial live-rows
        // (actor_id) index keeps the per-actor count covering.
        expect(list!.plan).toContain("SEARCH c USING COVERING INDEX idx_clusters_actor_live (actor_id=? AND retired_reason=?)");
        expect(list!.plan).toContain("SEARCH i USING COVERING INDEX idx_tai_actor (threat_actor_id=?)");
        const [infra] = find(modes[mode]!, /FROM threat_actor_infrastructure WHERE threat_actor_id = \?/);
        expect(infra!.plan).toContain("idx_tai_actor (threat_actor_id=?)");
        const [clusters] = find(modes[mode]!, /FROM infrastructure_clusters WHERE actor_id = \?/);
        expect(clusters!.plan).toMatch(/idx_clusters_actor(_live)? \(actor_id=\?( AND retired_reason=\?)?\)/);
        const [attr] = find(modes[mode]!, /FROM threat_attributions WHERE actor_id = \?/);
        expect(attr!.plan).toContain("idx_attribution_actor (actor_id=?)");
      });

      it("velocity-nodes: the cube PK range on hour_bucket (both flag modes)", () => {
        for (const p of find(modes[mode]!, /FROM threat_cube_velocity WHERE hour_bucket >= \?( AND flag = \?)? GROUP BY country_code/)) {
          expect(p.plan).toContain("SEARCH threat_cube_velocity USING INDEX sqlite_autoindex_threat_cube_velocity_1 (hour_bucket>?)");
        }
      });

      it("no lens read full-scans a large table", () => {
        // Only tiny reference tables may be scanned: threat_actors (a few
        // hundred rows; the list sorts on computed counts) and the curated
        // geopolitical_campaigns. The idx_providers_active_threats SCAN is an
        // ordered walk that stops at LIMIT (pinned above).
        const allowed = /^SCAN (a|threat_actors|geopolitical_campaigns)\b|^SCAN hosting_providers USING INDEX idx_providers_active_threats$/;
        for (const p of modes[mode]!) {
          for (const step of p.plan.split(" | ")) {
            if (step.startsWith("SCAN ")) expect(step, p.sql).toMatch(allowed);
          }
        }
      });
    });
  }
});
