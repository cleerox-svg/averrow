import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openMigratedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import { insertThreats, many, seedScenario } from "./nexus-fixtures";
import {
  tallyCountries,
  computeAsnClusterConfidence,
  computePerIpConfidence,
  decideLaneRowRetirement,
  runCertSerialLane,
  runCertSanLane,
  runPerIpLane,
  runSubnetLane,
  runRegistrarLane,
  runAsnLane,
  retireNonOperationalLaneClusters,
  ASN_CONFIDENCE_CAP,
  COUNTRY_COUNTS_CAP,
} from "../src/lib/nexus-threat-lanes";
import {
  generateClusterName,
  certSerialClusterName,
  certSanClusterName,
  perIpClusterName,
  subnetClusterName,
  registrarClusterName,
} from "../src/lib/cluster-naming";
import { SHARED_INFRA_ASNS, asnKey, asnKeySql, isSharedInfraAsn } from "../src/lib/shared-infra-asns";

// ─── Pure units ─────────────────────────────────────────────────────────

const ASN_SAMPLES: Array<[string | null, string | null]> = [
  ["AS13335", "AS13335"],
  ["as13335", "AS13335"],
  ["AS13335 Cloudflare, Inc.", "AS13335"],
  ["  AS4837 China Unicom", "AS4837"],
  ["AS4837,China", "AS4837"],
  ["13335", "AS13335"],
  ["13335 Cloudflare", "AS13335"],
  ["AS", null],
  ["AS 13335", null],
  ["ASX13335", null],
  ["Cloudflare", null],
  ["", null],
  [null, null],
];

describe("asnKey", () => {
  it.each(ASN_SAMPLES)("%s → %s", (raw, want) => {
    expect(asnKey(raw)).toBe(want);
  });

  it("every shared-infra entry is canonical and recognised", () => {
    for (const a of SHARED_INFRA_ASNS) {
      expect(asnKey(a)).toBe(a);
      expect(isSharedInfraAsn(a)).toBe(true);
    }
    expect(isSharedInfraAsn("AS13335 Cloudflare, Inc.")).toBe(true);
    expect(isSharedInfraAsn("AS4837")).toBe(false);
  });
});

describe.skipIf(!hasSqlite())("asnKeySql is the SQL twin of asnKey", () => {
  it("agrees on every sample", () => {
    const db = openMigratedDb();
    db.exec("CREATE TABLE asn_samples (asn TEXT)");
    const ins = db.prepare("INSERT INTO asn_samples (asn) VALUES (?)");
    for (const [raw] of ASN_SAMPLES) ins.run(raw);
    const rows = db.prepare(`SELECT asn, ${asnKeySql("asn")} AS n FROM asn_samples`).all() as Array<{ asn: string | null; n: string | null }>;
    expect(rows).toHaveLength(ASN_SAMPLES.length);
    for (const r of rows) expect(r.n, String(r.asn)).toBe(asnKey(r.asn));
  });

  it("refuses a non-identifier column", () => {
    expect(() => asnKeySql("asn); DROP TABLE x;--")).toThrow();
  });
});

describe("tallyCountries", () => {
  it("counts per member, orders by volume, skips blanks and XX", () => {
    const t = tallyCountries("US,CA,US,,XX,us,DE,CA,US,ZZZ");
    expect(t.countries).toEqual(["US", "CA", "DE"]);
    expect(t.countryCounts).toEqual({ US: 4, CA: 2, DE: 1 });
    expect(Object.keys(t.countryCounts)).toEqual(["US", "CA", "DE"]); // key order = rank
  });

  it("caps country_counts at the top 20 but keeps every country in `countries`", () => {
    const codes: string[] = [];
    for (let i = 0; i < 25; i++) {
      const cc = String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26));
      for (let k = 0; k <= i; k++) codes.push(cc);
    }
    const t = tallyCountries(codes.join(","));
    expect(t.countries).toHaveLength(25);
    expect(Object.keys(t.countryCounts)).toHaveLength(COUNTRY_COUNTS_CAP);
    expect(Object.values(t.countryCounts)[0]).toBe(25); // the largest kept first
  });

  it("empty / null input", () => {
    expect(tallyCountries(null)).toEqual({ countries: [], countryCounts: {} });
  });
});

