/**
 * Migration 0323 — covering partial indexes for the NEXUS ASN and /24 lanes.
 *
 * Live diagnostics 2026-11-08 (D1 "overloaded"): the ASN lane read ~2.28M
 * rows per call (idx_threats_status_created + a table lookup per active
 * row to evaluate asnKeySql), the /24 lane ~1.34M (idx_threats_subnet24 over
 * every IPv4 row of any status + a lookup per entry). 0323 adds one covering
 * partial index per lane, keyed on the lane's own GROUP BY expression.
 *
 * Pinned here:
 *   1. The index key expressions are byte-identical to what the lane SQL
 *      groups by (asnKeySql("asn"), ip_subnet24's value expression), and the
 *      ASN index's IP-reputation list is IP_REPUTATION_THREAT_TYPES — the
 *      planner matches them textually, so drift would orphan the index.
 *   2. Plans (fully migrated schema, with and without ANALYZE stats): each
 *      lane does a COVERING walk of its index with no GROUP BY temp b-tree;
 *      the baseline (0323 excluded) is the pre-fix plan; and no other NEXUS
 *      statement moves onto the new indexes (the per-IP SELECT may take the
 *      /24 index, covering only, with identical results).
 *   3. Results: on a fixture covering every filter edge, the pre-0323 lane
 *      SQL on the pre-0323 schema and the new SQL on the new schema return
 *      identical groups, and the full lanes leave identical clusters and
 *      stamps — including when the INDEXED BY hint has to fall back.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import { insertThreats, many, seedScenario } from "./nexus-fixtures";
import {
  ASN_LANE_SQL,
  SUBNET_LANE_SQL,
  SUBNET_STAMP_SQL,
  SUBNET24_IPV4_SQL,
  SUBNET24_KEY_SQL,
  PER_IP_LANE_SQL,
  PER_IP_STAMP_SQL,
  CERT_SERIAL_LANE_SQL,
  CERT_SAN_LANE_SQL,
  REGISTRAR_LANE_SQL,
  IP_REPUTATION_THREAT_TYPES,
  ASN_MAX_BRAND_FANOUT,
  runAsnLane,
  runSubnetLane,
} from "../src/lib/nexus-threat-lanes";
import { asnKey, asnKeySql } from "../src/lib/shared-infra-asns";
import { stripIndexedBy } from "../src/lib/indexed-by-fallback";
import { DEFAULT_HUB_FANOUT_THRESHOLD } from "../src/lib/cluster-components";

const ROOT = resolve(__dirname, "..");
const MIGRATIONS = ["0323_nexus_lane_covering_indexes.sql", "0324_nexus_subnet_lane_covering_index.sql"];
const migrationSql = MIGRATIONS.map((m) => readFileSync(resolve(ROOT, "migrations", m), "utf8")).join("\n");
const ws = (s: string): string => s.replace(/\s+/g, " ").trim();

function plan(db: SqliteDb, sql: string): string[] {
  const n = (sql.match(/\?/g) ?? []).length;
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill(DEFAULT_HUB_FANOUT_THRESHOLD)) as Array<{ detail: string }>)
    .map((r) => r.detail);
}

/** The ONE `CREATE INDEX` statement for `name` in 0323/0324. */
function indexDdl(name: string): string {
  const m = migrationSql.match(new RegExp(`CREATE INDEX IF NOT EXISTS ${name}\\b[\\s\\S]*?;`));
  expect(m, name).not.toBeNull();
  return ws(m![0]);
}

// ─── Pre-0323 lane SQL, reconstructed from the current text ───────────
//
// The ASN lane SQL is unchanged apart from the hint. The /24 lane grouped
// by the ip_subnet24 column under `ip_subnet24 IS NOT NULL`; each swap is
// asserted so a rewrite of the new SQL can't silently skip one.
function swapOnce(s: string, from: string, to: string): string {
  expect(s.split(from).length - 1, `exactly one "${from.slice(0, 40)}"`).toBe(1);
  return s.replace(from, to);
}
const LEGACY_ASN_LANE_SQL = stripIndexedBy(ASN_LANE_SQL);
const LEGACY_SUBNET_LANE_SQL = (() => {
  let s = stripIndexedBy(SUBNET_LANE_SQL);
  s = swapOnce(s, `SELECT ${SUBNET24_KEY_SQL}`, "SELECT ip_subnet24");
  s = swapOnce(s, SUBNET24_IPV4_SQL, "ip_subnet24 IS NOT NULL");
  s = swapOnce(s, `GROUP BY ${SUBNET24_KEY_SQL}`, "GROUP BY ip_subnet24");
  return s;
})();

