// Observatory Phase B (B4) — lens endpoints.
//
// Pure helpers are unit-tested directly; every handler runs against a real
// SQLite DB whose schema is DERIVED from migrations/ (so a phantom column is
// a "no such column" failure, not a silent accommodation). Query plans are
// pinned in observatory-lens-plans.test.ts against the FULLY migrated schema
// (every index), at realistic scale.

import { describe, it, expect } from "vitest";
import {
  parseLensPeriod,
  parseJsonStringArray,
  normalizeAsn,
  normalizeCountry,
  aliasList,
  buildComponents,
  unresolvedCertReps,
  classifyOperation,
  selectOperations,
  compareOperations,
  OPERATIONS_GEO_SCAN_CAP,
  parsePivotRow,
  computeOverindex,
  bucketTimeline,
  timelineStartMs,
  TIMELINE_SPECS,
  LENS_TTL_S,
  handleObservatoryOperationsGeo,
  handleObservatoryMovements,
  handleObservatoryProvidersGeo,
  handleObservatoryOverindex,
  handleObservatoryCampaignsGeo,
  handleObservatoryTimeline,
  handleObservatoryActors,
  type OperationGeo,
} from "../src/handlers/observatoryLenses";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import type { Env } from "../src/types";
import { asnKey, isSharedInfraAsn, SHARED_INFRA_ASNS } from "../src/lib/shared-infra-asns";
import { DEFAULT_HUB_FANOUT_THRESHOLD } from "../src/lib/cluster-components";

// ─── Harness ─────────────────────────────────────────────────────────

interface KvEntry { value: string; ttl?: number }
function kvStore() {
  const store = new Map<string, KvEntry>();
  return {
    store,
    get: async (k: string) => store.get(k)?.value ?? null,
    put: async (k: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(k, { value, ttl: opts?.expirationTtl });
    },
    delete: async (k: string) => { store.delete(k); },
  };
}

function makeEnv(raw: SqliteDb) {
  const log: StatementLogEntry[] = [];
  const db = d1FromSqlite(raw, { log });
  const withSession = () => ({ prepare: db.prepare.bind(db), getBookmark: () => null });
  const kv = kvStore();
  const env = { DB: { ...db, prepare: db.prepare, batch: db.batch, withSession }, CACHE: kv } as unknown as Env;
  return { env, kv, log };
}

const req = (path: string) => new Request(`https://averrow.com${path}`);

interface Envelope<T> { success: boolean; data: T; meta: { generated_at: string; period?: string; [k: string]: unknown }; error?: string }
async function body<T>(res: Response): Promise<Envelope<T>> {
  return (await res.json()) as Envelope<T>;
}

const lensKeys = (kv: ReturnType<typeof kvStore>) => [...kv.store.keys()].filter((k) => k.startsWith("cv:observatory_lens."));

function hourAgo(h: number): string {
  const d = new Date(Date.now() - h * 3_600_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace("T", " ").slice(0, 19);
}
function secondsAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
}

const TABLES = [
  "infrastructure_clusters", "threat_actors", "agent_events", "hosting_providers",
  "threat_cube_geo", "threat_cube_status", "radar_country_snapshots",
  "geopolitical_campaigns", "threat_actor_infrastructure", "threat_attributions",
  "takedown_outcome_daily",
];

