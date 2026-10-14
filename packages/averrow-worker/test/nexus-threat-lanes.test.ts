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
  isBogonIpv4,
  parseJsonAsnArray,
  NOT_BOGON_IP_SQL,
  ASN_LANE_SQL,
  ASN_MAX_BRAND_FANOUT,
  ASN_CONFIDENCE_CAP,
  ASN_PIVOT_MIN_CONFIDENCE,
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
import {
  SHARED_INFRA_ASNS,
  MULTI_TENANT_ASNS,
  SINGLE_TENANT_IAAS_ASNS,
  SHARED_INFRA_ASNS_SQL_LIST,
  MULTI_TENANT_ASNS_SQL_LIST,
  SINGLE_TENANT_IAAS_ASNS_SQL_LIST,
  asnKey,
  asnKeySql,
  isSharedInfraAsn,
  isMultiTenantAsn,
} from "../src/lib/shared-infra-asns";

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

describe("shared-infra split: multi-tenant vs single-tenant IaaS", () => {
  it("the two sets are disjoint and their union is SHARED_INFRA_ASNS", () => {
    for (const a of MULTI_TENANT_ASNS) expect(SINGLE_TENANT_IAAS_ASNS.has(a), a).toBe(false);
    expect(SHARED_INFRA_ASNS.size).toBe(MULTI_TENANT_ASNS.size + SINGLE_TENANT_IAAS_ASNS.size);
    for (const a of [...MULTI_TENANT_ASNS, ...SINGLE_TENANT_IAAS_ASNS]) expect(SHARED_INFRA_ASNS.has(a)).toBe(true);
  });

  it("classifies CDN / site builders / parking as multi-tenant and hyperscalers / VPS as IaaS", () => {
    for (const a of ["AS13335", "AS209242", "AS16625", "AS20940", "AS54113", "AS15169", "AS16509", "AS8075",
      "AS27647", "AS58182", "AS34119", "AS47583", "AS22612", "AS133618", "AS40034", "AS15348", "AS32491",
      "AS2635", "AS30148", "AS40680", "AS53831", "AS47846", "AS8560", "AS6724", "AS29169", "AS397273"]) {
      expect(MULTI_TENANT_ASNS.has(a), a).toBe(true);
    }
    for (const a of ["AS14618", "AS8987", "AS396982", "AS14061", "AS16276", "AS24940", "AS20473", "AS63949",
      "AS45102", "AS37963", "AS132203", "AS45090", "AS31898", "AS135377"]) {
      expect(SINGLE_TENANT_IAAS_ASNS.has(a), a).toBe(true);
    }
    expect(isMultiTenantAsn("AS13335 Cloudflare, Inc.")).toBe(true);
    expect(isMultiTenantAsn("AS14618")).toBe(false);
    expect(isSharedInfraAsn("AS14618")).toBe(true);
    // Google front-ends (Sites / Firebase / appspot) and Amazon's primary
    // ASN (CloudFront / S3 website / Amplify) serve many tenants per IP.
    expect(isMultiTenantAsn("AS15169")).toBe(true);
    expect(isMultiTenantAsn("16509")).toBe(true);
    // Google Cloud (GCE VMs; LB IPs are per customer project) is IaaS.
    expect(isMultiTenantAsn("AS396982")).toBe(false);
    expect(isSharedInfraAsn("AS396982")).toBe(true);
  });

  it("SQL lists carry exactly the set members", () => {
    const parse = (l: string) => new Set(l.split(", ").map((x) => x.replace(/'/g, "")));
    expect(parse(SHARED_INFRA_ASNS_SQL_LIST)).toEqual(new Set(SHARED_INFRA_ASNS));
    expect(parse(MULTI_TENANT_ASNS_SQL_LIST)).toEqual(new Set(MULTI_TENANT_ASNS));
    expect(parse(SINGLE_TENANT_IAAS_ASNS_SQL_LIST)).toEqual(new Set(SINGLE_TENANT_IAAS_ASNS));
  });

  it("parseJsonAsnArray accepts numeric entries and every asnKey form", () => {
    expect(parseJsonAsnArray("[13335, \"AS4837 China Unicom\", \"x\", null, \"16509\"]")).toEqual(["AS13335", "AS4837", "AS16509"]);
    expect(parseJsonAsnArray("not json")).toEqual([]);
    expect(parseJsonAsnArray(null)).toEqual([]);
  });
});

// ─── Bogon / private IPs ────────────────────────────────────────────────

const IP_SAMPLES: Array<[string, boolean]> = [
  ["0.0.0.0", true], ["0.1.2.3", true], ["10.0.0.1", true], ["127.0.0.1", true], ["127.255.255.254", true],
  ["169.254.1.1", true], ["192.168.0.1", true],
  ["172.16.0.1", true], ["172.31.255.255", true], ["172.15.0.1", false], ["172.32.0.1", false], ["172.2.0.1", false],
  ["100.64.0.1", true], ["100.127.1.1", true], ["100.63.0.1", false], ["100.128.0.1", false], ["100.1.2.3", false],
  ["1.0.0.1", false], ["100.0.0.1", false], ["101.0.0.1", false], ["110.0.0.1", false], ["192.169.0.1", false],
  ["169.25.1.1", false], ["203.0.113.7", false], ["2001:db8::1", false], ["8.8.8.8", false],
  // Padded values: both twins trim spaces (the retire pass reads the cleaned
  // IP from the cluster id, so the lane SQL must agree on padded input).
  [" 10.0.0.1", true], ["127.0.0.1 ", true], ["  172.20.0.1  ", true], [" 100.64.0.1", true], [" 8.8.8.8 ", false],
];

describe("isBogonIpv4", () => {
  it.each(IP_SAMPLES)("%s → %s", (ip, want) => {
    expect(isBogonIpv4(ip)).toBe(want);
  });
});

describe.skipIf(!hasSqlite())("NOT_BOGON_IP_SQL is the SQL twin of isBogonIpv4", () => {
  it("agrees on every sample", () => {
    const db = openMigratedDb();
    db.exec("CREATE TABLE ip_samples (ip_address TEXT)");
    const ins = db.prepare("INSERT INTO ip_samples (ip_address) VALUES (?)");
    for (const [ip] of IP_SAMPLES) ins.run(ip);
    const rows = db.prepare(`SELECT ip_address, ${NOT_BOGON_IP_SQL} AS ok FROM ip_samples`).all() as Array<{ ip_address: string; ok: number }>;
    expect(rows).toHaveLength(IP_SAMPLES.length);
    for (const r of rows) expect(r.ok === 0, r.ip_address).toBe(isBogonIpv4(r.ip_address));
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
  it("reaches but never exceeds the ASN-only cap", () => {
    expect(computeAsnClusterConfidence({ threats: 65_000, campaigns: 40, brands: 1 })).toBe(ASN_CONFIDENCE_CAP);
    expect(ASN_CONFIDENCE_CAP).toBe(40);
  });

  it("does not reward brand breadth — a widely-shared ASN scores LOW (the old model scored 100)", () => {
    const wide = computeAsnClusterConfidence({ threats: 65_000, campaigns: 0, brands: 900 });
    const narrow = computeAsnClusterConfidence({ threats: 65_000, campaigns: 0, brands: 3 });
    expect(wide).toBeLessThan(narrow);
    expect(wide).toBeLessThanOrEqual(15);
  });

  it("campaign overlap is the main lift; low fan-out (<= 5 brands) adds a small bonus", () => {
    const base = { threats: 20 };
    const plain = computeAsnClusterConfidence({ ...base, campaigns: 0, brands: 20 });
    const targeted = computeAsnClusterConfidence({ ...base, campaigns: 0, brands: 5 });
    const oneCampaign = computeAsnClusterConfidence({ ...base, campaigns: 1, brands: 20 });
    const campaigns = computeAsnClusterConfidence({ ...base, campaigns: 2, brands: 20 });
    expect(plain).toBe(15);
    expect(targeted).toBe(20);
    expect(computeAsnClusterConfidence({ ...base, campaigns: 0, brands: 6 })).toBe(15);
    expect(oneCampaign).toBe(20);
    expect(campaigns).toBe(30);
    expect(campaigns - plain).toBeGreaterThan(targeted - plain);
  });

  it("no country term: the score is independent of geography (an ASN is one country's space)", () => {
    // The signature no longer takes distinctCountries; a pivot-eligible
    // score needs campaigns or targeting + volume, not a single country.
    expect(computeAsnClusterConfidence({ threats: 20, campaigns: 0, brands: 20 })).toBeLessThan(ASN_PIVOT_MIN_CONFIDENCE);
    expect(computeAsnClusterConfidence({ threats: 20, campaigns: 2, brands: 20 })).toBeGreaterThanOrEqual(ASN_PIVOT_MIN_CONFIDENCE);
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
    expect(decideLaneRowRetirement(row("cluster_asn_as13335_phishing", ["AS13335"], ["phishing"]))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_asn_as4134_scanning", ["AS4134"], ["scanning"]))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_asn_as4134_malicious_ip", ["AS4134"], ["malicious_ip"]))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_asn_as4837_cn_unicom_phishing", ["AS4837 CN Unicom"], ["phishing"]))?.retiredReason).toBe("superseded");
    expect(decideLaneRowRetirement(row("cluster_asn_as4837_unknown", ["AS4837"], [null]))?.retiredReason).toBe("superseded");
    expect(decideLaneRowRetirement(row("cluster_asn_as4837_phishing", ["AS4837"], ["phishing"]))).toBeNull();
  });

  it("ASN rows: brand fan-out over the hub threshold → shared_infra (data-driven landlord rule)", () => {
    expect(decideLaneRowRetirement(row("cluster_asn_as4837_phishing", ["AS4837"], ["phishing"], ASN_MAX_BRAND_FANOUT + 1))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_asn_as4837_phishing", ["AS4837"], ["phishing"], ASN_MAX_BRAND_FANOUT))).toBeNull();
  });

  it("ASN rows: IaaS ASNs retire too (ASN lane skips both sets); a '' type is superseded", () => {
    expect(decideLaneRowRetirement(row("cluster_asn_as16509_phishing", ["AS16509"], ["phishing"]))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_asn_as4837_unknown", ["AS4837"], [""]))?.retiredReason).toBe("superseded");
  });

  it("numeric asns entries are read (a [13335] row is still retired)", () => {
    expect(decideLaneRowRetirement(row("cluster_asn_as13335_phishing", [13335], ["phishing"]))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_ip_104.21.0.9", [13335], ["phishing"], 10))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_asn_as4837_phishing", [4837], ["phishing"]))).toBeNull();
  });

  it("per-IP rows: hub fan-out, multi-tenant ASN or bogon IP → shared_infra; IaaS stays", () => {
    expect(decideLaneRowRetirement(row("cluster_ip_13.248.169.48", ["AS16509"], ["phishing"], 900))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_ip_198.51.100.1", [], ["phishing"], 151))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_ip_104.21.0.9", ["AS13335 Cloudflare"], ["phishing"], 10))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_ip_127.0.0.1", ["AS9009"], ["phishing"], 10))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_ip_100.64.3.4", [], ["phishing"], 10))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_ip_203.0.113.7", ["AS9009"], ["phishing"], 150))).toBeNull();
    // An IaaS IP is a legitimate per-IP cluster (one VM = one customer).
    expect(decideLaneRowRetirement(row("cluster_ip_54.80.0.5", ["AS14618"], ["phishing"], 12))).toBeNull();
    expect(decideLaneRowRetirement(row("cluster_ip_34.120.0.5", ["AS396982"], ["phishing"], 12))).toBeNull();
    // ...but Google front-end / Amazon primary-ASN IPs are multi-tenant.
    expect(decideLaneRowRetirement(row("cluster_ip_216.239.32.21", ["AS15169"], ["phishing"], 3))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_ip_52.84.0.5", ["AS16509"], ["phishing"], 3))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_ip_51.38.10.1", ["AS16276"], ["phishing"], 12))).toBeNull();
  });

  it("subnet rows: shared ASN (either set), hub fan-out or bogon range → shared_infra", () => {
    expect(decideLaneRowRetirement(row("cluster_subnet_104_21_0", ["AS13335"], ["phishing"], 10))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_subnet_51_38_10", ["AS9999", "AS16276"], ["phishing"], 10))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_subnet_74_115_51", ["AS9999"], ["phishing"], 151))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_subnet_192_168_1", ["AS9999"], ["phishing"], 10))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_subnet_172_20_0", [], ["phishing"], 10))?.retiredReason).toBe("shared_infra");
    expect(decideLaneRowRetirement(row("cluster_subnet_74_115_51", ["AS9999"], ["phishing"], 150))).toBeNull();
    expect(decideLaneRowRetirement(row("cluster_subnet_172_32_0", ["AS9999"], ["phishing"], 10))).toBeNull();
  });

  it("cert / registrar rows are never touched", () => {
    expect(decideLaneRowRetirement(row("cluster_cert_abc", ["AS13335"], ["phishing"], 900))).toBeNull();
    expect(decideLaneRowRetirement(row("cluster_registrar_x", ["AS13335"], ["phishing"], 900))).toBeNull();
  });
});