// ─── Fixtures ─────────────────────────────────────────────────────────

/** Every edge the two lanes' filters distinguish, on top of the scenario. */
function seedEdges(db: SqliteDb): void {
  seedScenario(db);
  insertThreats(db, [
    // ASN lane: one operator under five raw spellings of one ASN; numeric,
    // lower-case, org-suffixed, padded and comma forms must all group.
    ...many(4, (i) => ({ id: `v1_${i}`, threat_type: "phishing", asn: "AS64500", brand: `v${i % 2}`, cc: "BR" })),
    ...many(3, (i) => ({ id: `v2_${i}`, threat_type: "phishing", asn: "64500", brand: "v0", cc: "BR" })),
    ...many(2, (i) => ({ id: `v3_${i}`, threat_type: "phishing", asn: "as64500", brand: "v1", cc: "AR" })),
    ...many(2, (i) => ({ id: `v4_${i}`, threat_type: "phishing", asn: "AS64500 Example Net, Inc.", brand: "v2", cc: "BR" })),
    ...many(2, (i) => ({ id: `v5_${i}`, threat_type: "phishing", asn: "  AS64500,Example", brand: "v2", cc: null })),
    // Unparseable ASNs never group. (A '' / NULL threat_type can't be
    // seeded: the threats CHECK constraint rejects it.)
    ...many(12, (i) => ({ id: `bad_${i}`, threat_type: "phishing", asn: i % 2 ? "AS 64501" : "Example", brand: "w0" })),
    // IP-reputation type on a qualifying ASN — skipped by the lane AND
    // absent from the partial index.
    ...many(12, (i) => ({ id: `mip_${i}`, threat_type: "malicious_ip", asn: "AS64503", brand: `w${i % 3}` })),
    // Exactly at the HAVING floor (10) and one below it.
    ...many(10, (i) => ({ id: `ten_${i}`, threat_type: "malware_distribution", asn: "AS64504", brand: `t${i % 4}` })),
    ...many(9, (i) => ({ id: `nine_${i}`, threat_type: "malware_distribution", asn: "AS64505", brand: `t${i % 4}` })),
    // Inactive rows on a qualifying ASN must not count.
    ...many(5, (i) => ({ id: `ina_${i}`, threat_type: "malware_distribution", asn: "AS64504", brand: "t9", status: "remediated" })),
    // Brand fan-out over the hub threshold on one ASN — not emitted.
    ...many(DEFAULT_HUB_FANOUT_THRESHOLD + 2, (i) => ({ id: `fan_${i}`, threat_type: "phishing", asn: "AS64506", brand: `f${i}` })),

    // /24 lane: a qualifying /24 (3 IPs, 3 brands, 9 threats) plus rows
    // that must be excluded from it — inactive, unattributed, bogon /24s,
    // IPv6, '' and '0.0.0.0', and a member on a shared ASN.
    ...many(9, (i) => ({ id: `s1_${i}`, ip: `198.18.7.${(i % 3) + 1}`, asn: "AS64510", brand: `q${i % 3}`, cc: "SE" })),
    ...many(3, (i) => ({ id: `s1in_${i}`, ip: "198.18.7.9", asn: "AS64510", brand: `q${i}`, status: "remediated" })),
    ...many(3, (i) => ({ id: `s1nb_${i}`, ip: "198.18.7.9", asn: "AS64510", brand: null })),
    ...many(2, (i) => ({ id: `s1sh_${i}`, ip: "198.18.7.8", asn: "AS16276", brand: "q0" })),
    // Same subnet text prefix but a different /24 ("198.18.70.") — must
    // not merge into 198.18.7.
    ...many(9, (i) => ({ id: `s7_${i}`, ip: `198.18.70.${(i % 3) + 1}`, asn: "AS64511 Example", brand: `r${i % 3}`, cc: "NO" })),
    ...many(9, (i) => ({ id: `bog_${i}`, ip: `10.9.9.${(i % 3) + 1}`, asn: "AS64512", brand: `z${i % 3}` })),
    ...many(9, (i) => ({ id: `cg_${i}`, ip: `100.64.1.${(i % 3) + 1}`, asn: "AS64512", brand: `z${i % 3}` })),
    ...many(9, (i) => ({ id: `v6_${i}`, ip: `2001:db8::${(i % 3) + 1}`, asn: "AS64513", brand: `y${i % 3}` })),
    ...many(4, (i) => ({ id: `emp_${i}`, ip: i % 2 ? "" : "0.0.0.0", asn: "AS64513", brand: `y${i % 3}` })),
  ]);
}