describe("computeAsnClusterConfidence", () => {
  it("never exceeds the ASN-only cap", () => {
    expect(computeAsnClusterConfidence({ threats: 65_000, campaigns: 40, brands: 1, distinctCountries: 1 }))
      .toBe(ASN_CONFIDENCE_CAP);
    expect(ASN_CONFIDENCE_CAP).toBe(40);
  });

  it("does not reward brand breadth — a widely-shared ASN scores LOW (the old model scored 100)", () => {
    const wide = computeAsnClusterConfidence({ threats: 65_000, campaigns: 0, brands: 900, distinctCountries: 40 });
    const narrow = computeAsnClusterConfidence({ threats: 65_000, campaigns: 0, brands: 3, distinctCountries: 40 });
    expect(wide).toBeLessThan(narrow);
    expect(wide).toBeLessThanOrEqual(15);
  });

  it("rises with specificity: country concentration and campaign overlap", () => {
    const base = { threats: 20, brands: 5 };
    const spread = computeAsnClusterConfidence({ ...base, campaigns: 0, distinctCountries: 8 });
    const oneCountry = computeAsnClusterConfidence({ ...base, campaigns: 0, distinctCountries: 1 });
    const withCampaigns = computeAsnClusterConfidence({ ...base, campaigns: 2, distinctCountries: 1 });
    expect(oneCountry).toBeGreaterThan(spread);
    expect(withCampaigns).toBeGreaterThan(oneCountry);
  });
});

describe("computePerIpConfidence", () => {
  it("does not increase with brand breadth", () => {
    const few = computePerIpConfidence({ threats: 30, brands: 5, asnCount: 1 });
    const mid = computePerIpConfidence({ threats: 30, brands: 50, asnCount: 1 });
    const many = computePerIpConfidence({ threats: 30, brands: 140, asnCount: 1 });
    expect(few).toBeGreaterThanOrEqual(mid);
    expect(mid).toBeGreaterThanOrEqual(many);
  });

  it("rises with volume and single-network hosting, bounded", () => {
    expect(computePerIpConfidence({ threats: 200, brands: 5, asnCount: 1 }))
      .toBeGreaterThan(computePerIpConfidence({ threats: 5, brands: 5, asnCount: 3 }));
    expect(computePerIpConfidence({ threats: 1e6, brands: 3, asnCount: 1 })).toBeLessThanOrEqual(80);
    expect(computePerIpConfidence({ threats: 5, brands: 150, asnCount: 0 })).toBeGreaterThanOrEqual(30);
  });
});

describe("evidence-first cluster names", () => {
  it("ASN: no country prefix", () => {
    expect(generateClusterName({ asn: "AS4837", threat_type: "malware_distribution" })).toBe("AS4837 · malware distribution");
    expect(generateClusterName({ asn: "AS4837", threat_type: null })).toBe("AS4837 · threat");
    expect(generateClusterName({ asn: null, threat_type: "phishing" })).toBe("Unknown ASN · phishing");
  });

  it("cert / IP / subnet / registrar", () => {
    expect(certSanClusterName("85bbc2d0e1f2a3b4", 370)).toBe("Cert SAN 85bbc2… · 370 domains");
    expect(certSerialClusterName("0a1b2c3d4e5f60718293", 3)).toBe("Cert serial 0a1b2c3d4e5f… · 3 domains");
    expect(certSerialClusterName("0a1b", 2)).toBe("Cert serial 0a1b · 2 domains");
    expect(perIpClusterName("203.0.113.7", 4)).toBe("IP 203.0.113.7 · 4 brands");
    expect(subnetClusterName("74.115.51.", 3)).toBe("Subnet 74.115.51.0/24 · 3 IPs");
    expect(registrarClusterName("Example Registrar")).toBe("Registrar Example Registrar · 14d cohort");
  });
});

