// D1 read-spend, part B (2026-11):
//
//  Fix 2 — email-security posture. /api/email-security/stats, the Brands
//          Intel email aggregate and Observer derive from ONE cached
//          GROUP BY over `brands` (lib/email-posture-rollup.ts); the stats
//          payload TTL is 1h. Pinned: derived values equal the old
//          per-surface queries on a seeded SQLite, cache keys/TTLs, and the
//          rollup scan runs once across all surfaces.
//
//  Fix 4 — analyst Phase 3.5 enrichment aggregates are loaded only for the
//          ≤5 brands the run reports on (lib/analyst-brand-enrichment.ts),
//          one indexed single-pass statement per brand, 3h per-brand cache.
//          Pinned: values equal the old seven catalog-wide queries, binds
//          are the requested brand ids only, the plan seeks
//          idx_threats_brand_status, and analyst.ts no longer carries the
//          catalog-wide scans.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasSqlite, openDerivedDb, openMigratedDb, d1FromSqlite, fakeKv,
  type SqliteDb, type StatementLogEntry,
} from "./sqlite-d1-harness";
import {
  EMAIL_POSTURE_ROLLUP_KEY, EMAIL_POSTURE_ROLLUP_TTL_S, EMAIL_POSTURE_ROLLUP_SQL,
  emailPostureRollup, gradeDistributionByCount,
} from "../src/lib/email-posture-rollup";
import {
  emailSecurityStatsPayload, EMAIL_SECURITY_STATS_KEY, EMAIL_SECURITY_STATS_TTL_S,
} from "../src/handlers/emailSecurity";
import { emailSecurityAggregate } from "../src/lib/brand-aggregates";
import {
  loadBrandEnrichment, BRAND_ENRICHMENT_SQL, BRAND_ENRICHMENT_TTL_S, brandEnrichmentCacheKey,
  type BrandEnrichment,
} from "../src/lib/analyst-brand-enrichment";
import type { Env } from "../src/types";

const SRC = resolve(__dirname, "..", "src");
const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");

function makeEnv(raw: SqliteDb, log: StatementLogEntry[]): Env & { CACHE: ReturnType<typeof fakeKv> } {
  const d1 = d1FromSqlite(raw, { log });
  return { DB: d1, CACHE: fakeKv() } as unknown as Env & { CACHE: ReturnType<typeof fakeKv> };
}

const all = <T>(raw: SqliteDb, sql: string, ...b: unknown[]): T[] => raw.prepare(sql).all(...b) as T[];

// ─── Fix 2 ────────────────────────────────────────────────────────

/** Brands seed: [grade, dmarc_policy, score] → repeated n times. Counts are
 *  distinct per bucket so ORDER BY count DESC has no ties. */
const BRAND_SEED: Array<[string | null, string | null, number | null, number]> = [
  ["A+", "reject", 97, 3],
  ["A", "reject", 91, 5],
  ["A", "quarantine", 88, 2],
  ["B", "quarantine", 77, 7],
  ["C", "none", 61, 4],
  ["C", null, 58, 1],
  ["D", "none", 42, 6],
  ["F", null, 12, 9],
  ["F", "none", 18, 8],
  ["A-", "reject", 90, 10], // grade outside the stats CASE list (ELSE bucket)
  [null, null, null, 13],   // never scanned
  ["B", null, null, 11],    // graded but no score (legacy row)
];