/**
 * ~5K-row bulk so ANALYZE has real distributions. Every bulk subnet holds
 * one threat and every bulk ASN ~5, so none of it qualifies for a lane and
 * the fixture's groups stay inside the lanes' LIMITs.
 */
function seedBulk(db: SqliteDb): void {
  db.exec("BEGIN");
  insertThreats(db, many(5_000, (i) => ({
    id: `bulk_${i}`,
    threat_type: ["phishing", "scanning", "malware_distribution", "malicious_ip"][i % 4]!,
    ip: i % 3 ? `45.${i % 250}.${Math.floor(i / 250)}.${(i % 7) + 1}` : null,
    asn: i % 5 ? `AS${70000 + (i % 1000)}` : null,
    brand: i % 4 ? `bb${i % 500}` : null,
    status: i % 3 ? "active" : "remediated",
    daysAgo: i % 60,
  })));
  db.exec("COMMIT");
}

const VARIANTS: Array<[string, (db: SqliteDb) => void]> = [
  ["without table stats", () => {}],
  ["with ANALYZE stats", (db) => { seedBulk(db); db.exec("ANALYZE"); }],
];

// ─── 1. Index definitions match the lane SQL ──────────────────────────

describe("migration 0323 index definitions match the lane SQL", () => {
  it("idx_threats_asn_lane is keyed on asnKeySql(asn) and partial on the lane's own terms", () => {
    const ddl = indexDdl("idx_threats_asn_lane");
    expect(ddl).toContain(`ON threats( ${ws(asnKeySql("asn"))}, threat_type,`);
    // The ASN lane groups by exactly that expression.
    expect(ws(ASN_LANE_SQL)).toContain(`SELECT ${ws(asnKeySql("asn"))} AS asn_norm`);
    const ipRep = IP_REPUTATION_THREAT_TYPES.map((t) => `'${t}'`).join(", ");
    expect(ddl).toMatch(new RegExp(
      `WHERE status = 'active' AND asn IS NOT NULL AND threat_type NOT IN \\(${ipRep}\\);$`,
    ));
    expect(ws(ASN_LANE_SQL)).toContain(`threat_type NOT IN (${ipRep})`);
    expect(ws(ASN_LANE_SQL)).toContain("FROM threats INDEXED BY idx_threats_asn_lane WHERE status = 'active' AND asn IS NOT NULL");
  });

  it("idx_threats_subnet_lane is keyed on ip_subnet24's value expression", () => {
    const ddl = indexDdl("idx_threats_subnet_lane");
    expect(ddl).toContain(`ON threats( ${SUBNET24_KEY_SQL}, ip_address,`);
    expect(ddl).toMatch(/WHERE status = 'active' AND ip_address IS NOT NULL AND target_brand_id IS NOT NULL;$/);
    // 0235's generated column: same value expression, same non-NULL terms.
    const m0235 = ws(readFileSync(resolve(ROOT, "migrations/0235_threats_ip_subnet24_generated.sql"), "utf8"));
    expect(m0235).toContain(`WHEN ${ws(SUBNET24_IPV4_SQL)} THEN ${SUBNET24_KEY_SQL} END`);
    expect(ws(SUBNET_LANE_SQL)).toContain(`GROUP BY ${SUBNET24_KEY_SQL}`);
    expect(ws(SUBNET_LANE_SQL)).toContain("FROM threats INDEXED BY idx_threats_subnet_lane");
  });

  it("both indexes are covering: every column the lane reads is a key column, cluster_id is not", () => {
    const asnCols = ["threat_type", "target_brand_id", "campaign_id", "hosting_provider_id", "country_code", "first_seen", "asn", "status"];
    const subnetCols = ["ip_address", "target_brand_id", "asn", "threat_type", "country_code", "first_seen", "status"];
    for (const [name, cols] of [["idx_threats_asn_lane", asnCols], ["idx_threats_subnet_lane", subnetCols]] as const) {
      const keyList = indexDdl(name).replace(/^.*?ON threats\(/, "").replace(/\s*\) WHERE .*$/, "");
      const keys = keyList.split(",").map((k) => k.trim());
      for (const c of cols) expect(keys, `${name} ${c}`).toContain(c);
      expect(keyList, name).not.toContain("cluster_id");
    }
  });

  it("is additive only", () => {
    const body = migrationSql.replace(/--.*$/gm, "");
    expect(body).not.toMatch(/\b(DROP|ALTER|UPDATE|DELETE|INSERT)\b/i);
    expect((body.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length).toBe(2);
  });
});

// ─── 2. Query plans ───────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("0323 query plans", () => {
  it("baseline (pre-0323 schema + SQL): the pre-fix plans", () => {
    const db = openMigratedDb({ exclude: MIGRATIONS });
    const asn = plan(db, LEGACY_ASN_LANE_SQL);
    expect(asn[0]).toBe("SEARCH threats USING INDEX idx_threats_status_created (status=?)");
    expect(asn).toContain("USE TEMP B-TREE FOR GROUP BY");
    seedBulk(db);
    db.exec("ANALYZE");
    // With stats the pre-fix /24 lane walks idx_threats_subnet24 (every
    // IPv4 row, any status) with a table lookup per entry — prod's plan.
    expect(plan(db, LEGACY_SUBNET_LANE_SQL)[0]).toBe("SEARCH threats USING INDEX idx_threats_subnet24 (ip_subnet24>?)");
  });

  for (const [label, prep] of VARIANTS) {
    describe(label, () => {
      const db = openMigratedDb();
      prep(db);

      it("ASN lane: covering walk of idx_threats_asn_lane in GROUP BY order", () => {
        const p = plan(db, ASN_LANE_SQL);
        expect(p[0]).toBe("SCAN threats USING COVERING INDEX idx_threats_asn_lane");
        expect(p).not.toContain("USE TEMP B-TREE FOR GROUP BY");
      });

      it("/24 lane: covering walk of idx_threats_subnet_lane in GROUP BY order", () => {
        const p = plan(db, SUBNET_LANE_SQL);
        expect(p[0]).toBe("SCAN threats USING COVERING INDEX idx_threats_subnet_lane");
        expect(p).not.toContain("USE TEMP B-TREE FOR GROUP BY");
      });

      it("the stamps keep their equality seeks", () => {
        expect(plan(db, SUBNET_STAMP_SQL)).toEqual(["SEARCH threats USING INDEX idx_threats_subnet24 (ip_subnet24=?)"]);
        expect(plan(db, PER_IP_STAMP_SQL)).toEqual(["SEARCH threats USING INDEX idx_threats_ip_source_feed (ip_address=?)"]);
      });

      it("no other NEXUS statement moves onto the new indexes", () => {
        for (const sql of [PER_IP_STAMP_SQL, SUBNET_STAMP_SQL, CERT_SERIAL_LANE_SQL, CERT_SAN_LANE_SQL, REGISTRAR_LANE_SQL]) {
          const p = plan(db, sql).join(" | ");
          expect(p, sql.slice(0, 80)).not.toMatch(/idx_threats_(asn|subnet)_lane/);
        }
      });

      it("the per-IP SELECT may only take idx_threats_subnet_lane as a COVERING scan", () => {
        // Its WHERE (active, ip_address not NULL, brand not NULL) implies the
        // index's partial predicate and it reads only covered columns, so
        // with stats the planner may prefer a covering scan of the active,
        // IP-bearing, attributed rows over its old non-covering
        // ip_address range on idx_threats_ip_source_feed — fewer rows read,
        // never a table lookup. Results are pinned identical below.
        const p = plan(db, PER_IP_LANE_SQL);
        expect(p.join(" | ")).not.toMatch(/idx_threats_asn_lane/);
        if (p[0]!.includes("idx_threats_subnet_lane")) expect(p[0]).toBe("SCAN threats USING COVERING INDEX idx_threats_subnet_lane");
      });
    });
  }

  it("a hint the planner can't honour falls back unhinted (no such index / no query solution)", async () => {
    // Pre-0323 schema: the hinted SQL fails with "no such index" and
    // withIndexHintFallback re-runs it unhinted.
    const raw = openMigratedDb({ exclude: MIGRATIONS });
    seedEdges(raw);
    const r = await runAsnLane(d1FromSqlite(raw));
    expect(r.analyzed).toBeGreaterThan(0);
    const s = await runSubnetLane(d1FromSqlite(raw));
    expect(s.analyzed).toBeGreaterThan(0);
  });
});

