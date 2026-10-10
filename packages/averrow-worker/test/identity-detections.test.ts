// IdP drill-down: GET /api/intel/identity-threats/detections(/:threatId).
// Runs the real handler SQL against an in-memory SQLite whose schema AND
// indexes are replayed from migrations/, so a wrong column, a bind-arity
// mismatch or a plan that stops using idx_threats_technique_created fails.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import { splitStatements } from "./migration-schema";
import {
  buildDetectionWhere,
  decodeDetectionCursor,
  encodeDetectionCursor,
  getIdentityDetection,
  handleIdentityDetectionDetail,
  handleIdentityDetections,
  listIdentityDetections,
  mitreUrl,
  parseDetectionQuery,
  type DetectionQuery,
} from "../src/handlers/identityDetections";
import { IDP_MITRE } from "../src/lib/idp-impersonation";
import type { Env } from "../src/types";

const TABLES = ["threats", "brands", "hosting_providers", "infrastructure_clusters", "takedown_requests"];
const NOW = new Date("2026-10-10T12:00:00Z");
const MIGRATIONS_DIR = resolve(__dirname, "..", "migrations");

/** Replay every CREATE/DROP INDEX on the tables under test, in migration order. */
function replayIndexes(db: SqliteDb): void {
  const onTable = new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(${TABLES.join("|")})\s*\(`, "i");
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of splitStatements(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"))) {
      if (onTable.test(stmt) || /^DROP\s+INDEX/i.test(stmt)) {
        // Idempotent replay (some indexes are re-declared by later fix-up migrations).
        const sql = stmt
          .replace(/^DROP\s+INDEX\s+(?!IF\s+EXISTS)/i, "DROP INDEX IF EXISTS ")
          .replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i, (_m, u: string | undefined) => `CREATE ${u ?? ""}INDEX IF NOT EXISTS `);
        db.exec(sql);
      }
    }
  }
}

interface ThreatSeed {
  id: string;
  technique: string | null;
  idp: string | null;
  brand: string | null;
  domain: string;
  created: string;
  url?: string;
}
const THREATS: ThreatSeed[] = [
  { id: "t01", technique: "idp_tenant_abuse", idp: "okta", brand: "b1", domain: "acme-sso.okta.com", created: "2026-10-10 09:00:00" },
  { id: "t02", technique: "idp_lookalike", idp: "okta", brand: "b2", domain: "globex-okta.com", created: "2026-10-09 08:00:00" },
  { id: "t03", technique: "idp_lookalike", idp: "generic_sso", brand: "b1", domain: "acme-sso.com", created: "2026-10-08 08:00:00" },
  { id: "t04", technique: "device_code_phishing", idp: null, brand: null, domain: "qzx-files.net", created: "2026-10-07 08:00:00" },
  { id: "t05", technique: "oauth_consent_phishing", idp: "entra", brand: "b1", domain: "qzx-docs.net", created: "2026-10-06 08:00:00" },
  { id: "t06", technique: "idp_tenant_abuse", idp: "onelogin", brand: "b2", domain: "globex.onelogin.com", created: "2026-10-05 08:00:00" },
  { id: "t07", technique: null, idp: null, brand: "b1", domain: "acme-login.net", created: "2026-10-09 10:00:00" },
  { id: "t08", technique: "idp_tenant_abuse", idp: "okta", brand: "b1", domain: "acme.okta.com", created: "2026-09-20 08:00:00" },
  // Same created_at as t01 — the id tie-break must keep pages disjoint.
  { id: "t09", technique: "idp_lookalike", idp: "entra", brand: "b1", domain: "acme-entra-login.com", created: "2026-10-10 09:00:00" },
  { id: "t10", technique: "idp_lookalike", idp: "entra", brand: "b1", domain: "acme-entra-sso.com", created: "2026-10-10 09:00:00" },
];
const IN_7D = ["t10", "t09", "t01", "t02", "t03", "t04", "t05", "t06"];

describe.skipIf(!hasSqlite())("IdP detections drill-down (real SQLite)", () => {
  let raw: SqliteDb;
  let log: StatementLogEntry[];
  let env: Env;
  const req = (path = "/api/intel/identity-threats/detections"): Request => new Request(`https://x.test${path}`);

  beforeEach(() => {
    raw = openDerivedDb(TABLES);
    replayIndexes(raw);
    log = [];
    const d1 = d1FromSqlite(raw, { log });
    env = { DB: Object.assign(d1, { withSession: () => d1 }), CACHE: fakeKv() } as unknown as Env;

    raw.exec(`INSERT INTO brands (id, name, canonical_domain) VALUES ('b1', 'Acme', 'acme.com'), ('b2', 'Globex', 'globex.com')`);
    raw.exec(`INSERT INTO hosting_providers (id, name) VALUES ('hp1', 'Okta Inc')`);
    raw.exec(`INSERT INTO infrastructure_clusters (id, cluster_name) VALUES ('c1', 'Okta tenant ring')`);
    const ins = raw.prepare(
      `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, malicious_url, target_brand_id,
         technique, impersonated_idp, status, severity, created_at, first_seen, last_seen)
       VALUES (?, 'openphish', 'phishing', ?, ?, ?, ?, ?, 'active', 'high', ?, ?, ?)`,
    );
    for (const t of THREATS) {
      ins.run(t.id, t.domain, t.url ?? `https://${t.domain}/login`, t.brand, t.technique, t.idp, t.created, t.created, t.created);
    }
    raw.exec(`UPDATE threats SET hosting_provider_id = 'hp1', cluster_id = 'c1', ip_address = '1.2.3.4',
      country_code = 'US', asn = 'AS13335', ssl_cert_issuer = 'R11', domain_created_at = '2026-10-01 00:00:00',
      domain_age_days = 9, weaponization_hours = 12, weaponization_flag = 'fast',
      vt_checked = 1, vt_malicious = 4, gsb_checked = 1, gsb_flagged = 1, gsb_threat_type = 'SOCIAL_ENGINEERING',
      surbl_checked = 1, surbl_listed = 0, enriched_at = '2026-10-10 10:00:00' WHERE id = 't01'`);
    raw.exec(`INSERT INTO takedown_requests (id, brand_id, target_type, target_value, evidence_summary, source_type, source_id, status, created_at, updated_at)
      VALUES ('td_old', 'b1', 'domain', 'acme-sso.okta.com', 'x', 'threat', 't01', 'draft', '2026-10-10 09:30:00', '2026-10-10 09:30:00'),
             ('td_new', 'b1', 'domain', 'acme-sso.okta.com', 'x', 'threat', 't01', 'submitted', '2026-10-10 09:40:00', '2026-10-10 11:00:00'),
             ('td_alert', 'b1', 'domain', 'acme-sso.okta.com', 'x', 'alert', 't01', 'taken_down', '2026-10-10 11:30:00', '2026-10-10 11:30:00')`);
  });

  const query = (qs: string): DetectionQuery => {
    const p = parseDetectionQuery(new URLSearchParams(qs));
    if (!p.ok) throw new Error(p.error);
    return p.query;
  };
  const ids = async (qs: string): Promise<{ ids: string[]; total: number }> => {
    const r = await listIdentityDetections(env, req(), query(qs), NOW);
    return { ids: r.items.map((i) => i.threat_id), total: r.total };
  };

  it("default window lists every in-window family row, newest first, id DESC on ties", async () => {
    expect(await ids("")).toEqual({ ids: IN_7D, total: 8 });
    expect((await ids("window=30d")).total).toBe(9);
  });

  it("each filter narrows correctly", async () => {
    expect(await ids("idp=okta")).toEqual({ ids: ["t01", "t02"], total: 2 });
    // device-code row with no stored idp displays (and filters) as entra.
    expect(await ids("idp=entra")).toEqual({ ids: ["t10", "t09", "t04", "t05"], total: 4 });
    expect(await ids("vector=device_code")).toEqual({ ids: ["t04", "t05"], total: 2 });
    expect(await ids("vector=idp_tenant")).toEqual({ ids: ["t01", "t06"], total: 2 });
    expect(await ids("brand_id=b2")).toEqual({ ids: ["t02", "t06"], total: 2 });
    expect(await ids("brand_id=b1&vector=idp_lookalike&idp=entra")).toEqual({ ids: ["t10", "t09"], total: 2 });
  });

  it("mitre maps to that technique's vectors", async () => {
    expect(await ids("mitre=T1528")).toEqual({ ids: ["t04", "t05"], total: 2 });
    expect(await ids("mitre=T1583.006")).toEqual({ ids: ["t01", "t06"], total: 2 });
    expect(await ids("mitre=T1583.001")).toEqual({ ids: ["t10", "t09", "t02", "t03"], total: 4 });
    expect((await ids("mitre=T1566.002")).total).toBe(8);
    // Disjoint vector ∩ mitre → empty without touching D1.
    const before = log.length;
    expect(await ids("mitre=T1528&vector=idp_tenant")).toEqual({ ids: [], total: 0 });
    expect(log.length).toBe(before);
  });

  it("list item shape", async () => {
    const r = await listIdentityDetections(env, req(), query("idp=okta"), NOW);
    expect(r.items[0]).toEqual({
      threat_id: "t01", domain: "acme-sso.okta.com", url: "https://acme-sso.okta.com/login",
      brand_id: "b1", brand_name: "Acme", idp: "okta", idp_label: "Okta",
      vector: "idp_tenant", vector_label: "Abused identity-provider tenant",
      status: "active", severity: "high", source_feed: "openphish", created_at: "2026-10-10T09:00:00Z",
    });
    expect(r.next_cursor).toBeNull();
  });

  it("cursor pages are disjoint and complete (incl. created_at ties)", async () => {
    for (const [qs, expected] of [["", IN_7D], ["idp=entra", ["t10", "t09", "t04", "t05"]]] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const params = `${qs}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const r = await listIdentityDetections(env, req(), query(params), NOW);
        expect(r.items.length).toBeLessThanOrEqual(3);
        expect(r.total).toBe(expected.length);
        seen.push(...r.items.map((i) => i.threat_id));
        cursor = r.next_cursor;
        pages++;
      } while (cursor && pages < 10);
      expect(seen).toEqual([...expected]);
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it("cursor round-trips and rejects garbage", () => {
    const c = { created_at: "2026-10-10 09:00:00", id: "t09" };
    expect(decodeDetectionCursor(encodeDetectionCursor(c))).toEqual(c);
    expect(decodeDetectionCursor("!!!")).toBeNull();
    expect(decodeDetectionCursor(btoa("[1,2]"))).toBeNull();
    expect(decodeDetectionCursor(btoa("{}"))).toBeNull();
  });

  it("invalid enum / limit / cursor → 400 without querying", async () => {
    for (const qs of ["window=1d", "idp=foo", "vector=bogus", "mitre=T9999", "mitre=T1621",
      "limit=0", "limit=101", "limit=abc", "limit=2.5", "cursor=%21%21", `brand_id=${"x".repeat(129)}`,
      "brand_id=a%20b", "brand_id=%27x%27"]) {
      const res = await handleIdentityDetections(req(`/api/intel/identity-threats/detections?${qs}`), env);
      expect(res.status, qs).toBe(400);
      expect(await res.json()).toMatchObject({ success: false });
    }
    expect(log).toHaveLength(0);
    const ok = await handleIdentityDetections(req("/api/intel/identity-threats/detections?limit=100&window=30d"), env);
    expect(ok.status).toBe(200);
  });

  it("total is cached per filter set (cachedCount key encodes every filter + window day)", async () => {
    const kv = (env as unknown as { CACHE: { store: Map<string, string> } }).CACHE.store;
    await ids("idp=okta&brand_id=b1");
    await ids("idp=okta&brand_id=b1&limit=1");
    const keys = [...kv.keys()].filter((k) => k.includes("idp.detections"));
    expect(keys).toEqual([expect.stringContaining("count.idp.detections.7d.2026-10-04.okta.idp_tenant+idp_lookalike+device_code.b1")]);
    const counts = log.filter((l) => l.sql.includes("COUNT(*)"));
    expect(counts).toHaveLength(1);
  });

  it("bind arity: placeholders == binds for every filter combination", () => {
    const combos = ["", "idp=entra", "idp=okta", "idp=entra&vector=idp_tenant", "brand_id=b1&idp=entra&mitre=T1528", "vector=device_code"];
    for (const qs of combos) {
      const w = buildDetectionWhere(query(qs), "2026-10-04 00:00:00");
      expect((w.sql.match(/\?/g) ?? []).length, qs).toBe(w.binds.length);
    }
    expect(log.every((l) => !l.error)).toBe(true);
  });

  it("EXPLAIN: list + total use idx_threats_technique_created; filters are residual", async () => {
    await listIdentityDetections(env, req(), query("idp=entra&brand_id=b1"), NOW);
    await listIdentityDetections(env, req(), query(`limit=2&cursor=${encodeDetectionCursor({ created_at: "2026-10-09 08:00:00", id: "t02" })}`), NOW);
    const p = parseDetectionQuery(new URLSearchParams("idp=entra&brand_id=b1"));
    if (!p.ok) throw new Error("parse");
    const w = buildDetectionWhere(p.query, "2026-10-04 00:00:00");
    const plans: string[] = [];
    const listSql = log.find((l) => l.sql.includes("ORDER BY t.created_at DESC"))!.sql;
    plans.push(raw.prepare(`EXPLAIN QUERY PLAN ${listSql}`).all(...w.binds, 26)
      .map((r) => String((r as { detail: string }).detail)).join(" | "));
    plans.push(raw.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM threats t WHERE ${w.sql}`).all(...w.binds)
      .map((r) => String((r as { detail: string }).detail)).join(" | "));
    // Cursor page: the keyset bound tightens the same index range.
    const pc = parseDetectionQuery(new URLSearchParams("limit=2"));
    if (!pc.ok) throw new Error("parse");
    const wc = buildDetectionWhere(pc.query, "2026-10-04 00:00:00");
    const cursorSql = log.filter((l) => l.sql.includes("ORDER BY t.created_at DESC"))[1]!.sql;
    expect(cursorSql).toContain("t.created_at <= ?");
    plans.push(raw.prepare(`EXPLAIN QUERY PLAN ${cursorSql}`).all(...wc.binds, "2026-10-09 08:00:00", "2026-10-09 08:00:00", "t02", 3)
      .map((r) => String((r as { detail: string }).detail)).join(" | "));
    for (const plan of plans) {
      expect(plan).toMatch(/SEARCH t USING (COVERING )?INDEX idx_threats_technique_created \(technique=\? AND created_at>\?/);
      expect(plan).not.toMatch(/SCAN t\b/);
    }
  });

  it("detail: full shape for a family threat", async () => {
    const d = await getIdentityDetection(env, req(), "t01");
    expect(d).toMatchObject({
      threat_id: "t01", technique: "idp_tenant_abuse", vector: "idp_tenant", idp: "okta", idp_label: "Okta",
      brand_name: "Acme", matched_lure: "acme-sso.okta.com",
      infrastructure: { ip_address: "1.2.3.4", country_code: "US", asn: "AS13335",
        hosting_provider: { id: "hp1", name: "Okta Inc" }, ssl_cert_issuer: "R11" },
      registration: { domain_created_at: "2026-10-01T00:00:00Z", domain_age_days: 9, weaponization_hours: 12, weaponization_flag: "fast" },
      reputation: { vt_checked: true, vt_malicious: 4, gsb_checked: true, gsb_flagged: true, gsb_threat_type: "SOCIAL_ENGINEERING",
        greynoise_checked: false, greynoise_classification: null, seclookup_checked: false, seclookup_risk_score: null,
        surbl_listed: false, dbl_listed: null },
      timeline: { first_seen: "2026-10-10T09:00:00Z", last_seen: "2026-10-10T09:00:00Z", created_at: "2026-10-10T09:00:00Z", enriched_at: "2026-10-10T10:00:00Z" },
      // Latest threat-sourced takedown; the alert-sourced row is not this threat's link.
      takedown: { id: "td_new", status: "submitted", updated_at: "2026-10-10T11:00:00Z" },
      cluster: { id: "c1", name: "Okta tenant ring" },
    });
    const expectedTtps = IDP_MITRE.filter((m) => m.vectors.includes("idp_tenant")).map((m) => m.id);
    expect(d!.ttps.map((t) => t.id)).toEqual(expectedTtps);
    expect(d!.ttps.find((t) => t.id === "T1566.002")!.url).toBe("https://attack.mitre.org/techniques/T1566/002/");
    expect(mitreUrl("T1557")).toBe("https://attack.mitre.org/techniques/T1557/");
  });

  it("detail: device-code row resolves entra, no lure, unenriched → nulls", async () => {
    const d = await getIdentityDetection(env, req(), "t04");
    expect(d).toMatchObject({
      vector: "device_code", idp: "entra", matched_lure: null, brand_id: null, brand_name: null,
      infrastructure: { ip_address: null, hosting_provider: null },
      reputation: { vt_checked: false, vt_malicious: null, gsb_flagged: null, surbl_listed: null },
      takedown: null, cluster: null,
    });
    expect(d!.ttps.map((t) => t.id)).toContain("T1528");
    expect(d!.ttps.map((t) => t.id)).not.toContain("T1557");
  });

  it("EXPLAIN: detail takedown lookup is indexed on source_id", async () => {
    await getIdentityDetection(env, req(), "t01");
    const sql = log.find((l) => l.sql.includes("FROM takedown_requests"))!.sql;
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("t01").map((r) => String((r as { detail: string }).detail)).join(" | ");
    expect(plan).toMatch(/SEARCH takedown_requests USING INDEX \S+ \(source_id=\?\)/);
  });

  it("detail: 404 for non-family and missing threats", async () => {
    for (const id of ["t07", "nope", "a b", "x".repeat(129)]) {
      const res = await handleIdentityDetectionDetail(req(`/api/intel/identity-threats/detections/${id}`), env, id);
      expect(res.status).toBe(404);
    }
    const ok = await handleIdentityDetectionDetail(req("/api/intel/identity-threats/detections/t01"), env, "t01");
    expect(ok.status).toBe(200);
    expect(log.every((l) => !l.error)).toBe(true);
  });
});