function cluster(raw: SqliteDb, c: {
  id: string; name?: string; status?: string; threat_count: number; countries?: string | null; asns?: string | null;
  component_id?: string | null; actor_id?: string | null; agent_notes?: string | null; confidence?: number;
  last_movement_pivot_at?: string | null; brand_ids?: string | null; attack_types?: string | null;
}) {
  raw.prepare(`INSERT INTO infrastructure_clusters
    (id, cluster_name, status, threat_count, countries, asns, component_id, actor_id, agent_notes, confidence_score, last_movement_pivot_at,
     brand_ids, attack_types)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    c.id, c.name ?? `${c.id} name`, c.status ?? "active", c.threat_count,
    c.countries === undefined ? "[]" : c.countries, c.asns === undefined ? "[]" : c.asns,
    c.component_id ?? null, c.actor_id ?? null, c.agent_notes ?? null, c.confidence ?? 50, c.last_movement_pivot_at ?? null,
    c.brand_ids === undefined ? "[]" : c.brand_ids, c.attack_types === undefined ? "[]" : c.attack_types);
}
function actor(raw: SqliteDb, id: string, name: string, aliases: string | null = null) {
  raw.prepare(`INSERT INTO threat_actors (id, name, aliases, country_code) VALUES (?, ?, ?, 'ir')`).run(id, name, aliases);
}
function provider(raw: SqliteDb, p: { id: string; asn: string; country: string | null; active: number; bp?: number }) {
  raw.prepare(`INSERT INTO hosting_providers (id, name, asn, country, active_threat_count, total_threat_count, trend_7d, trend_30d, is_bulletproof, reputation_score)
    VALUES (?, ?, ?, ?, ?, ?, 1, 2, ?, 40)`).run(p.id, `${p.id} Inc`, p.asn, p.country, p.active, p.active * 2, p.bp ?? 0);
}
function pivot(raw: SqliteDb, id: string, createdAt: string, payload: unknown, eventType = "pivot_detected") {
  raw.prepare(`INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, created_at)
    VALUES (?, ?, 'nexus', 'observer', ?, ?)`).run(id, eventType, typeof payload === "string" ? payload : JSON.stringify(payload), createdAt);
}
function geo(raw: SqliteDb, r: { hour?: string; cc: string; sev: string; feed?: string; n: number }) {
  raw.prepare(`INSERT INTO threat_cube_geo (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed, threat_count)
    VALUES (?, 1, 1, ?, 'phishing', ?, ?, ?)`).run(r.hour ?? hourAgo(2), r.cc, r.sev, r.feed ?? "phishtank", r.n);
}
function statusCube(raw: SqliteDb, r: { hour: string; sev: string; status?: string; feed?: string; n: number }) {
  raw.prepare(`INSERT INTO threat_cube_status (hour_bucket, threat_type, severity, source_feed, status, threat_count)
    VALUES (?, 'phishing', ?, ?, ?, ?)`).run(r.hour, r.sev, r.feed ?? "phishtank", r.status ?? "active", r.n);
}

// ─── Pure helpers ────────────────────────────────────────────────────

describe("parseLensPeriod (strict)", () => {
  it("absent / empty → default; allow-listed → itself; garbage → null (400)", () => {
    expect(parseLensPeriod(null)).toBe("7d");
    expect(parseLensPeriod("")).toBe("7d");
    for (const p of ["24h", "7d", "30d", "90d"]) expect(parseLensPeriod(p)).toBe(p);
    for (const p of ["all", "7D", "365d", "x"]) expect(parseLensPeriod(p)).toBeNull();
    expect(parseLensPeriod("24h", ["7d", "30d"])).toBeNull();
    expect(parseLensPeriod("30d", ["7d", "30d"])).toBe("30d");
  });
});

describe("JSON / code normalisers", () => {
  it("parseJsonStringArray: malformed → [], non-strings skipped, deduped, capped", () => {
    expect(parseJsonStringArray(null)).toEqual([]);
    expect(parseJsonStringArray("not json")).toEqual([]);
    expect(parseJsonStringArray('{"a":1}')).toEqual([]);
    expect(parseJsonStringArray('["a", 1, null, "a", " b "]')).toEqual(["a", "b"]);
    const many = JSON.stringify(Array.from({ length: 50 }, (_, i) => `x${i}`));
    expect(parseJsonStringArray(many)).toHaveLength(20);
  });
  it("normalizeAsn / normalizeCountry", () => {
    expect(normalizeAsn("as13335")).toBe("AS13335");
    expect(normalizeAsn("13335")).toBe("AS13335");
    expect(normalizeAsn("AS-x")).toBeNull();
    expect(normalizeCountry("us")).toBe("US");
    expect(normalizeCountry("XX")).toBeNull();
    expect(normalizeCountry("USA")).toBeNull();
  });
  it("aliasList: JSON array or comma text", () => {
    expect(aliasList('["APT35","Charming Kitten"]')).toEqual(["APT35", "Charming Kitten"]);
    expect(aliasList("APT35, Charming Kitten")).toEqual(["APT35", "Charming Kitten"]);
    expect(aliasList(null)).toEqual([]);
  });
});

function op(over: Partial<OperationGeo> & { id: string }): OperationGeo {
  return {
    name: null, component_id: null, kind: "other", evidence_tier: "residue", brand_fanout: 0,
    shared_infra: false, hub: false, ip_reputation: false, status: "active", confidence_score: 50, threat_count: 1,
    actor: null, countries: [], asns: [], last_seen: null, last_movement_pivot_at: null, ...over,
  };
}

describe("buildComponents", () => {
  it("star from the representative bridge cluster; kind = its bridge kind; shared_asns computed", () => {
    const comps = buildComponents([
      op({ id: "cluster_asn_as1_phishing", kind: "asn", component_id: "component_cluster_ip_1.2.3.4", asns: ["AS1"], countries: ["US"] }),
      op({ id: "cluster_ip_1.2.3.4", kind: "per_ip", component_id: "component_cluster_ip_1.2.3.4", asns: ["AS1", "AS2"], countries: ["DE"] }),
      op({ id: "cluster_cert_abc", kind: "cert_serial", component_id: "component_cluster_ip_1.2.3.4", asns: ["AS3"], countries: ["US"] }),
      op({ id: "lonely", component_id: null }),
    ]);
    expect(comps).toHaveLength(1);
    expect(comps[0]).toEqual({
      component_id: "component_cluster_ip_1.2.3.4",
      operation_ids: ["cluster_asn_as1_phishing", "cluster_ip_1.2.3.4", "cluster_cert_abc"],
      countries: ["US", "DE"],
      edges: [
        { a: "cluster_ip_1.2.3.4", b: "cluster_asn_as1_phishing", kind: "per_ip", shared_asns: ["AS1"] },
        { a: "cluster_ip_1.2.3.4", b: "cluster_cert_abc", kind: "per_ip", shared_asns: [] },
      ],
    });
  });
  it("representative not returned → first bridge member is the hub; lone member → no edges", () => {
    const comps = buildComponents([
      op({ id: "cluster_asn_as9_x", kind: "asn", component_id: "component_cluster_cert_zzz" }),
      op({ id: "cluster_cert_san1", kind: "cert_san", component_id: "component_cluster_cert_zzz" }),
      op({ id: "cluster_asn_as7_y", kind: "asn", component_id: "component_cluster_ip_9.9.9.9" }),
    ]);
    const a = comps.find((c) => c.component_id === "component_cluster_cert_zzz")!;
    expect(a.edges).toEqual([{ a: "cluster_cert_san1", b: "cluster_asn_as9_x", kind: "cert_san", shared_asns: [] }]);
    const b = comps.find((c) => c.component_id === "component_cluster_ip_9.9.9.9")!;
    expect(b.edges).toEqual([]);
  });
  it("no bridge member returned: kind from the representative — resolved cert kind, per_ip from the id, else null (never a guessed cert_serial)", () => {
    const members = (cid: string) => [
      op({ id: "cluster_asn_as1_a", kind: "asn", component_id: cid }),
      op({ id: "cluster_asn_as2_b", kind: "asn", component_id: cid }),
    ];
    const unresolved = buildComponents(members("component_cluster_cert_rep"));
    expect(unresolved[0]!.edges.map((e) => e.kind)).toEqual([null]);
    const resolved = buildComponents(members("component_cluster_cert_rep"), new Map([["cluster_cert_rep", "cert_san" as const]]));
    expect(resolved[0]!.edges.map((e) => e.kind)).toEqual(["cert_san"]);
    const ip = buildComponents(members("component_cluster_ip_8.8.8.8"));
    expect(ip[0]!.edges.map((e) => e.kind)).toEqual(["per_ip"]);
    expect(unresolvedCertReps([...members("component_cluster_cert_rep"), ...members("component_cluster_ip_8.8.8.8")]))
      .toEqual(["cluster_cert_rep"]);
    // A returned bridge member or a lone member → nothing to resolve.
    expect(unresolvedCertReps([op({ id: "cluster_cert_x", kind: "cert_serial", component_id: "component_cluster_cert_rep" }),
      op({ id: "cluster_asn_as1_a", kind: "asn", component_id: "component_cluster_cert_rep" })])).toEqual([]);
    expect(unresolvedCertReps([op({ id: "cluster_asn_as1_a", kind: "asn", component_id: "component_cluster_cert_rep" })])).toEqual([]);
  });
});

describe("shared-infra ASNs", () => {
  it("asnKey normalises every stored ASN form; isSharedInfraAsn reads through it", () => {
    expect(asnKey("AS13335")).toBe("AS13335");
    expect(asnKey("as13335")).toBe("AS13335");
    expect(asnKey("13335")).toBe("AS13335");
    expect(asnKey(13335)).toBe("AS13335");
    expect(asnKey("AS13335 Cloudflare, Inc.")).toBe("AS13335");
    expect(asnKey("  AS16509 Amazon.com")).toBe("AS16509");
    expect(asnKey("AS133350")).toBe("AS133350");
    expect(asnKey("Cloudflare AS13335")).toBeNull();
    expect(asnKey("")).toBeNull();
    expect(asnKey(null)).toBeNull();
    expect(asnKey({})).toBeNull();
    expect(isSharedInfraAsn("AS13335 Cloudflare, Inc.")).toBe(true);
    expect(isSharedInfraAsn("AS133350")).toBe(false);
    expect(isSharedInfraAsn("AS9009")).toBe(false);
    expect(SHARED_INFRA_ASNS.size).toBe(19);
    for (const k of SHARED_INFRA_ASNS) expect(asnKey(k)).toBe(k);
  });
});

describe("classifyOperation", () => {
  const base = { cluster_type: null, threat_count: 50, brand_fanout: 3, primary_asn: null, primary_type: null };
  it("evidence tiers: cert → ip → subnet → registrar → asn → residue", () => {
    expect(classifyOperation({ ...base, id: "cluster_cert_x", cluster_type: "ssl_san_hash" })).toMatchObject({ kind: "cert_san", evidence_tier: "cert" });
    expect(classifyOperation({ ...base, id: "cluster_cert_y", cluster_type: "ssl_cert_serial" })).toMatchObject({ kind: "cert_serial", evidence_tier: "cert" });
    expect(classifyOperation({ ...base, id: "cluster_ip_1.2.3.4" })).toMatchObject({ kind: "per_ip", evidence_tier: "ip" });
    expect(classifyOperation({ ...base, id: "cluster_subnet_1_2_3" })).toMatchObject({ kind: "subnet", evidence_tier: "subnet" });
    expect(classifyOperation({ ...base, id: "cluster_registrar_namecheap" })).toMatchObject({ kind: "registrar", evidence_tier: "registrar" });
    expect(classifyOperation({ ...base, id: "cluster_asn_as9_phishing" })).toMatchObject({ kind: "asn", evidence_tier: "asn" });
    for (const id of ["cluster_dev_x", "cluster_actor_y", "0b9c5e1e-legacy"]) {
      expect(classifyOperation({ ...base, id }).evidence_tier).toBe("residue");
    }
  });
  it("cert / per-IP below 10 threats drop to residue; subnet/registrar/asn don't", () => {
    expect(classifyOperation({ ...base, id: "cluster_cert_x", threat_count: 9 }).evidence_tier).toBe("residue");
    expect(classifyOperation({ ...base, id: "cluster_cert_x", threat_count: 10 }).evidence_tier).toBe("cert");
    expect(classifyOperation({ ...base, id: "cluster_ip_1.1.1.1", threat_count: 9 }).evidence_tier).toBe("residue");
    expect(classifyOperation({ ...base, id: "cluster_ip_1.1.1.1", threat_count: 10 }).evidence_tier).toBe("ip");
    expect(classifyOperation({ ...base, id: "cluster_subnet_a", threat_count: 1 }).evidence_tier).toBe("subnet");
    expect(classifyOperation({ ...base, id: "cluster_asn_a_b", threat_count: 1 }).evidence_tier).toBe("asn");
  });
  it("shared_infra only for ASN-kind rows on a shared network (org-suffixed form too)", () => {
    expect(classifyOperation({ ...base, id: "cluster_asn_as13335_x", primary_asn: "AS13335 Cloudflare, Inc." }).shared_infra).toBe(true);
    expect(classifyOperation({ ...base, id: "cluster_asn_as9_x", primary_asn: "AS9" }).shared_infra).toBe(false);
    // Specific evidence on Cloudflare is still operator evidence.
    expect(classifyOperation({ ...base, id: "cluster_ip_1.1.1.1", primary_asn: "AS13335" }).shared_infra).toBe(false);
    expect(classifyOperation({ ...base, id: "cluster_subnet_a", primary_asn: "AS13335" }).shared_infra).toBe(false);
  });
  it("hub = per-IP above the 150-brand fan-out threshold", () => {
    expect(classifyOperation({ ...base, id: "cluster_ip_9.9.9.9", brand_fanout: DEFAULT_HUB_FANOUT_THRESHOLD }).hub).toBe(false);
    expect(classifyOperation({ ...base, id: "cluster_ip_9.9.9.9", brand_fanout: DEFAULT_HUB_FANOUT_THRESHOLD + 1 }).hub).toBe(true);
    expect(classifyOperation({ ...base, id: "cluster_cert_x", brand_fanout: 999 }).hub).toBe(false);
  });
  it("ip_reputation = ASN rows whose primary type is scanning / malicious_ip", () => {
    expect(classifyOperation({ ...base, id: "cluster_asn_a_s", primary_type: "scanning" }).ip_reputation).toBe(true);
    expect(classifyOperation({ ...base, id: "cluster_asn_a_m", primary_type: " Malicious_IP " }).ip_reputation).toBe(true);
    expect(classifyOperation({ ...base, id: "cluster_asn_a_p", primary_type: "phishing" }).ip_reputation).toBe(false);
    expect(classifyOperation({ ...base, id: "cluster_ip_1.1.1.1", primary_type: "scanning" }).ip_reputation).toBe(false);
  });
});

describe("selectOperations", () => {
  const ops = [
    op({ id: "cluster_asn_cf", kind: "asn", evidence_tier: "asn", threat_count: 9000, shared_infra: true }),
    op({ id: "cluster_asn_cf_scan", kind: "asn", evidence_tier: "asn", threat_count: 8000, shared_infra: true, ip_reputation: true }),
    op({ id: "cluster_ip_hub", kind: "per_ip", evidence_tier: "ip", threat_count: 7000, hub: true }),
    op({ id: "cluster_asn_scan", kind: "asn", evidence_tier: "asn", threat_count: 6000, ip_reputation: true }),
    op({ id: "cluster_asn_b", kind: "asn", evidence_tier: "asn", threat_count: 500 }),
    op({ id: "cluster_asn_a", kind: "asn", evidence_tier: "asn", threat_count: 500 }),
    op({ id: "cluster_subnet_x", kind: "subnet", evidence_tier: "subnet", threat_count: 20 }),
    op({ id: "cluster_cert_x", kind: "cert_san", evidence_tier: "cert", threat_count: 12 }),
    op({ id: "cluster_ip_small", kind: "per_ip", evidence_tier: "residue", threat_count: 3 }),
  ];
  it("default: excludes shared/hub/ip-reputation (each counted once), ranks tier → threat_count DESC → id, limit after filter", () => {
    const r = selectOperations(ops, { includeShared: false, limit: 3 });
    expect(r.operations.map((o) => o.id)).toEqual(["cluster_cert_x", "cluster_subnet_x", "cluster_asn_a"]);
    expect(r.excluded).toEqual({ shared_asn: 2, hub_ip: 1, ip_reputation: 1 });
    expect(selectOperations(ops, { includeShared: false, limit: 50 }).operations.map((o) => o.id)).toEqual([
      "cluster_cert_x", "cluster_subnet_x", "cluster_asn_a", "cluster_asn_b", "cluster_ip_small",
    ]);
  });
  it("include_shared = the normal top-N PLUS every excluded row (threat_count DESC), counts reconcile", () => {
    const r = selectOperations(ops, { includeShared: true, limit: 3 });
    expect(r.excluded).toEqual({ shared_asn: 2, hub_ip: 1, ip_reputation: 1 });
    expect(r.shared_returned).toBe(4);
    expect(r.operations.map((o) => o.id)).toEqual([
      "cluster_cert_x", "cluster_subnet_x", "cluster_asn_a",
      "cluster_asn_cf", "cluster_asn_cf_scan", "cluster_ip_hub", "cluster_asn_scan",
    ]);
    // Same top-N as the default response, so the toggle only ADDS rows.
    expect(r.operations.slice(0, 3)).toEqual(selectOperations(ops, { includeShared: false, limit: 3 }).operations);
    expect(selectOperations(ops, { includeShared: false, limit: 3 }).shared_returned).toBe(0);
    expect(compareOperations(ops[5]!, ops[4]!)).toBeLessThan(0);
  });
  it("the shared cap bounds what Show reveals; excluded still counts the whole population", () => {
    const r = selectOperations(ops, { includeShared: true, limit: 3, sharedCap: 2 });
    expect(r.shared_returned).toBe(2);
    expect(r.operations.slice(3).map((o) => o.id)).toEqual(["cluster_asn_cf", "cluster_asn_cf_scan"]);
    expect(r.excluded).toEqual({ shared_asn: 2, hub_ip: 1, ip_reputation: 1 });
  });
});

describe("parsePivotRow", () => {
  it("v2 infra_movement: from = prev_asn_list, to = new_asn_list, counts", () => {
    const m = parsePivotRow({ id: "e1", created_at: "2026-10-14 00:00:00", payload_json: JSON.stringify({
      kind: "infra_movement", cluster_id: "cluster_ip_1", cluster_name: "Op", new_asns: 2, new_ips: 5, new_serials: 0,
      new_asn_list: ["AS2", "as3"], prev_asn_list: ["AS1"], payload_v: 2 }) });
    expect(m).toMatchObject({ kind: "infra_movement", fromAsns: ["AS1"], toAsns: ["AS2", "AS3"], payload_v: 2,
      counts: { new_asns: 2, new_ips: 5, new_serials: 0 }, cluster_name: "Op" });
  });
  it("v2 dormancy: from = [prev_asn], to = []", () => {
    const m = parsePivotRow({ id: "e2", created_at: "x", payload_json: JSON.stringify({ kind: "dormancy", cluster_id: "c", asn: "AS8560", prev_asn: "AS8560", payload_v: 2 }) });
    expect(m).toMatchObject({ kind: "dormancy", fromAsns: ["AS8560"], toAsns: [], counts: { new_asns: 0, new_ips: 0, new_serials: 0 } });
  });
  it("v1 rows: dormancy from = [asn]; infra_movement from/to empty (counts from v1 keys); malformed payload → dormancy shell", () => {
    expect(parsePivotRow({ id: "e3", created_at: "x", payload_json: JSON.stringify({ kind: "dormancy", cluster_id: "c", asn: "AS1" }) }))
      .toMatchObject({ payload_v: 1, fromAsns: ["AS1"], toAsns: [] });
    expect(parsePivotRow({ id: "e4", created_at: "x", payload_json: JSON.stringify({ kind: "infra_movement", cluster_id: "c", new_ips: 4 }) }))
      .toMatchObject({ payload_v: 1, fromAsns: [], toAsns: [], counts: { new_asns: 0, new_ips: 4, new_serials: 0 } });
    expect(parsePivotRow({ id: "e5", created_at: "x", payload_json: "{oops" })).toMatchObject({ kind: "dormancy", cluster_id: null, payload_v: 1 });
  });
});

describe("computeOverindex", () => {
  it("shares are fractions, XX excluded, ratio null without a radar share", () => {
    const rows = computeOverindex(
      [{ country_code: "US", n: 60 }, { country_code: "CN", n: 40 }, { country_code: "XX", n: 900 }],
      [{ country_code: "US", value_pct: 30 }, { country_code: "CN", value_pct: 0 }, { country_code: "DE", value_pct: 10 }],
    );
    expect(rows).toEqual([
      { country_code: "US", our_count: 60, our_share: 0.6, radar_share: 0.3, ratio: 2 },
      { country_code: "CN", our_count: 40, our_share: 0.4, radar_share: 0, ratio: null },
      { country_code: "DE", our_count: 0, our_share: 0, radar_share: 0.1, ratio: 0 },
    ]);
    expect(computeOverindex([{ country_code: "FR", n: 1 }], [])[0]).toMatchObject({ radar_share: null, ratio: null, our_share: 1 });
  });
});

describe("timeline bucketing", () => {
  it("point counts per period stay ≤ 360 and match the spec", () => {
    expect(TIMELINE_SPECS["24h"]).toMatchObject({ bucket: "1h", points: 24 });
    expect(TIMELINE_SPECS["7d"]).toMatchObject({ bucket: "1h", points: 168 });
    expect(TIMELINE_SPECS["30d"]).toMatchObject({ bucket: "6h", points: 120 });
    expect(TIMELINE_SPECS["90d"]).toMatchObject({ bucket: "1d", points: 90 });
  });
  it("buckets align to UTC boundaries; last bucket holds the current hour", () => {
    const now = new Date("2026-10-14T13:47:00Z");
    expect(new Date(timelineStartMs(TIMELINE_SPECS["24h"], now)).toISOString()).toBe("2026-10-13T14:00:00.000Z");
    expect(new Date(timelineStartMs(TIMELINE_SPECS["30d"], now)).toISOString()).toBe("2026-09-14T18:00:00.000Z");
    expect(new Date(timelineStartMs(TIMELINE_SPECS["90d"], now)).toISOString()).toBe("2026-07-17T00:00:00.000Z");
  });
  it("zero-fills, folds hours into 6h buckets, drops out-of-window rows", () => {
    const spec = TIMELINE_SPECS["30d"];
    const start = Date.parse("2026-09-14T18:00:00Z");
    const pts = bucketTimeline([
      { hour_bucket: "2026-09-14 18:00:00", total: 3, critical: 1, high: 2, medium: 0, low: 0 },
      { hour_bucket: "2026-09-14 23:00:00", total: 4, critical: 0, high: 0, medium: 4, low: 0 },
      { hour_bucket: "2026-09-15 00:00:00", total: 1, critical: 0, high: 0, medium: 0, low: 1 },
      { hour_bucket: "2026-09-14 17:00:00", total: 99, critical: 99, high: 0, medium: 0, low: 0 },
    ], spec, start);
    expect(pts).toHaveLength(120);
    expect(pts[0]).toEqual({ t: "2026-09-14T18:00:00.000Z", total: 7, critical: 1, high: 2, medium: 4, low: 0 });
    expect(pts[1]).toMatchObject({ t: "2026-09-15T00:00:00.000Z", total: 1, low: 1 });
    expect(pts[119]).toMatchObject({ total: 0 });
  });
});

// ─── Handlers against real SQLite ────────────────────────────────────

describe.skipIf(!hasSqlite())("lens handlers — real SQLite", () => {
  it("operations-geo: top-N by threat_count, actor join, arrays capped/parsed safely, components + 400 + keyed", async () => {
    const raw = openDerivedDb(TABLES);
    actor(raw, "ta_1", "Charming Kitten");
    const manyCountries = JSON.stringify(["US", "DE", "XX", "zz", ...Array.from({ length: 30 }, (_, i) => String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)))]);
    cluster(raw, { id: "cluster_ip_1.2.3.4", threat_count: 50, component_id: "component_cluster_ip_1.2.3.4", asns: '["AS1","AS2"]', countries: manyCountries, actor_id: "ta_1", last_movement_pivot_at: "2026-10-13 10:00:00" });
    cluster(raw, { id: "cluster_cert_s1", threat_count: 40, component_id: "component_cluster_ip_1.2.3.4", asns: '["AS2"]', countries: '["FR"]', agent_notes: '{"cluster_type":"ssl_san_hash","ssl_san_hash":"h"}' });
    cluster(raw, { id: "cluster_asn_as9_x", threat_count: 30, asns: "not json", countries: null });
    cluster(raw, { id: "cluster_subnet_dormant", threat_count: 99, status: "dormant" });
    cluster(raw, { id: "cluster_ip_5.5.5.5", threat_count: 1, agent_notes: "plain text note" });
    const { env, kv, log } = makeEnv(raw);

    const res = await handleObservatoryOperationsGeo(req("/api/observatory/operations-geo?limit=3"), env);
    expect(res.status).toBe(200);
    const b = await body<{ operations: OperationGeo[]; components: Array<{ component_id: string; edges: unknown[] }> }>(res);
    expect(b.success).toBe(true);
    expect(typeof b.meta.generated_at).toBe("string");
    // Ranked by evidence tier first: cert (40) outranks per-IP (50).
    expect(b.data.operations.map((o) => o.id)).toEqual(["cluster_cert_s1", "cluster_ip_1.2.3.4", "cluster_asn_as9_x"]);
    const top = b.data.operations[1]!;
    expect(top).toMatchObject({ kind: "per_ip", evidence_tier: "ip", actor: { id: "ta_1", name: "Charming Kitten" }, asns: ["AS1", "AS2"], last_movement_pivot_at: "2026-10-13 10:00:00", threat_count: 50 });
    expect(top.countries).toHaveLength(20);
    expect(top.countries).not.toContain("XX");
    expect(b.data.operations[0]).toMatchObject({ kind: "cert_san", evidence_tier: "cert", actor: null });
    expect(b.data.operations[2]).toMatchObject({ kind: "asn", evidence_tier: "asn", asns: [], countries: [] });
    expect(b.data.components).toEqual([{
      component_id: "component_cluster_ip_1.2.3.4",
      operation_ids: ["cluster_cert_s1", "cluster_ip_1.2.3.4"],
      countries: expect.any(Array),
      edges: [{ a: "cluster_ip_1.2.3.4", b: "cluster_cert_s1", kind: "per_ip", shared_asns: ["AS2"] }],
    }]);
    expect(log.every((l) => !l.error)).toBe(true);
    expect(lensKeys(kv)).toEqual(["cv:observatory_lens.operations_geo.v3:active:3:s0"]);

    const all = await body<{ operations: OperationGeo[] }>(await handleObservatoryOperationsGeo(req("/api/observatory/operations-geo?status=all&limit=999"), env));
    expect(all.data.operations.map((o) => o.id)).toEqual([
      "cluster_cert_s1", "cluster_ip_1.2.3.4", "cluster_subnet_dormant", "cluster_asn_as9_x",
      "cluster_ip_5.5.5.5", // per-IP with < 10 threats → residue tier
    ]);
    expect(lensKeys(kv)).toContain("cv:observatory_lens.operations_geo.v3:all:50:s0");

    const bad = await handleObservatoryOperationsGeo(req("/api/observatory/operations-geo?status=dormant"), env);
    expect(bad.status).toBe(400);
    expect(lensKeys(kv)).toHaveLength(2);
  });

  it("operations-geo: a SAN representative outside the returned set is resolved by PK (cert_san, not cert_serial); unreadable → null", async () => {
    const raw = openDerivedDb(TABLES);
    // Reps (low threat_count) are NOT returned; the returned members are non-bridge.
    cluster(raw, { id: "cluster_cert_rep_san", threat_count: 1, component_id: "component_cluster_cert_rep_san", agent_notes: '{"cluster_type":"ssl_san_hash"}' });
    cluster(raw, { id: "cluster_asn_as1_a", threat_count: 90, component_id: "component_cluster_cert_rep_san" });
    cluster(raw, { id: "cluster_asn_as2_b", threat_count: 80, component_id: "component_cluster_cert_rep_san" });
    cluster(raw, { id: "cluster_cert_rep_bad", threat_count: 2, component_id: "component_cluster_cert_rep_bad", agent_notes: "not json" });
    cluster(raw, { id: "cluster_asn_as3_c", threat_count: 70, component_id: "component_cluster_cert_rep_bad" });
    cluster(raw, { id: "cluster_asn_as4_d", threat_count: 60, component_id: "component_cluster_cert_rep_bad" });
    const { env, log } = makeEnv(raw);
    const b = await body<{ components: Array<{ component_id: string; edges: Array<{ kind: unknown }> }> }>(
      await handleObservatoryOperationsGeo(req("/api/observatory/operations-geo?limit=4"), env));
    const kinds = Object.fromEntries(b.data.components.map((c) => [c.component_id, c.edges.map((e) => e.kind)]));
    expect(kinds).toEqual({ component_cluster_cert_rep_san: ["cert_san"], component_cluster_cert_rep_bad: [null] });
    const lookups = log.filter((l) => /FROM infrastructure_clusters\s+WHERE id IN/.test(l.sql));
    expect(lookups).toHaveLength(1);
    expect((lookups[0]!.sql.match(/\?/g) ?? []).length).toBe(2);
  });

  it("operations-geo: stable-id population only, default exclusions + meta counts, include_shared, tier ranking, 400", async () => {
    const raw = openDerivedDb(TABLES);
    // Legacy random-UUID copies with huge frozen counts — must never surface.
    for (let i = 0; i < 40; i++) {
      cluster(raw, { id: `${(i + 10).toString(16).padStart(8, "0")}-6d1c-4c1a-9a55-0f1e2d3c4b5a`, threat_count: 100_000 - i,
        asns: '["AS13335"]', attack_types: '["malware_distribution"]', status: i % 5 === 0 ? "dormant" : "active" });
    }
    cluster(raw, { id: "Cluster_upper_not_stable", threat_count: 99_999 });
    cluster(raw, { id: "cluster`after_range", threat_count: 99_999 });
    // Stable rows.
    cluster(raw, { id: "cluster_asn_as13335_malware_distribution", threat_count: 5000, asns: '["AS13335 Cloudflare, Inc."]', attack_types: '["malware_distribution"]' });
    cluster(raw, { id: "cluster_asn_as16509_phishing", threat_count: 4000, asns: '["AS16509"]', attack_types: '["phishing"]' });
    cluster(raw, { id: "cluster_asn_as9009_scanning", threat_count: 3000, asns: '["AS9009"]', attack_types: '["scanning"]' });
    cluster(raw, { id: "cluster_asn_as9009_phishing", threat_count: 900, asns: '["AS9009"]', attack_types: '["phishing"]' });
    cluster(raw, { id: "cluster_ip_6.6.6.6", threat_count: 2500, brand_ids: JSON.stringify(Array.from({ length: 151 }, (_, i) => `b${i}`)) });
    cluster(raw, { id: "cluster_ip_7.7.7.7", threat_count: 30, brand_ids: '["b1","b2"]', component_id: "component_cluster_cert_san1" });
    cluster(raw, { id: "cluster_cert_san1", threat_count: 12, agent_notes: '{"cluster_type":"ssl_san_hash"}', component_id: "component_cluster_cert_san1",
      // Component member that is a legacy row is just absent from the set.
    });
    cluster(raw, { id: "cluster_subnet_45_9_20", threat_count: 200 });
    cluster(raw, { id: "cluster_ip_8.8.4.4", threat_count: 4 });
    cluster(raw, { id: "cluster_registrar_dormant", threat_count: 300, status: "dormant" });
    cluster(raw, { id: "ffffffff-legacy-member", threat_count: 80_000, component_id: "component_cluster_cert_san1" });
    const { env, kv } = makeEnv(raw);

    const res = await handleObservatoryOperationsGeo(req("/api/observatory/operations-geo"), env);
    expect(res.status).toBe(200);
    const b = await body<{ operations: OperationGeo[]; components: Array<{ component_id: string; operation_ids: string[]; edges: Array<{ a: string; b: string; kind: unknown }> }> }>(res);
    expect(b.data.operations.map((o) => o.id)).toEqual([
      "cluster_cert_san1", "cluster_ip_7.7.7.7", "cluster_subnet_45_9_20", "cluster_asn_as9009_phishing", "cluster_ip_8.8.4.4",
    ]);
    expect(b.data.operations.every((o) => o.id.startsWith("cluster_"))).toBe(true);
    expect(b.meta).toMatchObject({ include_shared: false, excluded: { shared_asn: 2, hub_ip: 1, ip_reputation: 1 }, scanned: 9, truncated: false });
    expect(b.data.operations[0]).toMatchObject({ evidence_tier: "cert", kind: "cert_san", shared_infra: false, hub: false, ip_reputation: false });
    expect(b.data.operations[1]).toMatchObject({ evidence_tier: "ip", brand_fanout: 2 });
    expect(b.data.operations[4]).toMatchObject({ evidence_tier: "residue", kind: "per_ip" });
    expect(b.data.components).toEqual([{
      component_id: "component_cluster_cert_san1",
      operation_ids: ["cluster_cert_san1", "cluster_ip_7.7.7.7"],
      countries: [],
      edges: [{ a: "cluster_cert_san1", b: "cluster_ip_7.7.7.7", kind: "cert_san", shared_asns: [] }],
    }]);

    const shared = await body<{ operations: OperationGeo[] }>(
      await handleObservatoryOperationsGeo(req("/api/observatory/operations-geo?include_shared=1&limit=4"), env));
    // Normal top-4, then every excluded row by threat_count (nothing is cut by the limit).
    expect(shared.data.operations.map((o) => o.id)).toEqual([
      "cluster_cert_san1", "cluster_ip_7.7.7.7", "cluster_subnet_45_9_20", "cluster_asn_as9009_phishing",
      "cluster_asn_as13335_malware_distribution", "cluster_asn_as16509_phishing", "cluster_asn_as9009_scanning", "cluster_ip_6.6.6.6",
    ]);
    expect(shared.data.operations[7]).toMatchObject({ hub: true, brand_fanout: 151 });
    // Counts reconcile: hidden (4) == shared rows returned == the flagged rows in the payload.
    expect(shared.meta).toMatchObject({ include_shared: true, excluded: { shared_asn: 2, hub_ip: 1, ip_reputation: 1 }, shared_returned: 4 });
    expect(shared.data.operations.filter((o) => o.shared_infra || o.hub || o.ip_reputation)).toHaveLength(4);
    expect(b.meta).toMatchObject({ shared_returned: 0 });
    const sharedAll = await body<{ operations: OperationGeo[] }>(
      await handleObservatoryOperationsGeo(req("/api/observatory/operations-geo?include_shared=1&limit=50"), env));
    const cf = sharedAll.data.operations.find((o) => o.id === "cluster_asn_as13335_malware_distribution")!;
    expect(cf).toMatchObject({ shared_infra: true, evidence_tier: "asn" });
    expect(sharedAll.data.operations.find((o) => o.id === "cluster_asn_as9009_scanning")).toMatchObject({ ip_reputation: true });

    const all = await body<{ operations: OperationGeo[] }>(
      await handleObservatoryOperationsGeo(req("/api/observatory/operations-geo?status=all"), env));
    expect(all.data.operations.map((o) => o.id)).toContain("cluster_registrar_dormant");
    expect(all.data.operations.every((o) => o.id.startsWith("cluster_"))).toBe(true);
    expect(all.meta).toMatchObject({ scanned: 10 });

    expect(lensKeys(kv).sort()).toEqual([
      "cv:observatory_lens.operations_geo.v3:active:25:s0",
      "cv:observatory_lens.operations_geo.v3:active:4:s1",
      "cv:observatory_lens.operations_geo.v3:active:50:s1",
      "cv:observatory_lens.operations_geo.v3:all:25:s0",
    ]);
    for (const bad of ["2", "true", "yes", "-1"]) {
      const r = await handleObservatoryOperationsGeo(req(`/api/observatory/operations-geo?include_shared=${bad}`), env);
      expect(r.status).toBe(400);
    }
    expect(lensKeys(kv)).toHaveLength(4);
    expect(OPERATIONS_GEO_SCAN_CAP).toBeGreaterThanOrEqual(1000);
  });

  it("movements: window + event_type filter, v1/v2 shapes, ASN→country, cluster_name fallback, 400, keyed", async () => {
    const raw = openDerivedDb(TABLES);
    provider(raw, { id: "hp_1", asn: "AS1", country: "US", active: 1 });
    provider(raw, { id: "hp_2", asn: "AS2", country: "nl", active: 1 });
    provider(raw, { id: "hp_3", asn: "AS8560", country: "DE", active: 1 });
    cluster(raw, { id: "cluster_asn_as8560_typosquatting", name: "AS8560 typosquatting cluster", threat_count: 1 });
    pivot(raw, "m1", secondsAgo(1), { kind: "infra_movement", cluster_id: "cluster_ip_1", cluster_name: "Op One", new_asns: 1, new_ips: 3, new_serials: 0, new_asn_list: ["AS2", "AS404"], prev_asn_list: ["AS1"], payload_v: 2 });
    pivot(raw, "m2", secondsAgo(2), { kind: "dormancy", cluster_id: "cluster_asn_as8560_typosquatting", asn: "AS8560", prev_asn: "AS8560", payload_v: 2 });
    pivot(raw, "m3", secondsAgo(3), { kind: "dormancy", cluster_id: "cluster_asn_as1_x", asn: "AS1" });
    pivot(raw, "old", secondsAgo(24 * 10), { kind: "dormancy", cluster_id: "c", asn: "AS1", payload_v: 2 });
    pivot(raw, "other", secondsAgo(1), { kind: "x" }, "feed_pulled");
    const { env, kv } = makeEnv(raw);

    const b = await body<Array<Record<string, unknown>>>(await handleObservatoryMovements(req("/api/observatory/movements?period=7d"), env));
    expect(b.meta.period).toBe("7d");
    expect(b.data.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(b.data[0]).toMatchObject({
      kind: "infra_movement", cluster_name: "Op One", payload_v: 2,
      from: { asns: ["AS1"], countries: ["US"] },
      to: { asns: ["AS2", "AS404"], countries: ["NL"] },
      counts: { new_asns: 1, new_ips: 3, new_serials: 0 },
    });
    expect(b.data[1]).toMatchObject({ kind: "dormancy", cluster_name: "AS8560 typosquatting cluster", from: { asns: ["AS8560"], countries: ["DE"] }, to: { asns: [], countries: [] } });
    expect(b.data[2]).toMatchObject({ payload_v: 1, from: { asns: ["AS1"], countries: ["US"] }, to: { asns: [], countries: [] }, cluster_name: null });

    const one = await body<unknown[]>(await handleObservatoryMovements(req("/api/observatory/movements?period=30d&limit=1"), env));
    expect(one.data).toHaveLength(1);
    expect(lensKeys(kv).sort()).toEqual(["cv:observatory_lens.movements:30d:1", "cv:observatory_lens.movements:7d:50"]);
    expect((await handleObservatoryMovements(req("/api/observatory/movements?period=all"), env)).status).toBe(400);
    expect(lensKeys(kv)).toHaveLength(2);
  });

  it("movements: ASN lookups chunk at ≤99 binds", async () => {
    const raw = openDerivedDb(TABLES);
    const asns = Array.from({ length: 10 }, (_, i) => `AS${1000 + i}`);
    for (let e = 0; e < 25; e++) {
      pivot(raw, `e${e}`, secondsAgo(1 + e / 100), { kind: "infra_movement", cluster_id: `c${e}`, cluster_name: "n",
        new_asn_list: asns.map((a) => `${a}${e}`), prev_asn_list: [], payload_v: 2 });
    }
    const { env, log } = makeEnv(raw);
    const res = await handleObservatoryMovements(req("/api/observatory/movements?limit=100"), env);
    expect(res.status).toBe(200);
    const inQueries = log.filter((l) => l.sql.includes("FROM hosting_providers WHERE asn IN"));
    expect(inQueries.length).toBe(3); // 250 distinct ASNs → 99 + 99 + 52
    for (const q of inQueries) expect((q.sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(99);
  });

  it("providers-geo: precomputed columns, active DESC, bulletproof filter, 400, takedown null without rollup rows", async () => {
    const raw = openDerivedDb(TABLES);
    provider(raw, { id: "hp_a", asn: "AS1", country: "us", active: 5 });
    provider(raw, { id: "hp_b", asn: "AS2", country: null, active: 50, bp: 1 });
    provider(raw, { id: "hp_c", asn: "AS3", country: "RU", active: 20 });
    const { env, kv, log } = makeEnv(raw);

    const b = await body<Array<Record<string, unknown>>>(await handleObservatoryProvidersGeo(req("/api/observatory/providers-geo?limit=2"), env));
    expect(b.data).toEqual([
      { id: "hp_b", name: "hp_b Inc", asn: "AS2", country: null, active_threat_count: 50, total_threat_count: 100, trend_7d: 1, trend_30d: 2, is_bulletproof: true, reputation_score: 40, takedown: null },
      expect.objectContaining({ id: "hp_c", country: "RU", is_bulletproof: false }),
    ]);
    expect(log.some((l) => /FROM threats\b/.test(l.sql))).toBe(false);
    const bp = await body<Array<{ id: string }>>(await handleObservatoryProvidersGeo(req("/api/observatory/providers-geo?bulletproof=1"), env));
    expect(bp.data.map((p) => p.id)).toEqual(["hp_b"]);
    expect(lensKeys(kv).sort()).toEqual(["cv:observatory_lens.providers_geo_base:100:bp1", "cv:observatory_lens.providers_geo_base:2:bp0"]);
    expect((await handleObservatoryProvidersGeo(req("/api/observatory/providers-geo?bulletproof=yes"), env)).status).toBe(400);
  });

  it("overindex: geo cube window, latest radar snapshot only, meta.radar_snapshot_date, 7d|30d only", async () => {
    const raw = openDerivedDb(TABLES);
    geo(raw, { cc: "US", sev: "high", n: 30 });
    geo(raw, { cc: "CN", sev: "low", n: 10 });
    geo(raw, { cc: "XX", sev: "low", n: 500 });
    geo(raw, { hour: hourAgo(24 * 20), cc: "BR", sev: "low", n: 7 }); // outside 7d, inside 30d
    const radar = raw.prepare(`INSERT INTO radar_country_snapshots (snapshot_date, metric, country_code, rank, value_pct) VALUES (?, ?, ?, 1, ?)`);
    radar.run("2026-10-12", "attack_origin", "US", 99);
    radar.run("2026-10-13", "attack_origin", "US", 50);
    radar.run("2026-10-13", "attack_origin", "DE", 10);
    radar.run("2026-10-13", "attack_target", "CN", 80);
    const { env, kv } = makeEnv(raw);

    const b = await body<Array<Record<string, unknown>>>(await handleObservatoryOverindex(req("/api/observatory/overindex"), env));
    expect(b.meta).toMatchObject({ period: "7d", radar_snapshot_date: "2026-10-13" });
    expect(b.data).toEqual([
      { country_code: "US", our_count: 30, our_share: 0.75, radar_share: 0.5, ratio: 1.5 },
      { country_code: "CN", our_count: 10, our_share: 0.25, radar_share: null, ratio: null },
      { country_code: "DE", our_count: 0, our_share: 0, radar_share: 0.1, ratio: 0 },
    ]);
    const m30 = await body<Array<{ country_code: string }>>(await handleObservatoryOverindex(req("/api/observatory/overindex?period=30d"), env));
    expect(m30.data.map((r) => r.country_code)).toContain("BR");
    for (const p of ["24h", "90d", "bogus"]) {
      expect((await handleObservatoryOverindex(req(`/api/observatory/overindex?period=${p}`), env)).status).toBe(400);
    }
    expect(lensKeys(kv).sort()).toEqual(["cv:observatory_lens.overindex:30d", "cv:observatory_lens.overindex:7d"]);
    expect(kv.store.get("cv:observatory_lens.overindex:7d")?.ttl).toBe(LENS_TTL_S.overindex * 2);
  });

  it("campaigns-geo: never selects slug (absent in prod); slug = id; arrays normalised; curated", async () => {
    const raw = openDerivedDb(TABLES);
    raw.prepare(`INSERT INTO geopolitical_campaigns (id, name, slug, conflict, status, threat_actors, adversary_countries, target_countries, start_date)
      VALUES ('geo-iran-irgc-2026', 'IRGC Retaliation Campaign', 'ignored-slug', 'iran-israel-2026', 'active',
        '["Handala","Hydro Kitten"]', '["IR","iq","bad"]', 'oops', '2026-02-28')`).run();
    const { env, kv, log } = makeEnv(raw);
    const b = await body<Array<Record<string, unknown>>>(await handleObservatoryCampaignsGeo(req("/api/observatory/campaigns-geo"), env));
    expect(b.data).toEqual([{
      id: "geo-iran-irgc-2026", name: "IRGC Retaliation Campaign", slug: "geo-iran-irgc-2026", status: "active",
      conflict: "iran-israel-2026", adversary_countries: ["IR", "IQ"], target_countries: [],
      threat_actors: ["Handala", "Hydro Kitten"], start_date: "2026-02-28", curated: true,
    }]);
    expect(log.some((l) => /\bslug\b/.test(l.sql))).toBe(false);
    expect(lensKeys(kv)).toEqual(["cv:observatory_lens.campaigns_geo"]);
  });

  it("timeline: status cube (active only) vs geo cube with country, source filter, zero-fill, TTL, 400s", async () => {
    const raw = openDerivedDb(TABLES);
    statusCube(raw, { hour: hourAgo(0), sev: "critical", n: 2 });
    statusCube(raw, { hour: hourAgo(0), sev: "unknown", n: 1 });
    statusCube(raw, { hour: hourAgo(3), sev: "High", n: 5 });
    statusCube(raw, { hour: hourAgo(3), sev: "high", status: "remediated", n: 100 });
    statusCube(raw, { hour: hourAgo(3), sev: "low", feed: "spam_trap", n: 4 });
    statusCube(raw, { hour: hourAgo(30), sev: "low", n: 9 }); // outside 24h
    geo(raw, { hour: hourAgo(1), cc: "US", sev: "medium", n: 6 });
    geo(raw, { hour: hourAgo(1), cc: "DE", sev: "medium", n: 8 });
    const { env, kv } = makeEnv(raw);

    const b = await body<{ bucket: string; points: Array<{ t: string; total: number; critical: number; high: number; low: number; medium: number }> }>(
      await handleObservatoryTimeline(req("/api/observatory/timeline?period=24h"), env));
    expect(b.data.bucket).toBe("1h");
    expect(b.data.points).toHaveLength(24);
    const last = b.data.points[23]!;
    expect(last).toMatchObject({ total: 3, critical: 2 });
    expect(b.data.points[20]).toMatchObject({ total: 9, high: 5, low: 4 });
    expect(b.data.points.reduce((s, p) => s + p.total, 0)).toBe(12);
    expect(kv.store.get("cv:observatory_lens.timeline:24h:all:all")?.ttl).toBe(LENS_TTL_S.timelineShort * 2);

    const spam = await body<{ points: Array<{ total: number }> }>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=24h&source_feed=spam_trap"), env));
    expect(spam.data.points.reduce((s, p) => s + p.total, 0)).toBe(4);

    const us = await body<{ points: Array<{ total: number; medium: number }> }>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=24h&country=us"), env));
    expect(us.data.points[22]).toMatchObject({ total: 6, medium: 6 });
    expect(us.meta.country).toBe("US");

    const d90 = await body<{ bucket: string; points: unknown[] }>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=90d&source_feed=all"), env));
    expect(d90.data.bucket).toBe("1d");
    expect(d90.data.points).toHaveLength(90);
    expect(kv.store.get("cv:observatory_lens.timeline:90d:all:all")?.ttl).toBe(LENS_TTL_S.timeline * 2);

    expect((await handleObservatoryTimeline(req("/api/observatory/timeline?period=1y"), env)).status).toBe(400);
    expect((await handleObservatoryTimeline(req("/api/observatory/timeline?country=USA"), env)).status).toBe(400);
    // Syntactically ISO-2 but no centroid, and the 'XX' unknown sentinel → 400, no key minted.
    for (const c of ["QQ", "XX", "xx", "ZZ"]) {
      expect((await handleObservatoryTimeline(req(`/api/observatory/timeline?period=24h&country=${c}`), env)).status).toBe(400);
    }
    expect(lensKeys(kv).sort()).toEqual([
      "cv:observatory_lens.timeline:24h:all:US",
      "cv:observatory_lens.timeline:24h:all:all",
      "cv:observatory_lens.timeline:24h:spam_trap:all",
      "cv:observatory_lens.timeline:90d:all:all",
    ].sort());
  });

  it("actors: list counts; detail infra/clusters/attribution rollups; 404 not cached; 400 long id", async () => {
    const raw = openDerivedDb(TABLES);
    actor(raw, "ta_1", "Charming Kitten", '["APT35"]');
    actor(raw, "ta_2", "Quiet Actor");
    cluster(raw, { id: "cluster_ip_1", threat_count: 9, actor_id: "ta_1", countries: '["US","DE"]', asns: '["AS1"]', confidence: 70 });
    cluster(raw, { id: "cluster_ip_2", threat_count: 3, actor_id: "ta_1" });
    raw.prepare(`INSERT INTO threat_actor_infrastructure (id, threat_actor_id, asn, country_code, hosting_provider, confidence, last_observed)
      VALUES ('i1', 'ta_1', '13335', 'us', 'Cloudflare', 'high', '2026-10-01 00:00:00')`).run();
    const attr = raw.prepare(`INSERT INTO threat_attributions (id, threat_id, actor_id, source, confidence) VALUES (?, ?, ?, ?, ?)`);
    attr.run("a1", "t1", "ta_1", "otx", "high");
    attr.run("a2", "t2", "ta_1", "otx", "medium");
    attr.run("a3", "t3", "ta_1", "nexus", "high");
    attr.run("a4", "t4", "ta_2", "manual", "low");
    const { env, kv } = makeEnv(raw);

    const list = await body<Array<Record<string, unknown>>>(await handleObservatoryActors(req("/api/observatory/actors"), env));
    expect(list.data).toEqual([
      { id: "ta_1", name: "Charming Kitten", cluster_count: 2, infra_count: 1 },
      { id: "ta_2", name: "Quiet Actor", cluster_count: 0, infra_count: 0 },
    ]);

    const d = await body<Record<string, unknown>>(await handleObservatoryActors(req("/api/observatory/actors?actor_id=ta_1"), env));
    expect(d.data).toMatchObject({
      actor: { id: "ta_1", name: "Charming Kitten", aliases: ["APT35"], country_code: "IR" },
      infrastructure: [{ asn: "AS13335", country_code: "US", hosting_provider: "Cloudflare", confidence: "high", last_observed: "2026-10-01 00:00:00" }],
      clusters: [
        { id: "cluster_ip_1", countries: ["US", "DE"], asns: ["AS1"], confidence_score: 70 },
        { id: "cluster_ip_2", countries: [], asns: [], confidence_score: 50 },
      ],
      attributions: { by_confidence: { high: 2, medium: 1 }, by_source: { otx: 2, nexus: 1 } },
    });

    const missing = await handleObservatoryActors(req("/api/observatory/actors?actor_id=nope"), env);
    expect(missing.status).toBe(404);
    expect((await missing.json() as { success: boolean }).success).toBe(false);
    expect((await handleObservatoryActors(req(`/api/observatory/actors?actor_id=${"x".repeat(129)}`), env)).status).toBe(400);
    for (const bad of ["a b", "ta_1;drop", "ta/1", "ta%00", "<script>", "é"]) {
      expect((await handleObservatoryActors(req(`/api/observatory/actors?actor_id=${encodeURIComponent(bad)}`), env)).status).toBe(400);
    }
    // 128 chars of the allowed alphabet is fine (404 here — unknown — never cached).
    expect((await handleObservatoryActors(req(`/api/observatory/actors?actor_id=${"a.b:c-d_".repeat(16)}`), env)).status).toBe(404);
    // `actor_id=list` is a detail lookup in its own namespace — never the list payload.
    const listAsId = await handleObservatoryActors(req("/api/observatory/actors?actor_id=list"), env);
    expect(listAsId.status).toBe(404);
    expect(lensKeys(kv).sort()).toEqual(["cv:observatory_lens.actors:detail:ta_1", "cv:observatory_lens.actors:list"]);
  });

  it("cache hits serve without touching D1", async () => {
    const raw = openDerivedDb(TABLES);
    const { env, log } = makeEnv(raw);
    await handleObservatoryProvidersGeo(req("/api/observatory/providers-geo"), env);
    const n = log.length;
    const again = await handleObservatoryProvidersGeo(req("/api/observatory/providers-geo?bulletproof=0&limit=100"), env);
    expect(again.status).toBe(200);
    expect(log.length).toBe(n);
  });
});