// ─── 3. Results are identical ─────────────────────────────────────────

type Row = Record<string, unknown>;

/** GROUP_CONCAT(DISTINCT …) order follows the scan order; compare as sets. */
function canonicalGroups(rows: Row[]): Row[] {
  const sortList = (v: unknown): unknown =>
    typeof v === "string" && !v.startsWith("[") ? v.split(",").sort().join(",") : v;
  const sortJson = (v: unknown): unknown =>
    typeof v === "string" && v.startsWith("[") ? JSON.stringify((JSON.parse(v) as unknown[]).map(String).sort()) : v;
  return rows.map((r) => {
    const o: Row = {};
    for (const [k, v] of Object.entries(r)) o[k] = k === "raw_asns" ? sortJson(v) : sortList(v);
    return o;
  });
}

function canonicalClusters(raw: SqliteDb): Row[] {
  const rows = raw.prepare(
    `SELECT id, cluster_name, asns, countries, country_counts, attack_types, brand_ids,
            hosting_provider_ids, threat_count, confidence_score, status, agent_notes, retired_reason
       FROM infrastructure_clusters ORDER BY id`,
  ).all() as Row[];
  const sorted = (v: unknown): unknown => (typeof v === "string" ? JSON.stringify((JSON.parse(v) as string[]).sort()) : v);
  return rows.map((r) => ({ ...r, asns: sorted(r.asns), attack_types: sorted(r.attack_types), brand_ids: sorted(r.brand_ids), hosting_provider_ids: sorted(r.hosting_provider_ids) }));
}