describe("decideLaneRowRetirement", () => {
  const row = (id: string, asns: unknown[], types: unknown[], fanout = 1) => ({
    id, asns: JSON.stringify(asns), attack_types: JSON.stringify(types), brand_fanout: fanout,
  });

  it("ASN rows: shared ASN / IP-reputation → shared_infra; malformed key → superseded; real → untouched", () => {
    expect(decideLaneRowRetirement(row("cluster_asn_as13335_phishing", ["AS13335"], ["phishing"]))?.status).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_asn_as4134_scanning", ["AS4134"], ["scanning"]))?.status).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_asn_as4134_malicious_ip", ["AS4134"], ["malicious_ip"]))?.status).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_asn_as4837_cn_unicom_phishing", ["AS4837 CN Unicom"], ["phishing"]))?.status).toBe("superseded");
    expect(decideLaneRowRetirement(row("cluster_asn_as4837_unknown", ["AS4837"], [null]))?.status).toBe("superseded");
    expect(decideLaneRowRetirement(row("cluster_asn_as4837_phishing", ["AS4837"], ["phishing"]))).toBeNull();
  });

  it("per-IP rows: hub fan-out or shared ASN → shared_infra", () => {
    expect(decideLaneRowRetirement(row("cluster_ip_13.248.169.48", ["AS16509"], ["phishing"], 900))?.status).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_ip_198.51.100.1", [], ["phishing"], 151))?.status).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_ip_104.21.0.9", ["AS13335 Cloudflare"], ["phishing"], 10))?.status).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_ip_203.0.113.7", ["AS9009"], ["phishing"], 150))).toBeNull();
  });

  it("other lanes are never touched", () => {
    expect(decideLaneRowRetirement(row("cluster_cert_abc", ["AS13335"], ["phishing"], 900))).toBeNull();
    expect(decideLaneRowRetirement(row("cluster_subnet_1_2_3", ["AS13335"], ["phishing"], 900))).toBeNull();
  });
});

// ─── Lane SQL against the real migrated schema ─────────────────────────

type ClusterRow = {
  id: string; cluster_name: string; status: string; threat_count: number;
  confidence_score: number; asns: string; countries: string; country_counts: string | null;
};