function seedBrands(raw: SqliteDb): void {
  const ins = raw.prepare(
    `INSERT INTO brands (id, name, canonical_domain, email_security_grade, email_security_dmarc_policy,
       email_security_score, active_threat_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let i = 0;
  for (const [grade, policy, score, n] of BRAND_SEED) {
    for (let k = 0; k < n; k++) {
      i++;
      ins.run(`b${i}`, `Brand ${i}`, `brand${i}.com`, grade, policy, score === null ? null : score + (k % 3), i % 4);
    }
  }
}

describe.skipIf(!hasSqlite())("fix 2 — shared email-posture rollup", () => {
  let raw: SqliteDb;
  let log: StatementLogEntry[];
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    raw = openDerivedDb(["brands"]);
    seedBrands(raw);
    log = [];
    env = makeEnv(raw, log);
  });

  it("stats payload equals the old per-query results", async () => {
    const data = await emailSecurityStatsPayload(env);

    const oldGrades = all<{ grade: string; count: number }>(raw, `
      SELECT email_security_grade AS grade, COUNT(*) AS count FROM brands
      WHERE email_security_grade IS NOT NULL GROUP BY email_security_grade
      ORDER BY CASE grade WHEN 'A+' THEN 1 WHEN 'A' THEN 2 WHEN 'B' THEN 3
        WHEN 'C' THEN 4 WHEN 'D' THEN 5 WHEN 'F' THEN 6 ELSE 7 END`);
    const oldDmarc = all<{ dmarc_policy: string | null; count: number }>(raw, `
      SELECT email_security_dmarc_policy AS dmarc_policy, COUNT(*) AS count FROM brands
      WHERE email_security_score IS NOT NULL GROUP BY email_security_dmarc_policy`);
    const [{ n: scanned }] = all<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM brands WHERE email_security_score IS NOT NULL");
    const [{ n: unscanned }] = all<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM brands WHERE email_security_score IS NULL");
    const [{ avg }] = all<{ avg: number | null }>(raw, "SELECT AVG(email_security_score) AS avg FROM brands WHERE email_security_score IS NOT NULL");
    const oldWorst = all(raw, `
      SELECT b.id, b.name, b.canonical_domain, b.email_security_score, b.email_security_grade,
             b.active_threat_count AS active_threats
      FROM brands b WHERE b.email_security_score IS NOT NULL AND b.email_security_grade IN ('F', 'D', 'C')
      ORDER BY b.email_security_score ASC LIMIT 200`);

    expect(data.grade_distribution).toEqual(oldGrades.map((r) => ({ ...r })));
    expect(data.dmarc_distribution).toEqual(oldDmarc.map((r) => ({ ...r })));
    expect(data.total_scanned).toBe(scanned);
    expect(data.total_unscanned).toBe(unscanned);
    expect(data.average_score).toBe(Math.round(avg ?? 0));
    expect(data.worst_brands).toEqual(oldWorst.map((r) => ({ ...(r as object) })));
    expect(Object.keys(data).sort()).toEqual([
      "average_score", "dmarc_distribution", "grade_distribution", "total_scanned", "total_unscanned", "worst_brands",
    ]);
  });

  it("Brands Intel email aggregate equals the old queries", async () => {
    const agg = await emailSecurityAggregate(env);
    const oldGrades = all<{ grade: string; count: number }>(raw, `
      SELECT email_security_grade AS grade, COUNT(*) AS count FROM brands
      WHERE email_security_grade IS NOT NULL GROUP BY email_security_grade
      ORDER BY CASE email_security_grade
        WHEN 'A+' THEN 0 WHEN 'A' THEN 1 WHEN 'A-' THEN 2 WHEN 'B+' THEN 3 WHEN 'B' THEN 4 WHEN 'B-' THEN 5
        WHEN 'C+' THEN 6 WHEN 'C' THEN 7 WHEN 'C-' THEN 8 WHEN 'D+' THEN 9 WHEN 'D' THEN 10 WHEN 'D-' THEN 11
        WHEN 'F' THEN 12 ELSE 13 END`);
    const [totals] = all<{ graded: number; ungraded: number }>(raw, `
      SELECT SUM(CASE WHEN email_security_grade IS NOT NULL THEN 1 ELSE 0 END) AS graded,
             SUM(CASE WHEN email_security_grade IS NULL THEN 1 ELSE 0 END) AS ungraded FROM brands`);
    const oldDmarc = all<{ policy: string; count: number }>(raw, `
      SELECT COALESCE(email_security_dmarc_policy, 'none') AS policy, COUNT(*) AS count FROM brands
      WHERE email_security_score IS NOT NULL GROUP BY policy ORDER BY count DESC`);

    expect(agg.grade_distribution).toEqual(oldGrades.map((r) => ({ ...r })));
    expect(agg.total_graded).toBe(totals.graded);
    expect(agg.ungraded).toBe(totals.ungraded);
    expect(agg.dmarc_distribution).toEqual(oldDmarc.map((r) => ({ ...r })));
    expect(agg.dmarc_enforcing).toBe(
      oldDmarc.filter((r) => r.policy === "quarantine" || r.policy === "reject").reduce((s, r) => s + r.count, 0));
  });

  it("Observer's count-ordered grade distribution equals its old query", async () => {
    const got = gradeDistributionByCount(await emailPostureRollup(env));
    const old = all<{ grade: string; count: number }>(raw, `
      SELECT email_security_grade AS grade, COUNT(*) AS count FROM brands
      WHERE email_security_grade IS NOT NULL GROUP BY email_security_grade ORDER BY count DESC`);
    expect(got).toEqual(old.map((r) => ({ ...r })));
  });

  it("one rollup scan serves stats + Brands Intel; repeat reads are KV hits", async () => {
    await emailSecurityStatsPayload(env);
    await emailSecurityAggregate(env);
    await emailPostureRollup(env);
    await emailSecurityStatsPayload(env);

    const rollupScans = log.filter((e) => e.sql === EMAIL_POSTURE_ROLLUP_SQL);
    expect(rollupScans).toHaveLength(1);
    // Two reads total: the rollup + the worst-brands list, once each.
    expect(log).toHaveLength(2);
    expect(env.CACHE.store.has(`cv:${EMAIL_POSTURE_ROLLUP_KEY}`)).toBe(true);
    expect(env.CACHE.store.has(`cv:${EMAIL_SECURITY_STATS_KEY}`)).toBe(true);
  });

  it("cache contract: stats key unchanged, TTLs in the 30–60 min band", () => {
    expect(EMAIL_SECURITY_STATS_KEY).toBe("email_security_stats");
    for (const ttl of [EMAIL_SECURITY_STATS_TTL_S, EMAIL_POSTURE_ROLLUP_TTL_S]) {
      expect(ttl).toBeGreaterThanOrEqual(1800);
      expect(ttl).toBeLessThanOrEqual(3600);
    }
    // Longer than Navigator's 15-min Phase B admin-dashboard warm, which
    // reaches this payload through handleAdminDashboard.
    expect(EMAIL_SECURITY_STATS_TTL_S).toBeGreaterThan(900);
  });

  it("no surface keeps its own grade/DMARC/COUNT scan of brands", () => {
    const stats = read("handlers/emailSecurity.ts");
    expect(stats).not.toMatch(/count\.brands\.email_(un)?scored/);
    expect(stats).not.toMatch(/AVG\(email_security_score\)/);
    expect(stats).not.toMatch(/GROUP BY email_security_grade/);
    expect(read("lib/brand-aggregates.ts")).not.toMatch(/GROUP BY email_security_grade/);
    expect(read("agents/observer.ts")).not.toMatch(/GROUP BY email_security_grade/);
  });
});

// ─── Fix 4 ────────────────────────────────────────────────────────

interface ThreatSeed {
  brand: string | null; status?: string;
  surbl?: number; vt?: number | null; gsb?: number; dbl?: number;
  gnChecked?: number; gnNoise?: number | null; gnClass?: string | null;
  slChecked?: number; slScore?: number | null;
}

const THREATS: ThreatSeed[] = [
  { brand: "x1", surbl: 1, vt: 3, gsb: 1, gnChecked: 1, gnNoise: 1, gnClass: "benign", slChecked: 1, slScore: 85 },
  { brand: "x1", vt: 4, dbl: 1, gnChecked: 1, gnNoise: 0, slChecked: 1, slScore: 40 },
  { brand: "x1", vt: 0, gnChecked: 1, gnNoise: 1, gnClass: "malicious" },
  { brand: "x1", vt: 8, status: "down", surbl: 1 },          // not active: excluded
  { brand: "x2", vt: null, gsb: 1 },
  { brand: "x2", dbl: 1, slChecked: 1, slScore: 95 },
  { brand: "x3", vt: 2 },
  { brand: "x3", vt: 5, surbl: 1 },
  { brand: "x4", status: "down", vt: 9 },                   // only non-active → absent
  { brand: null, vt: 7, surbl: 1 },                              // unlinked
];

function seedThreats(raw: SqliteDb): void {
  const ins = raw.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, target_brand_id, status, severity,
       surbl_listed, vt_malicious, gsb_flagged, dbl_listed, greynoise_checked, greynoise_noise,
       greynoise_classification, seclookup_checked, seclookup_risk_score, created_at, first_seen, last_seen)
     VALUES (?, 'openphish', 'phishing', ?, ?, ?, 'high', ?, ?, ?, ?, ?, ?, ?, ?, ?,
       '2026-10-30 00:00:00', '2026-10-30 00:00:00', '2026-10-30 00:00:00')`,
  );
  THREATS.forEach((t, i) => ins.run(
    `t${i}`, `evil${i}.example`, t.brand, t.status ?? "active",
    t.surbl ?? 0, t.vt === undefined ? 0 : t.vt, t.gsb ?? 0, t.dbl ?? 0,
    t.gnChecked ?? 0, t.gnNoise ?? null, t.gnClass ?? null, t.slChecked ?? 0, t.slScore ?? null,
  ));
}