describe.skipIf(!hasSqlite())("0323 results are identical to the pre-0323 lanes", () => {
  for (const [label, prep] of VARIANTS) {
    it(`grouped rows match (${label})`, () => {
      // ONE seeded database (first_seen is datetime('now', …), so two
      // separately seeded copies can straddle a second): the new SQL runs
      // with 0323's indexes, then they are dropped — leaving exactly the
      // pre-0323 schema — and the pre-0323 SQL runs on the same rows.
      const db = openMigratedDb();
      seedEdges(db);
      prep(db);
      const asnAfter = db.prepare(ASN_LANE_SQL).all(ASN_MAX_BRAND_FANOUT) as Row[];
      const subAfter = db.prepare(SUBNET_LANE_SQL).all(DEFAULT_HUB_FANOUT_THRESHOLD) as Row[];
      const ipAfter = db.prepare(PER_IP_LANE_SQL).all(DEFAULT_HUB_FANOUT_THRESHOLD) as Row[];
      expect(plan(db, ASN_LANE_SQL)[0]).toContain("idx_threats_asn_lane");
      db.exec("DROP INDEX idx_threats_asn_lane");
      db.exec("DROP INDEX idx_threats_subnet_lane");
      const asnBefore = db.prepare(LEGACY_ASN_LANE_SQL).all(ASN_MAX_BRAND_FANOUT) as Row[];
      const subBefore = db.prepare(LEGACY_SUBNET_LANE_SQL).all(DEFAULT_HUB_FANOUT_THRESHOLD) as Row[];
      const ipBefore = db.prepare(PER_IP_LANE_SQL).all(DEFAULT_HUB_FANOUT_THRESHOLD) as Row[];
      expect(plan(db, LEGACY_ASN_LANE_SQL)[0]).not.toContain("_lane");

      expect(asnBefore.length).toBeGreaterThan(3);
      expect(canonicalGroups(asnAfter)).toEqual(canonicalGroups(asnBefore));
      // The normalised key is asnKey of every raw spelling it grouped.
      for (const r of asnAfter) {
        for (const rawAsn of JSON.parse(String(r.raw_asns)) as unknown[]) expect(asnKey(rawAsn)).toBe(r.asn);
      }
      const v = asnAfter.find((r) => r.asn === "AS64500");
      expect(v?.threats).toBe(13);
      expect(asnAfter.some((r) => r.asn === "AS64505" || r.asn === "AS64506" || r.asn === "AS64503")).toBe(false);

      expect(subBefore.length).toBeGreaterThan(1);
      expect(canonicalGroups(subAfter)).toEqual(canonicalGroups(subBefore));
      const subnets = subAfter.map((r) => r.subnet24);
      expect(subnets).toContain("198.18.7.");
      expect(subnets).toContain("198.18.70.");
      expect(subnets.some((s) => /^(10\.|100\.64\.)/.test(String(s)) || String(s).includes(":"))).toBe(false);
      expect(subAfter.find((r) => r.subnet24 === "198.18.7.")?.threat_count).toBe(9);

      // The per-IP lane can pick idx_threats_subnet_lane up (see plans).
      expect(ipBefore.length).toBeGreaterThan(0);
      expect(canonicalGroups(ipAfter)).toEqual(canonicalGroups(ipBefore));
    });
  }

  it("the lanes leave identical clusters and stamps (pre-0323 schema vs 0323)", async () => {
    const before = openMigratedDb({ exclude: MIGRATIONS });
    const after = openMigratedDb();
    for (const raw of [before, after]) {
      seedEdges(raw);
      const db = d1FromSqlite(raw);
      await runSubnetLane(db);
      await runAsnLane(db);
    }
    const cb = canonicalClusters(before);
    expect(cb.length).toBeGreaterThan(3);
    expect(canonicalClusters(after)).toEqual(cb);
    const stamps = (raw: SqliteDb) => raw.prepare("SELECT id, cluster_id FROM threats ORDER BY id").all();
    expect(stamps(after)).toEqual(stamps(before));
  });

  it("the expression index follows asn / status writes", async () => {
    const raw = openMigratedDb();
    insertThreats(raw, many(10, (i) => ({ id: `w_${i}`, threat_type: "phishing", asn: null, brand: `wb${i % 2}` })));
    const db = d1FromSqlite(raw);
    expect((await runAsnLane(db)).analyzed).toBe(0);
    // Enrichment-style fill (cartographer: asn = COALESCE(asn, ?)).
    raw.prepare("UPDATE threats SET asn = COALESCE(asn, ?) WHERE id LIKE 'w\\_%' ESCAPE '\\'").run("64520 Example Ltd");
    const r = await runAsnLane(db);
    expect(r.clusters.map((c) => c.asn)).toEqual(["AS64520"]);
    expect(r.clusters[0]!.threats).toBe(10);
    // A status flip drops rows out of the partial index.
    raw.prepare("UPDATE threats SET status = 'remediated' WHERE id IN ('w_0', 'w_1')").run();
    const rows = raw.prepare(ASN_LANE_SQL).all(ASN_MAX_BRAND_FANOUT) as Row[];
    expect(rows).toEqual([]); // 8 < the 10-threat floor
  });
});