describe.skipIf(!hasSqlite())("NEXUS threats lanes on the migrated schema", () => {
  let raw: SqliteDb;
  let db: D1Database;
  const cluster = (id: string): ClusterRow | undefined =>
    raw.prepare("SELECT * FROM infrastructure_clusters WHERE id = ?").all(id)[0] as ClusterRow | undefined;
  const stampedTo = (id: string): number =>
    (raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE cluster_id = ?").all(id)[0] as { n: number }).n;
  const allIds = (): string[] =>
    (raw.prepare("SELECT id FROM infrastructure_clusters ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);

  async function runAll(): Promise<void> {
    await runCertSerialLane(db);
    await runCertSanLane(db);
    await runPerIpLane(db);
    await runSubnetLane(db);
    await runRegistrarLane(db);
    await runAsnLane(db);
    await retireNonOperationalLaneClusters(db);
  }

  beforeEach(() => {
    raw = openMigratedDb();
    db = d1FromSqlite(raw);
    seedScenario(raw);
  });

  it("ASN lane: shared-infra and IP-reputation groups never cluster; the real group counts ACTIVE threats only", async () => {
    const r = await runAsnLane(db);
    expect(r.writeErrors).toBe(0);
    const asnIds = allIds().filter((id) => id.startsWith("cluster_asn_"));
    expect(asnIds).toEqual(["cluster_asn_as4837_malware_distribution"]);

    const c = cluster("cluster_asn_as4837_malware_distribution")!;
    expect(c.threat_count).toBe(12);                      // 9 + 3 malformed spellings, 0 inactive
    expect(stampedTo(c.id)).toBe(12);                      // count == stamped
    expect(JSON.parse(c.asns)).toEqual(["AS4837"]);        // normalised
    expect(c.cluster_name).toBe("AS4837 · malware distribution");
    expect(c.confidence_score).toBeLessThanOrEqual(ASN_CONFIDENCE_CAP);
    expect(JSON.parse(c.country_counts!)).toEqual({ CN: 9, HK: 3 });
    expect(JSON.parse(c.countries)).toEqual(["CN", "HK"]);
    // inactive members are left alone
    expect((raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE id LIKE 'cuold_%' AND cluster_id IS NOT NULL").all()[0] as { n: number }).n).toBe(0);
    // no Cloudflare / scanning threat was stamped
    expect((raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE (id LIKE 'cf%' OR id LIKE 'scan_%') AND cluster_id IS NOT NULL").all()[0] as { n: number }).n).toBe(0);
  });

  it("ASN lane: confidence and the dormancy-pivot gate use the ASN scale", async () => {
    // A concentrated, campaign-linked group that went quiet: 20 threats 8-13
    // days ago, 1 in the last week → pivot.
    insertThreats(raw, [
      ...many(20, (i) => ({ id: `pv_${i}`, asn: "AS64500", cc: "RU", campaign: i % 2 ? "camp_a" : "camp_b", brand: "q1", daysAgo: 8 + (i % 5) })),
      { id: "pv_recent", asn: "AS64500", cc: "RU", brand: "q1", daysAgo: 1 },
    ]);
    const r = await runAsnLane(db);
    const pv = r.clusters.find((c) => c.clusterId === "cluster_asn_as64500_phishing")!;
    expect(pv.confidence).toBe(35); // 15 base + 10 one-country + 10 campaigns (21 threats: no volume bonus)
    expect(pv.isPivoting).toBe(true);
    expect(pv.pivotEmitted).toBe(true);
    expect(cluster(pv.clusterId)!.status).toBe("dormant");
    const ev = raw.prepare("SELECT payload_json FROM agent_events WHERE event_type = 'pivot_detected'").all() as Array<{ payload_json: string }>;
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.payload_json)).toMatchObject({ kind: "dormancy", cluster_id: pv.clusterId, asn: "AS64500" });
  });

  it("per-IP lane: hub and shared-ASN IPs are excluded; the real IP clusters with volume-based confidence", async () => {
    const r = await runPerIpLane(db);
    expect(r.analyzed).toBe(1);
    const ipIds = allIds().filter((id) => id.startsWith("cluster_ip_"));
    expect(ipIds).toEqual(["cluster_ip_203.0.113.7"]);
    const c = cluster("cluster_ip_203.0.113.7")!;
    expect(c.threat_count).toBe(8);
    expect(c.cluster_name).toBe("IP 203.0.113.7 · 4 brands");
    expect(c.confidence_score).toBe(computePerIpConfidence({ threats: 8, brands: 4, asnCount: 1 }));
    expect(JSON.parse(c.country_counts!)).toEqual({ NL: 8 });
    expect(stampedTo(c.id)).toBe(8);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE ip_address IN ('13.248.169.48','198.51.100.200','104.21.0.9') AND cluster_id IS NOT NULL").all()[0] as { n: number }).n).toBe(0);
  });

  it("per-IP lane ranks by threat volume, not brand breadth", async () => {
    raw.exec("DELETE FROM threats");
    insertThreats(raw, [
      ...many(6, (i) => ({ id: `wide_${i}`, ip: "192.0.2.1", asn: "AS65001", brand: `w${i}` })),          // 6 brands, 6 threats
      ...many(40, (i) => ({ id: `deep_${i}`, ip: "192.0.2.2", asn: "AS65001", brand: `d${i % 3}` })),    // 3 brands, 40 threats
    ]);
    const sql = (await import("../src/lib/nexus-threat-lanes")).PER_IP_LANE_SQL;
    const rows = raw.prepare(sql).all(150) as Array<{ ip_address: string }>;
    expect(rows.map((r) => r.ip_address)).toEqual(["192.0.2.2", "192.0.2.1"]);
  });

  it("/24 lane: shared-infra subnets are excluded (broadened list); the real subnet clusters", async () => {
    await runSubnetLane(db);
    const ids = allIds().filter((id) => id.startsWith("cluster_subnet_"));
    expect(ids).toEqual(["cluster_subnet_74_115_51"]);
    const c = cluster("cluster_subnet_74_115_51")!;
    expect(c.cluster_name).toBe("Subnet 74.115.51.0/24 · 3 IPs");
    expect(JSON.parse(c.country_counts!)).toEqual({ DE: 6, PL: 3 });
    expect(stampedTo(c.id)).toBe(9);
  });

  it("/24 stamp mirrors the shared-ASN filter (a CDN member of a qualifying /24 is not claimed)", async () => {
    insertThreats(raw, [{ id: "sn_cdn", ip: "74.115.51.99", asn: "AS13335", brand: "s0" }]);
    await runSubnetLane(db);
    const row = raw.prepare("SELECT cluster_id FROM threats WHERE id = 'sn_cdn'").all()[0] as { cluster_id: string | null };
    expect(row.cluster_id).toBeNull();
  });

  it("cert lane on shared infra still clusters (specific evidence) and writes country_counts", async () => {
    await runCertSerialLane(db);
    const c = cluster("cluster_cert_0a1b2c3d4e5f60718293")!;
    expect(c.cluster_name).toBe("Cert serial 0a1b2c3d4e5f… · 3 domains");
    expect(JSON.parse(c.asns)).toEqual(["AS13335"]);
    expect(JSON.parse(c.country_counts!)).toEqual({ US: 3 });
  });

  it("registrar lane writes country_counts and the evidence name", async () => {
    raw.exec("DELETE FROM threats");
    insertThreats(raw, many(9, (i) => ({
      id: `rg_${i}`, registrar: "Shady Registrar LLC", ip: `192.0.2.${i % 2}`, brand: `r${i % 3}`, cc: i < 5 ? "SG" : "MY", daysAgo: 1,
    })));
    await runRegistrarLane(db);
    const c = cluster("cluster_registrar_shady_registrar_llc")!;
    expect(c.cluster_name).toBe("Registrar Shady Registrar LLC · 14d cohort");
    expect(JSON.parse(c.country_counts!)).toEqual({ SG: 5, MY: 4 });
  });

  it("precedence: a specific lane's claim is never overwritten by the ASN mop-up", async () => {
    insertThreats(raw, many(12, (i) => ({ id: `prec_${i}`, ip: "192.0.2.50", asn: "AS65010", brand: `pr${i % 4}` })));
    await runPerIpLane(db);
    await runAsnLane(db);
    expect(stampedTo("cluster_ip_192.0.2.50")).toBe(12);
    expect(stampedTo("cluster_asn_as65010_phishing")).toBe(0);
  });

  it("retire pass: parks stale shared-infra / hub rows, supersedes malformed keys, is idempotent", async () => {
    const ins = raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, asns, attack_types, brand_ids, status, threat_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const brands = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => `b${i}`));
    ins.run("cluster_asn_as13335_phishing", "CA AS13335 phishing cluster", '["AS13335"]', '["phishing"]', brands(900), "active", 65048);
    ins.run("cluster_asn_as4134_scanning", "CN AS4134 scanning cluster", '["AS4134"]', '["scanning"]', brands(1), "dormant", 500);
    ins.run("cluster_asn_as13335_cloudflare_inc_phishing", "x", '["AS13335 Cloudflare, Inc."]', '["phishing"]', brands(3), "active", 10);
    ins.run("cluster_ip_13.248.169.48", "IP hub", '["AS16509"]', '["phishing"]', brands(900), "active", 3000);
    ins.run("cluster_asn_as4837_malware_distribution", "old", '["AS4837"]', '["malware_distribution"]', brands(3), "active", 1);

    await runAll();
    const st = (id: string) => cluster(id)!.status;
    expect(st("cluster_asn_as13335_phishing")).toBe("shared_infra");
    expect(st("cluster_asn_as4134_scanning")).toBe("shared_infra");
    expect(st("cluster_asn_as13335_cloudflare_inc_phishing")).toBe("superseded");
    expect(st("cluster_ip_13.248.169.48")).toBe("shared_infra");
    expect(st("cluster_asn_as4837_malware_distribution")).toBe("active");
    expect(cluster("cluster_asn_as4837_malware_distribution")!.threat_count).toBe(12); // refreshed by the lane

    const again = await retireNonOperationalLaneClusters(db);
    expect(again.markedSharedInfra + again.markedSuperseded).toBe(0);
  });

  it("a shared_infra per-IP row that qualifies again is reactivated by the lane", async () => {
    raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, asns, brand_ids, status, threat_count)
       VALUES ('cluster_ip_203.0.113.7', 'old', '[]', '[]', 'shared_infra', 0)`,
    ).run();
    await runPerIpLane(db);
    expect(cluster("cluster_ip_203.0.113.7")!.status).toBe("active");
  });

  it("a full run produces exactly the expected operations", async () => {
    await runAll();
    const ops = (raw.prepare(
      `SELECT id FROM infrastructure_clusters WHERE status NOT IN ('superseded','shared_infra') ORDER BY id`,
    ).all() as Array<{ id: string }>).map((r) => r.id);
    expect(ops).toEqual([
      "cluster_asn_as4837_malware_distribution",
      "cluster_cert_0a1b2c3d4e5f60718293",
      "cluster_ip_203.0.113.7",
      "cluster_subnet_74_115_51",
    ]);
  });
});