/** The seven catalog-wide queries + pivot analyst.ts used to run. */
function oldEnrichment(raw: SqliteDb): Map<string, BrandEnrichment> {
  const base = "status = 'active' AND target_brand_id IS NOT NULL";
  const m = new Map<string, BrandEnrichment>();
  const get = (bid: string): BrandEnrichment => {
    let e = m.get(bid);
    if (!e) {
      e = { target_brand_id: bid, surbl_confirmed: 0, vt_flagged: 0, vt_avg_malicious: null, gsb_confirmed: 0,
        dbl_confirmed: 0, noise_scanners: 0, potentially_targeted: 0, seclookup_high_risk: 0 };
      m.set(bid, e);
    }
    return e;
  };
  type C = { target_brand_id: string; cnt: number };
  for (const r of all<C>(raw, `SELECT target_brand_id, COUNT(*) as cnt FROM threats WHERE ${base} AND surbl_listed = 1 GROUP BY target_brand_id`)) get(r.target_brand_id).surbl_confirmed = r.cnt;
  for (const r of all<C>(raw, `SELECT target_brand_id, COUNT(*) as cnt FROM threats WHERE ${base} AND vt_malicious > 0 GROUP BY target_brand_id`)) get(r.target_brand_id).vt_flagged = r.cnt;
  for (const r of all<{ target_brand_id: string; avg_mal: number | null }>(raw, `SELECT target_brand_id, ROUND(AVG(vt_malicious), 1) as avg_mal FROM threats WHERE ${base} AND vt_malicious > 0 GROUP BY target_brand_id`)) get(r.target_brand_id).vt_avg_malicious = r.avg_mal;
  for (const r of all<C>(raw, `SELECT target_brand_id, COUNT(*) as cnt FROM threats WHERE ${base} AND gsb_flagged = 1 GROUP BY target_brand_id`)) get(r.target_brand_id).gsb_confirmed = r.cnt;
  for (const r of all<C>(raw, `SELECT target_brand_id, COUNT(*) as cnt FROM threats WHERE ${base} AND dbl_listed = 1 GROUP BY target_brand_id`)) get(r.target_brand_id).dbl_confirmed = r.cnt;
  for (const r of all<{ target_brand_id: string; noise_scanners: number; potentially_targeted: number }>(raw, `SELECT target_brand_id,
      SUM(CASE WHEN greynoise_noise = 1 AND greynoise_classification = 'benign' THEN 1 ELSE 0 END) as noise_scanners,
      SUM(CASE WHEN greynoise_noise = 0 THEN 1 ELSE 0 END) as potentially_targeted
      FROM threats WHERE ${base} AND greynoise_checked = 1 GROUP BY target_brand_id`)) {
    const e = get(r.target_brand_id); e.noise_scanners = r.noise_scanners; e.potentially_targeted = r.potentially_targeted;
  }
  for (const r of all<{ target_brand_id: string; high_risk: number }>(raw, `SELECT target_brand_id, SUM(CASE WHEN seclookup_risk_score >= 80 THEN 1 ELSE 0 END) as high_risk
      FROM threats WHERE ${base} AND seclookup_checked = 1 GROUP BY target_brand_id`)) get(r.target_brand_id).seclookup_high_risk = r.high_risk;
  return m;
}

