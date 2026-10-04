/**
 * threatAggregate filter / org-scope regression.
 *
 * Bug: five leaderboard queries appended `JOIN brands|hosting_providers|
 * campaigns` AFTER the `WHERE ...` clause, so any filter or client org scope
 * produced `near "JOIN": syntax error`. top_brands / top_providers /
 * multi_brand_providers threw (GET /api/threats/aggregate -> 500) while
 * top_campaigns / multi_brand_campaigns swallowed the error via `.catch` and
 * silently returned []. `tsc` cannot see any of this: it is a runtime SQL
 * shape bug, so the test runs the real queries against the migration-derived
 * SQLite schema and compares every leaderboard to an independent in-JS oracle
 * computed from the same seed rows.
 */

import { describe, it, expect } from "vitest";
import {
  hasSqlite,
  openDerivedDb,
  d1FromSqlite,
  fakeKv,
  sqliteTimestampHoursAgo,
  type StatementLogEntry,
} from "./sqlite-d1-harness";
import type { Env } from "../src/types";
import { threatAggregate, type ThreatAggregateFilters } from "../src/lib/threat-aggregates";

const TABLES = [
  "threats", "brands", "hosting_providers", "campaigns",
  "threat_actors", "threat_actor_infrastructure",
];

interface Seed {
  id: string; brand: string; provider: string; campaign: string | null;
  severity: string; type: string; status: string; feed: string;
  country: string; hoursAgo: number; asn: string; domain: string;
}

const h = (days: number): number => days * 24;

// brands b1..b3; providers p1..p3; campaigns c1..c3.
// c1 spans b1+b2 (multi-brand), c2 spans b3+b1 (multi-brand), c3 is single-brand.
// p1 spans b1+b2, p2 spans b3+b1, p3 spans b2+b3 (all multi-brand on the full set).
const SEEDS: Seed[] = [
  { id: "t1", brand: "b1", provider: "p1", campaign: "c1", severity: "high",     type: "phishing",  status: "active",     feed: "feedA", country: "US", hoursAgo: h(1),  asn: "AS100", domain: "alpha-login.com" },
  { id: "t2", brand: "b2", provider: "p1", campaign: "c1", severity: "high",     type: "phishing",  status: "active",     feed: "feedA", country: "US", hoursAgo: h(2),  asn: "AS100", domain: "beta-login.com" },
  { id: "t3", brand: "b3", provider: "p2", campaign: "c2", severity: "critical", type: "malware_distribution",   status: "active",     feed: "feedB", country: "DE", hoursAgo: h(3),  asn: "AS200", domain: "gamma.evil.net" },
  { id: "t4", brand: "b1", provider: "p2", campaign: "c2", severity: "low",      type: "phishing",  status: "down",       feed: "feedB", country: "DE", hoursAgo: h(40), asn: "AS200", domain: "alpha-old.com" },
  { id: "t5", brand: "b2", provider: "p3", campaign: "c3", severity: "medium",   type: "typosquatting", status: "remediated", feed: "feedA", country: "FR", hoursAgo: h(1),  asn: "AS300", domain: "beta-typo.org" },
  { id: "t6", brand: "b3", provider: "p3", campaign: null, severity: "critical", type: "phishing",  status: "active",     feed: "feedB", country: "US", hoursAgo: h(60), asn: "AS300", domain: "gamma-login.com" },
  { id: "t7", brand: "b1", provider: "p1", campaign: null, severity: "low",      type: "malware_distribution",   status: "active",     feed: "feedA", country: "US", hoursAgo: h(5),  asn: "AS100", domain: "alpha-drop.io" },
];

const ACTOR_ASN: Record<string, string> = { ta1: "AS100", ta2: "AS200" };
const BRAND_NAME: Record<string, string> = { b1: "Brand One", b2: "Brand Two", b3: "Brand Three" };
const PROVIDER_NAME: Record<string, string> = { p1: "Prov One", p2: "Prov Two", p3: "Prov Three" };
const CAMPAIGN_NAME: Record<string, string> = { c1: "Camp One", c2: "Camp Two", c3: "Camp Three" };