// ─── Lane SQL against the real migrated schema ─────────────────────────

type ClusterRow = {
  id: string; cluster_name: string; status: string; retired_reason: string | null; threat_count: number;
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
    expect(pv.confidence).toBe(35); // 15 base + 15 (2 campaigns) + 5 (1 brand: targeted); 21 threats: no volume bonus
    expect(pv.isPivoting).toBe(true);
    expect(pv.pivotEmitted).toBe(true);
    expect(cluster(pv.clusterId)!.status).toBe("dormant");
    const ev = raw.prepare("SELECT payload_json FROM agent_events WHERE event_type = 'pivot_detected'").all() as Array<{ payload_json: string }>;
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.payload_json)).toMatchObject({ kind: "dormancy", cluster_id: pv.clusterId, asn: "AS64500" });
  });

  it("per-IP lane: hub and multi-tenant-ASN IPs are excluded; the real IP clusters with volume-based confidence", async () => {
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

  it("per-IP lane: an IaaS IP is eligible, while the same IaaS ASN never forms an ASN or /24 cluster", async () => {
    raw.exec("DELETE FROM threats");
    insertThreats(raw, [
      // One AWS EC2 IP, 4 brands, 12 threats — a real operator's VM.
      ...many(12, (i) => ({ id: `aws_${i}`, ip: "54.80.0.5", asn: "AS14618", brand: `aw${i % 4}`, cc: "US" })),
      // Two more AWS IPs in the same /24 so the /24 lane WOULD qualify.
      ...many(6, (i) => ({ id: `aws2_${i}`, ip: `54.80.0.${6 + (i % 2)}`, asn: "AS14618", brand: `aw${i % 3}`, cc: "US" })),
    ]);
    await runPerIpLane(db);
    await runSubnetLane(db);
    await runAsnLane(db);
    const ids = allIds();
    expect(ids).toContain("cluster_ip_54.80.0.5");
    expect(stampedTo("cluster_ip_54.80.0.5")).toBe(12);
    expect(ids.filter((id) => id.startsWith("cluster_subnet_") || id.startsWith("cluster_asn_"))).toEqual([]);
    // ...and the retire pass leaves the IaaS per-IP row alone.
    const r = await retireNonOperationalLaneClusters(db);
    expect(r.markedSharedInfra).toBe(0);
    expect(cluster("cluster_ip_54.80.0.5")!.status).toBe("active");
  });

  it("per-IP lane: a 3-brand IP on Google's front-end ASN (AS15169) forms no cluster; Amazon's AS16509 likewise", async () => {
    raw.exec("DELETE FROM threats");
    insertThreats(raw, [
      // A Google Sites / Firebase front-end IP: 3 brands, 9 threats — would
      // qualify (>= 3 brands, >= 5 threats) if the ASN were not multi-tenant.
      ...many(9, (i) => ({ id: `gfe_${i}`, ip: "216.239.32.21", asn: "AS15169", brand: `g${i % 3}`, cc: "US" })),
      // A CloudFront / S3-website IP on AS16509, same shape.
      ...many(9, (i) => ({ id: `cfr_${i}`, ip: "52.84.0.5", asn: "16509", brand: `c${i % 3}`, cc: "US" })),
    ]);
    const r = await runPerIpLane(db);
    expect(r.analyzed).toBe(0);
    expect(allIds().filter((id) => id.startsWith("cluster_ip_"))).toEqual([]);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE cluster_id IS NOT NULL").all()[0] as { n: number }).n).toBe(0);
  });

  it("per-IP and /24 lanes exclude bogon IPs in reserved / private ranges (SELECT and stamp)", async () => {
    raw.exec("DELETE FROM threats");
    // " 192.168.7.7" is padded: the SQL tests trim(ip_address), agreeing with
    // the retire pass (which reads the cleaned IP from the cluster id).
    const bogons = ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.5.5", "192.168.1.1", "100.64.0.9", "169.254.9.9", " 192.168.7.7"];
    insertThreats(raw, bogons.flatMap((ip, k) =>
      many(10, (i) => ({ id: `bg_${k}_${i}`, ip, asn: "AS65020", brand: `bg${i % 5}` }))));
    // A /24 of private space: 3 IPs, 3 brands, 9 threats.
    insertThreats(raw, many(9, (i) => ({ id: `bgs_${i}`, ip: `10.9.9.${(i % 3) + 1}`, asn: "AS65020", brand: `bs${i % 3}` })));
    // 172.32/16 is public — must still cluster.
    insertThreats(raw, many(6, (i) => ({ id: `pub_${i}`, ip: "172.32.0.1", asn: "AS65020", brand: `pb${i % 3}` })));
    const ip = await runPerIpLane(db);
    const sn = await runSubnetLane(db);
    expect(ip.analyzed).toBe(1);
    expect(sn.analyzed).toBe(0);
    expect(allIds().filter((id) => id.startsWith("cluster_ip_") || id.startsWith("cluster_subnet_"))).toEqual(["cluster_ip_172.32.0.1"]);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE id LIKE 'bg%' AND cluster_id IS NOT NULL").all()[0] as { n: number }).n).toBe(0);
  });

  it("ASN lane: a group over the hub fan-out is not emitted", async () => {
    raw.exec("DELETE FROM threats");
    insertThreats(raw, [
      ...many(ASN_MAX_BRAND_FANOUT + 5, (i) => ({ id: `wide_${i}`, asn: "AS65030", brand: `wb${i}` })),
      ...many(12, (i) => ({ id: `narrow_${i}`, asn: "AS65031", brand: `nb${i % 3}` })),
    ]);
    const r = await runAsnLane(db);
    expect(r.clusters.map((c) => c.clusterId)).toEqual(["cluster_asn_as65031_phishing"]);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE id LIKE 'wide_%' AND cluster_id IS NOT NULL").all()[0] as { n: number }).n).toBe(0);
  });

  it("ASN lane: an existing row whose brand fan-out grew past the hub threshold is retired, not re-emitted", async () => {
    const brands = JSON.stringify(Array.from({ length: ASN_MAX_BRAND_FANOUT + 1 }, (_, i) => `b${i}`));
    raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, asns, attack_types, brand_ids, status, threat_count)
       VALUES ('cluster_asn_as65032_phishing', 'old', '["AS65032"]', '["phishing"]', ?, 'active', 400)`,
    ).run(brands);
    await runAll();
    expect(cluster("cluster_asn_as65032_phishing")!.retired_reason).toBe("shared_infra");
    expect(cluster("cluster_asn_as65032_phishing")!.status).toBe("active"); // retirement never writes status
    const again = await retireNonOperationalLaneClusters(db);
    expect(again.markedSharedInfra + again.markedSuperseded).toBe(0);
  });

  it("ASN lane skips an empty threat_type (no supersede / reactivate loop)", async () => {
    raw.exec("DELETE FROM threats");
    // The migrated schema's CHECK rejects ''; rows predating it (or written
    // by a rebuilt table) can still carry it, so bypass the CHECK to seed.
    raw.exec("PRAGMA ignore_check_constraints = ON");
    // (threats.threat_type is NOT NULL in the schema, so NULL can't be seeded;
    // the lane's IS NOT NULL guard is defensive.)
    insertThreats(raw, many(12, (i) => ({ id: `et_${i}`, asn: "AS65040", threat_type: "", brand: `e${i % 3}` })));
    const sqlRows = raw.prepare(ASN_LANE_SQL).all(ASN_MAX_BRAND_FANOUT);
    expect(sqlRows).toEqual([]);
    for (let run = 0; run < 2; run++) {
      await runAsnLane(db);
      const r = await retireNonOperationalLaneClusters(db);
      expect(r.markedSuperseded).toBe(0);
    }
    expect(allIds().filter((id) => id.startsWith("cluster_asn_"))).toEqual([]);
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
    ins.run("cluster_subnet_104_21_0", "Subnet 104.21.0.0/24", '["AS13335"]', '["phishing"]', brands(10), "active", 50);
    ins.run("cluster_subnet_10_0_0", "Subnet 10.0.0.0/24", '["AS9999"]', '["phishing"]', brands(10), "active", 50);
    ins.run("cluster_ip_192.168.1.1", "IP 192.168.1.1", '["AS9999"]', '["phishing"]', brands(5), "active", 50);

    await runAll();
    const rr = (id: string) => cluster(id)!.retired_reason;
    expect(rr("cluster_asn_as13335_phishing")).toBe("shared_infra");
    expect(rr("cluster_asn_as4134_scanning")).toBe("shared_infra");
    expect(rr("cluster_asn_as13335_cloudflare_inc_phishing")).toBe("superseded");
    expect(rr("cluster_ip_13.248.169.48")).toBe("shared_infra");
    expect(rr("cluster_subnet_104_21_0")).toBe("shared_infra");
    expect(rr("cluster_subnet_10_0_0")).toBe("shared_infra");
    expect(rr("cluster_ip_192.168.1.1")).toBe("shared_infra");
    expect(rr("cluster_subnet_74_115_51")).toBeNull(); // the lane's own row is never retired
    expect(rr("cluster_asn_as4837_malware_distribution")).toBeNull();
    // Retirement leaves status alone (prod CHECK: active / dormant / disrupted).
    expect(cluster("cluster_asn_as4134_scanning")!.status).toBe("dormant");
    expect(cluster("cluster_asn_as13335_phishing")!.status).toBe("active");
    expect(cluster("cluster_asn_as4837_malware_distribution")!.threat_count).toBe(12); // refreshed by the lane

    const again = await retireNonOperationalLaneClusters(db);
    expect(again.markedSharedInfra + again.markedSuperseded).toBe(0);
  });

  it("a shared_infra per-IP row that qualifies again is reactivated by the lane", async () => {
    raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, asns, brand_ids, status, retired_reason, threat_count)
       VALUES ('cluster_ip_203.0.113.7', 'old', '[]', '[]', 'active', 'shared_infra', 0)`,
    ).run();
    await runPerIpLane(db);
    expect(cluster("cluster_ip_203.0.113.7")!.retired_reason).toBeNull();
    expect(cluster("cluster_ip_203.0.113.7")!.status).toBe("active");
    // ...and the retire pass leaves it alone (no retire / reactivate loop).
    const r = await retireNonOperationalLaneClusters(db);
    expect(r.markedSharedInfra + r.markedSuperseded).toBe(0);
  });

  it("a shared_infra ASN row that qualifies again is reactivated by the ASN lane (status still owned by the lane)", async () => {
    raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, asns, attack_types, brand_ids, status, retired_reason, threat_count)
       VALUES ('cluster_asn_as4837_malware_distribution', 'old', '["AS4837"]', '["malware_distribution"]', '[]', 'dormant', 'shared_infra', 0)`,
    ).run();
    await runAll();
    const c = cluster("cluster_asn_as4837_malware_distribution")!;
    expect(c.retired_reason).toBeNull();
    expect(["active", "dormant"]).toContain(c.status);
    expect(c.threat_count).toBe(12);
  });

  it("a lane upsert never clears 'superseded' (per-IP and ASN paths)", async () => {
    const ins = raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, asns, attack_types, brand_ids, status, retired_reason, threat_count)
       VALUES (?, 'old', ?, ?, '[]', 'active', 'superseded', 0)`,
    );
    ins.run("cluster_ip_203.0.113.7", "[]", '["phishing"]');
    ins.run("cluster_asn_as4837_malware_distribution", '["AS4837"]', '["malware_distribution"]');
    await runPerIpLane(db);
    await runAsnLane(db);
    expect(cluster("cluster_ip_203.0.113.7")!.retired_reason).toBe("superseded");
    expect(cluster("cluster_asn_as4837_malware_distribution")!.retired_reason).toBe("superseded");
  });

  it("every status a lane writes satisfies the prod CHECK (the migrated schema enforces it)", async () => {
    await runAll();
    const bad = raw.prepare(
      "SELECT id, status FROM infrastructure_clusters WHERE status NOT IN ('active', 'dormant', 'disrupted')",
    ).all();
    expect(bad).toEqual([]);
  });

  it("a full run produces exactly the expected operations", async () => {
    await runAll();
    const ops = (raw.prepare(
      `SELECT id FROM infrastructure_clusters WHERE retired_reason IS NULL ORDER BY id`,
    ).all() as Array<{ id: string }>).map((r) => r.id);
    expect(ops).toEqual([
      "cluster_asn_as4837_malware_distribution",
      "cluster_cert_0a1b2c3d4e5f60718293",
      "cluster_ip_203.0.113.7",
      "cluster_subnet_74_115_51",
    ]);
  });
});