/** Phase 3.5's "has any signal" gate — decides whether an insight is written. */
const hasSignal = (e: BrandEnrichment | undefined): boolean => !!e && (e.surbl_confirmed > 0 || e.vt_flagged > 0
  || e.gsb_confirmed > 0 || e.dbl_confirmed > 0 || e.noise_scanners > 0 || e.potentially_targeted > 0 || e.seclookup_high_risk > 0);

describe.skipIf(!hasSqlite())("fix 4 — analyst enrichment scoped to the reported brands", () => {
  let raw: SqliteDb;
  let log: StatementLogEntry[];
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    raw = openDerivedDb(["threats"]);
    seedThreats(raw);
    log = [];
    env = makeEnv(raw, log);
  });

  it("single-pass per-brand values equal the old seven catalog-wide queries", async () => {
    const ids = ["x1", "x2", "x3", "x4", "nope"];
    const got = await loadBrandEnrichment(env, ids);
    const old = oldEnrichment(raw);
    for (const bid of ids) {
      const g = got.get(bid);
      const o = old.get(bid);
      expect(hasSignal(g), bid).toBe(hasSignal(o));
      if (hasSignal(o)) expect({ ...g }, bid).toEqual(o);
    }
    expect(got.get("x1")).toMatchObject({ surbl_confirmed: 1, vt_flagged: 2, vt_avg_malicious: 3.5,
      gsb_confirmed: 1, dbl_confirmed: 1, noise_scanners: 1, potentially_targeted: 1, seclookup_high_risk: 1 });
    expect(got.get("x2")).toMatchObject({ vt_flagged: 0, vt_avg_malicious: null });
    expect(got.has("x4")).toBe(false); // only non-active threats
  });

  it("binds only the requested brands (deduped), one statement each, cached 3h per brand", async () => {
    await loadBrandEnrichment(env, ["x1", "x3", "x1"]);
    expect(log.map((e) => e.binds)).toEqual([["x1"], ["x3"]]);
    expect(log.every((e) => e.sql === BRAND_ENRICHMENT_SQL)).toBe(true);
    expect(BRAND_ENRICHMENT_TTL_S).toBe(10800);
    expect(env.CACHE.store.has(`cv:${brandEnrichmentCacheKey("x1")}`)).toBe(true);

    // Second run: x1/x3 are KV hits; only the new brand reads D1.
    await loadBrandEnrichment(env, ["x1", "x2", "x3"]);
    expect(log.map((e) => e.binds)).toEqual([["x1"], ["x3"], ["x2"]]);
  });

  it("no brands → no D1 reads", async () => {
    expect((await loadBrandEnrichment(env, [])).size).toBe(0);
    expect(log).toHaveLength(0);
  });

  it("the per-brand statement seeks idx_threats_brand_status on the migrated schema", () => {
    const db = openMigratedDb();
    const plan = all<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${BRAND_ENRICHMENT_SQL}`, "x1")
      .map((r) => r.detail).join(" | ");
    expect(plan).toMatch(/SEARCH threats USING INDEX idx_threats_brand_status \(target_brand_id=\? AND status=\?\)/);
    expect(plan).not.toMatch(/SCAN threats/);
  });

  it("analyst.ts no longer runs the catalog-wide GROUP BY target_brand_id scans", () => {
    const src = read("agents/analyst.ts");
    expect(src).not.toMatch(/analyst\.enrichment_by_brand/);
    expect(src).not.toMatch(/vt_malicious > 0 GROUP BY target_brand_id/);
    expect(src).toMatch(/const enrichmentBrandIds = Array\.from\(matchedBrandIds\)\.slice\(0, 5\);/);
    expect(src).toMatch(/await loadBrandEnrichment\(env, enrichmentBrandIds\)/);
  });
});