function seedDb() {
  const db = openDerivedDb(TABLES);
  const brands = db.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES (?, ?, ?)");
  for (const [id, name] of Object.entries(BRAND_NAME)) brands.run(id, name, `${id}.example`);
  const prov = db.prepare("INSERT INTO hosting_providers (id, name, asn) VALUES (?, ?, ?)");
  prov.run("p1", PROVIDER_NAME.p1, "AS100");
  prov.run("p2", PROVIDER_NAME.p2, "AS200");
  prov.run("p3", PROVIDER_NAME.p3, "AS300");
  const camp = db.prepare("INSERT INTO campaigns (id, name, status) VALUES (?, ?, 'active')");
  for (const [id, name] of Object.entries(CAMPAIGN_NAME)) camp.run(id, name);
  db.prepare("INSERT INTO threat_actors (id, name) VALUES ('ta1','Actor One'), ('ta2','Actor Two')").run();
  const tai = db.prepare("INSERT INTO threat_actor_infrastructure (id, threat_actor_id, asn) VALUES (?, ?, ?)");
  Object.entries(ACTOR_ASN).forEach(([actor, asn], i) => tai.run(`i${i}`, actor, asn));

  const ins = db.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, ioc_value, malicious_domain, asn, country_code,
                          target_brand_id, hosting_provider_id, campaign_id, status, severity,
                          confidence_score, created_at, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 80, ?, ?)`,
  );
  for (const s of SEEDS) {
    const ts = sqliteTimestampHoursAgo(s.hoursAgo);
    ins.run(s.id, s.feed, s.type, s.domain, s.domain, s.asn, s.country,
      s.brand, s.provider, s.campaign, s.status, s.severity, ts, ts);
  }
  return db;
}

/** Wrap D1 so every executed statement asserts `?` count === bind count. */
function arityChecked(db: D1Database, violations: string[]): D1Database {
  const check = (stmt: unknown) => {
    const s = stmt as { __sql: string; __bound: unknown[] };
    const q = (s.__sql.match(/\?/g) ?? []).length;
    if (q !== s.__bound.length) {
      violations.push(`${q} placeholders vs ${s.__bound.length} binds: ${s.__sql.replace(/\s+/g, " ").trim()}`);
    }
  };
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop === "bind") return (...a: unknown[]) => wrap((v as (...x: unknown[]) => D1PreparedStatement).apply(target, a));
        if (prop === "all" || prop === "first" || prop === "run") {
          return (...a: unknown[]) => { check(target); return (v as (...x: unknown[]) => unknown).apply(target, a); };
        }
        return v;
      },
    });
  return new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "prepare") return (sql: string) => wrap((v as (s: string) => D1PreparedStatement).call(target, sql));
      return v;
    },
  });
}

// ── Independent oracle ──────────────────────────────────────────────

type Pred = (s: Seed) => boolean;
const counts = (rows: Seed[], key: (s: Seed) => string | null): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const r of rows) { const k = key(r); if (k !== null) o[k] = (o[k] ?? 0) + 1; }
  return o;
};
const brandCount = (rows: Seed[], key: (s: Seed) => string | null): Record<string, { threats: number; brands: number }> => {
  const o: Record<string, { threats: number; brands: Set<string> }> = {};
  for (const r of rows) {
    const k = key(r); if (k === null) continue;
    (o[k] ??= { threats: 0, brands: new Set() }).threats++;
    o[k]!.brands.add(r.brand);
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { threats: v.threats, brands: v.brands.size }]));
};

function expected(rows: Seed[]) {
  const multi = (m: Record<string, { threats: number; brands: number }>) =>
    Object.fromEntries(Object.entries(m).filter(([, v]) => v.brands >= 2));
  return {
    total: rows.length,
    brands: counts(rows, (s) => s.brand),
    providers: counts(rows, (s) => s.provider),
    campaigns: brandCount(rows, (s) => s.campaign),
    mbCampaigns: multi(brandCount(rows, (s) => s.campaign)),
    mbProviders: multi(brandCount(rows, (s) => s.provider)),
  };
}

interface Case { name: string; filters: ThreatAggregateFilters; scope?: { org_id: number; brand_ids: string[] }; pred: Pred }

const sinceDate = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);

const CASES: Case[] = [
  { name: "no filter", filters: {}, pred: () => true },
  { name: "severity=critical", filters: { severity: "critical" }, pred: (s) => s.severity === "critical" },
  { name: "type=phishing", filters: { type: "phishing" }, pred: (s) => s.type === "phishing" },
  { name: "status=active", filters: { status: "active" }, pred: (s) => s.status === "active" },
  { name: "source=feedB", filters: { source: "feedB" }, pred: (s) => s.feed === "feedB" },
  { name: "brand_id=b1", filters: { brand_id: "b1" }, pred: (s) => s.brand === "b1" },
  { name: "country=US", filters: { country: "US" }, pred: (s) => s.country === "US" },
  { name: "since=10 days ago", filters: { since: sinceDate }, pred: (s) => s.hoursAgo < h(10) },
  { name: "search=login", filters: { search: "login" }, pred: (s) => s.domain.includes("login") },
  { name: "actor_id=ta1 (asn join + bind order)", filters: { actor_id: "ta1" }, pred: (s) => s.asn === ACTOR_ASN.ta1 },
  { name: "actor_id=ta2 + severity=critical", filters: { actor_id: "ta2", severity: "critical" }, pred: (s) => s.asn === ACTOR_ASN.ta2 && s.severity === "critical" },
  { name: "severity+country+search combination", filters: { severity: "high", country: "US", search: "login" },
    pred: (s) => s.severity === "high" && s.country === "US" && s.domain.includes("login") },
  { name: "client org scope [b1,b2]", filters: {}, scope: { org_id: 7, brand_ids: ["b1", "b2"] }, pred: (s) => s.brand === "b1" || s.brand === "b2" },
  { name: "client org scope [b1,b2] + type=phishing + actor_id=ta1", filters: { type: "phishing", actor_id: "ta1" },
    scope: { org_id: 7, brand_ids: ["b1", "b2"] },
    pred: (s) => (s.brand === "b1" || s.brand === "b2") && s.type === "phishing" && s.asn === ACTOR_ASN.ta1 },
];

const byKey = <T,>(rows: T[], k: (r: T) => string, v: (r: T) => unknown): Record<string, unknown> =>
  Object.fromEntries(rows.map((r) => [k(r), v(r)]));

describe.skipIf(!hasSqlite())("threatAggregate filters + org scope (JOIN-after-WHERE regression)", () => {
  for (const c of CASES) {
    it(`${c.name}: runs clean and every leaderboard reflects exactly the slice`, async () => {
      const db = seedDb();
      const log: StatementLogEntry[] = [];
      const violations: string[] = [];
      const env = { DB: arityChecked(d1FromSqlite(db, { log }), violations), CACHE: fakeKv() } as unknown as Env;

      const agg = await threatAggregate(env, c.filters, c.scope ?? null);
      const exp = expected(SEEDS.filter(c.pred));

      // No statement may fail — the old bug was also swallowed by .catch on
      // the campaign queries, so assert on the statement log, not just output.
      expect(log.filter((e) => e.error).map((e) => e.error)).toEqual([]);
      expect(violations).toEqual([]);

      expect(agg.total).toBe(exp.total);
      expect(exp.total).toBeGreaterThan(0); // case is meaningful

      expect(byKey(agg.top_brands, (r) => r.brand_id, (r) => r.count)).toEqual(exp.brands);
      expect(byKey(agg.top_providers, (r) => r.provider_id, (r) => r.count)).toEqual(exp.providers);
      expect(byKey(agg.top_campaigns, (r) => r.campaign_id, (r) => [r.threat_count, r.brand_count]))
        .toEqual(Object.fromEntries(Object.entries(exp.campaigns).map(([k, v]) => [k, [v.threats, v.brands]])));
      expect(byKey(agg.multi_brand_campaigns, (r) => r.id, (r) => [r.threat_count, r.brand_count]))
        .toEqual(Object.fromEntries(Object.entries(exp.mbCampaigns).map(([k, v]) => [k, [v.threats, v.brands]])));
      expect(byKey(agg.multi_brand_providers, (r) => r.id, (r) => [r.threat_count, r.brand_count]))
        .toEqual(Object.fromEntries(Object.entries(exp.mbProviders).map(([k, v]) => [k, [v.threats, v.brands]])));

      // Joined columns come through (the JOIN actually bound the right table).
      for (const b of agg.top_brands) expect(b.brand_name).toBe(BRAND_NAME[b.brand_id]);
      for (const p of agg.top_providers) expect(p.name).toBe(PROVIDER_NAME[p.provider_id]);
      for (const k of agg.top_campaigns) expect(k.name).toBe(CAMPAIGN_NAME[k.campaign_id]);
    });
  }

  it("no-filter baseline pins concrete numbers (guards the oracle itself)", async () => {
    const db = seedDb();
    const env = { DB: d1FromSqlite(db), CACHE: fakeKv() } as unknown as Env;
    const agg = await threatAggregate(env, {});
    expect(agg.total).toBe(7);
    expect(byKey(agg.top_brands, (r) => r.brand_id, (r) => r.count)).toEqual({ b1: 3, b2: 2, b3: 2 });
    expect(byKey(agg.multi_brand_campaigns, (r) => r.id, (r) => r.brand_count)).toEqual({ c1: 2, c2: 2 });
    expect(byKey(agg.multi_brand_providers, (r) => r.id, (r) => r.brand_count)).toEqual({ p1: 2, p2: 2, p3: 2 });
  });

  it("filter excludes out-of-slice entities (brand/provider/campaign absent)", async () => {
    const db = seedDb();
    const env = { DB: d1FromSqlite(db), CACHE: fakeKv() } as unknown as Env;
    // severity=critical -> only t3 (b3,p2,c2) and t6 (b3,p3,no campaign)
    const agg = await threatAggregate(env, { severity: "critical" });
    expect(agg.top_brands.map((b) => b.brand_id)).toEqual(["b3"]);
    expect(agg.top_providers.map((p) => p.provider_id).sort()).toEqual(["p2", "p3"]);
    expect(agg.top_campaigns.map((k) => k.campaign_id)).toEqual(["c2"]);
    expect(agg.multi_brand_campaigns).toEqual([]);   // single brand in this slice
    expect(agg.multi_brand_providers).toEqual([]);
  });

  it("org scope never leaks a brand outside brand_ids into any leaderboard", async () => {
    const db = seedDb();
    const env = { DB: d1FromSqlite(db), CACHE: fakeKv() } as unknown as Env;
    const agg = await threatAggregate(env, {}, { org_id: 7, brand_ids: ["b3"] });
    expect(agg.total).toBe(2);
    expect(agg.top_brands.map((b) => b.brand_id)).toEqual(["b3"]);
    expect(agg.top_campaigns.map((k) => k.campaign_id)).toEqual(["c2"]);
    expect(agg.multi_brand_campaigns).toEqual([]);
  });

  it("actor_id with duplicate infrastructure rows for one ASN counts each threat once", async () => {
    const db = seedDb();
    // A second ta1 row on the same ASN (e.g. another ip_range) — no unique
    // (threat_actor_id, asn) constraint exists, so this is valid data.
    db.prepare("INSERT INTO threat_actor_infrastructure (id, threat_actor_id, asn) VALUES ('tai_dup', 'ta1', ?)")
      .run(ACTOR_ASN.ta1);
    const env = { DB: d1FromSqlite(db), CACHE: fakeKv() } as unknown as Env;
    const agg = await threatAggregate(env, { actor_id: "ta1" });
    const exp = expected(SEEDS.filter((s) => s.asn === ACTOR_ASN.ta1));
    expect(agg.total).toBe(exp.total);
    expect(byKey(agg.top_brands, (r) => r.brand_id, (r) => r.count)).toEqual(exp.brands);
    expect(byKey(agg.top_providers, (r) => r.provider_id, (r) => r.count)).toEqual(exp.providers);
  });

  it("empty org scope short-circuits to an empty aggregate without querying", async () => {
    const db = seedDb();
    const log: StatementLogEntry[] = [];
    const env = { DB: d1FromSqlite(db, { log }), CACHE: fakeKv() } as unknown as Env;
    const agg = await threatAggregate(env, {}, { org_id: 7, brand_ids: [] });
    expect(agg.total).toBe(0);
    expect(agg.top_brands).toEqual([]);
    expect(log).toHaveLength(0);
  });
});
