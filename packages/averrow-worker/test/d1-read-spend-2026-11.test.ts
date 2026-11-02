/**
 * D1 read-spend fixes, 2026-11 part A (primary DB at ~714M rows read / 24h).
 *
 *   #1 idx_threats_first_seen (migration 0312). Migration 0013 rebuilt
 *      `threats` and never re-created 0001's first_seen index, so every
 *      `first_seen >= datetime('now', …)` filter without a first_seen-keyed
 *      partial index full-scanned ~1.51M rows.
 *   #2 idx_brands_enrich_pending (migration 0313) for Flight Control's
 *      `backlog.brand_enrich` COUNT(*), which full-scanned ~132K brands.
 *   #3 idx_brands_worst_email_posture (migration 0314) for the
 *      email-security worst_brands list (full scan + sort of brands).
 *
 * Plans are taken against `openMigratedDb()`: every migration applied in
 * order, tables and indexes, including 0013's table rebuild. That
 * reproduces prod's missing index faithfully. Each "after" assertion runs
 * twice: without table stats, and after ANALYZE over a seeded,
 * prod-proportioned table (most rows older than the query window).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, sqlContaining, type SqliteDb } from "./sqlite-d1-harness";

const ROOT = resolve(__dirname, "..");
const src = (rel: string): string => readFileSync(resolve(ROOT, "src", rel), "utf8");

function plan(db: SqliteDb, sql: string): string[] {
  const n = (sql.match(/\?/g) ?? []).length;
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill(null)) as Array<{ detail: string }>)
    .map((r) => r.detail);
}

const hasIndex = (db: SqliteDb, name: string): boolean =>
  (db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").all(name) as unknown[]).length === 1;

/** ~1 year of threats; 0.3% in the last 24h, ~2% in the last 7 days. */
function seedThreats(db: SqliteDb): void {
  db.exec("BEGIN");
  const b = db.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES (?, ?, ?)");
  for (let i = 0; i < 600; i++) b.run(`b${i}`, `Brand ${i % 580}`, `b${i}.com`); // some shared names
  const t = db.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, ioc_value, malicious_domain, malicious_url, ip_address,
       severity, status, target_brand_id, first_seen, created_at, last_seen,
       gsb_checked, dbl_checked, seclookup_checked, abuseipdb_checked, greynoise_checked, pdns_checked, vt_checked, surbl_checked)
     VALUES (?, 'feed', 'phishing', ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?), datetime('now', ?),
       ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 20_000; i++) {
    const hours = i < 60 ? -(i % 24) : i < 400 ? -(24 + (i % 144)) : -(168 + (i % 8592));
    const off = `${hours} hours`;
    const c = i % 3 === 0 ? 0 : 1;
    t.run(`t${i}`, `ioc${i}`, i % 5 ? `d${i}.com` : null, i % 2 ? `http://d${i}.com/x` : null,
      i % 3 ? `10.0.${i % 250}.${i % 7}` : null, ["critical", "high", "medium", "low"][i % 4]!,
      i % 10 ? "active" : "remediated", i % 4 ? `b${i % 600}` : null, off, off, off,
      c, c, c, c, c, c, c, c);
  }
  db.exec("COMMIT");
  db.exec("ANALYZE");
}

const VARIANTS: Array<[string, (db: SqliteDb) => void]> = [
  ["without table stats", () => {}],
  ["with ANALYZE stats", seedThreats],
];

// ─── #1 idx_threats_first_seen ──────────────────────────────────────

const observerEnrichmentSql = sqlContaining(src("agents/observer.ts"), ["surbl_confirmed_today", "FROM threats"]);
const briefingTopBrandsSql = sqlContaining(src("handlers/briefing.ts"), ["threats_24h", "FROM threats t JOIN brands b"]);

describe.skipIf(!hasSqlite())("#1 migration 0312 restores idx_threats_first_seen", () => {
  it("0312 re-creates the index with 0001's name and definition", () => {
    const sql = readFileSync(resolve(ROOT, "migrations/0312_threats_first_seen_index.sql"), "utf8");
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_threats_first_seen ON threats\(first_seen DESC\);/);
    expect(readFileSync(resolve(ROOT, "migrations/0001_core_tables.sql"), "utf8"))
      .toMatch(/CREATE INDEX idx_threats_first_seen ON threats\(first_seen DESC\);/);
  });

  it("migration 0013's table rebuild is what removed it (baseline mirrors pre-0312 prod)", () => {
    expect(hasIndex(openMigratedDb(), "idx_threats_first_seen")).toBe(true);
    // Without 0312 the index does not exist: 0013 dropped `threats` and
    // re-created only four of 0001's indexes.
    expect(hasIndex(openMigratedDb({ exclude: ["0312_threats_first_seen_index.sql"] }), "idx_threats_first_seen"))
      .toBe(false);
    const m0013 = readFileSync(resolve(ROOT, "migrations/0013_new_feeds_and_threat_types.sql"), "utf8");
    expect(m0013).toMatch(/DROP TABLE threats;/);
    expect(m0013).not.toMatch(/idx_threats_first_seen/);
  });

  it("baseline: without the index both hot queries full-scan threats", () => {
    const db = openMigratedDb();
    db.exec("DROP INDEX idx_threats_first_seen");
    expect(plan(db, observerEnrichmentSql)).toContain("SCAN threats");
    // Pre-0312 the briefing join drove from brands and probed a brand
    // index per brand; with the brand index neutralised it is a SCAN.
    expect(plan(db, briefingTopBrandsSql)).toContain("SCAN t");
  });

  for (const [label, prep] of VARIANTS) {
    describe(label, () => {
      const db = openMigratedDb();
      prep(db);

      it("observer enrichment summary range-SEARCHes the first_seen index", () => {
        const p = plan(db, observerEnrichmentSql);
        expect(p.join(" | ")).toMatch(/SEARCH threats USING INDEX idx_threats_first_seen \(first_seen>\?\)/);
        expect(p.some((d) => /^SCAN threats\b/.test(d))).toBe(false);
      });

      it("briefing threats_24h drives from the first_seen range and PK-probes brands", () => {
        const p = plan(db, briefingTopBrandsSql);
        expect(p[0]).toMatch(/^SEARCH t USING INDEX idx_threats_first_seen \(first_seen>\?\)/);
        expect(p.join(" | ")).toMatch(/SEARCH b USING INDEX sqlite_autoindex_brands_1 \(id=\?\)/);
        expect(p.some((d) => /^SCAN (t|b|threats|brands)\b/.test(d))).toBe(false);
      });

      // The first_seen-keyed partial work-queue indexes must keep winning
      // their own queries now that a full first_seen index competes.
      const PARTIAL_PINS: Array<[string, string, string[]]> = [
        ["idx_threats_gsb_pending", "feeds/googleSafeBrowsing.ts", ["gsb_checked = 0", "FROM threats"]],
        ["idx_threats_gsb_pending", "agents/flightControl.ts", ["gsb_checked = 0", "COUNT(*)"]],
        ["idx_threats_dbl_pending", "feeds/spamhausDbl.ts", ["dbl_checked = 0", "FROM threats"]],
        ["idx_threats_dbl_pending", "agents/flightControl.ts", ["dbl_checked = 0", "COUNT(*)"]],
        ["idx_threats_seclookup_pending", "feeds/seclookup.ts", ["seclookup_checked = 0", "FROM threats"]],
        ["idx_threats_seclookup_pending", "agents/flightControl.ts", ["seclookup_checked = 0", "COUNT(*)"]],
        ["idx_threats_abuseipdb_pending", "feeds/abuseipdb.ts", ["abuseipdb_checked = 0", "FROM threats"]],
        ["idx_threats_abuseipdb_pending", "agents/flightControl.ts", ["abuseipdb_checked = 0", "COUNT(*)"]],
        ["idx_threats_greynoise_pending", "feeds/greynoise.ts", ["greynoise_checked = 0", "FROM threats"]],
        ["idx_threats_greynoise_pending", "agents/flightControl.ts", ["greynoise_checked = 0", "COUNT(*)"]],
        ["idx_threats_pdns_pending", "feeds/circlPassiveDns.ts", ["pdns_checked = 0", "FROM threats"]],
        ["idx_threats_pdns_pending", "agents/flightControl.ts", ["pdns_checked = 0", "COUNT(*)"]],
        ["idx_threats_analyst_backlog", "agents/flightControl.ts", ["COUNT(DISTINCT target_brand_id)", "first_seen"]],
      ];
      for (const [idx, file, markers] of PARTIAL_PINS) {
        it(`${file} [${markers[0]}] keeps ${idx}`, () => {
          const p = plan(db, sqlContaining(src(file), markers));
          expect(p.join(" | ")).toMatch(new RegExp(`SEARCH threats USING (COVERING )?INDEX ${idx} \\(first_seen>\\?\\)`));
        });
      }
    });
  }

  it("briefing threats_24h rewrite returns the same rows as the former join", () => {
    const db = openMigratedDb();
    seedThreats(db);
    const former = `SELECT b.name, COUNT(*) as threats_24h
       FROM threats t JOIN brands b ON t.target_brand_id = b.id
       WHERE t.first_seen >= datetime('now', '-24 hours') AND t.target_brand_id IS NOT NULL
       GROUP BY b.name ORDER BY threats_24h DESC LIMIT 10`;
    const now = db.prepare(briefingTopBrandsSql).all();
    expect(now.length).toBeGreaterThan(0);
    expect(now).toEqual(db.prepare(former).all());
  });
});

// ─── #2 idx_brands_enrich_pending ───────────────────────────────────

const brandEnrichSql = sqlContaining(src("agents/flightControl.ts"), ["FROM brands", "enriched_at IS NULL"]);

describe.skipIf(!hasSqlite())("#2 backlog.brand_enrich uses idx_brands_enrich_pending (migration 0313)", () => {
  function seedBrands(db: SqliteDb): void {
    db.exec("BEGIN");
    const b = db.prepare("INSERT INTO brands (id, name, canonical_domain, enriched_at) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 10_000; i++) b.run(`b${i}`, `B${i}`, `b${i}.com`, i % 10 ? "2026-01-01 00:00:00" : null);
    db.exec("COMMIT");
    db.exec("ANALYZE");
  }

  it("baseline: without the index the count full-scans brands", () => {
    const db = openMigratedDb();
    db.exec("DROP INDEX idx_brands_enrich_pending");
    expect(plan(db, brandEnrichSql)).toContain("SCAN brands");
  });

  for (const [label, prep] of [["without table stats", () => {}], ["with ANALYZE stats", seedBrands]] as const) {
    it(`is a covering SEARCH on the partial index (${label})`, () => {
      const db = openMigratedDb();
      prep(db);
      const p = plan(db, brandEnrichSql);
      expect(p.join(" | ")).toMatch(/SEARCH brands USING COVERING INDEX idx_brands_enrich_pending \(enriched_at=\?\)/);
      expect(p.some((d) => /^SCAN brands\b/.test(d))).toBe(false);
    });
  }

  it("counts the same rows as the unindexed query", () => {
    const db = openMigratedDb();
    seedBrands(db);
    const viaIndex = db.prepare(brandEnrichSql).get() as { count: number };
    const viaTable = db.prepare(brandEnrichSql.replace("FROM brands", "FROM brands NOT INDEXED")).get() as { count: number };
    expect(viaIndex.count).toBeGreaterThanOrEqual(1000); // + any rows seeded by migrations
    expect(viaIndex.count).toBe(viaTable.count);
  });

  it("the admin backfill-brand-enrichment count also qualifies for the index", () => {
    const db = openMigratedDb();
    const sql = sqlContaining(src("handlers/admin/backfills.ts"), ["SELECT COUNT(*) as n FROM brands", "enriched_at IS NULL"]);
    expect(plan(db, sql).join(" | ")).toMatch(/idx_brands_enrich_pending/);
  });
});

// ─── #3 idx_brands_worst_email_posture ──────────────────────────────

const worstBrandsSql = sqlContaining(src("handlers/emailSecurity.ts"), ["FROM brands b", "email_security_grade IN ('F', 'D', 'C')"]);

describe.skipIf(!hasSqlite())("#3 worst_brands uses idx_brands_worst_email_posture (migration 0314)", () => {
  const GRADES = ["A+", "A", "B", "C", "D", "F"];
  function seedScored(db: SqliteDb): void {
    db.exec("BEGIN");
    const b = db.prepare(
      "INSERT INTO brands (id, name, canonical_domain, email_security_score, email_security_grade) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 10_000; i++) {
      const scored = i % 4 !== 0;
      // Distinct, shuffled scores (7919·i mod prime 10007 is a bijection for
      // i < 10007) so the LIMIT-200 cutoff never lands inside a tie and the
      // id-set comparison below doesn't depend on SQLite's tie-break order.
      b.run(`w${i}`, `W${i}`, `w${i}.com`, scored ? ((i * 7919) % 10007) / 100 : null, scored ? GRADES[i % GRADES.length]! : null);
    }
    db.exec("COMMIT");
    db.exec("ANALYZE");
  }

  it("baseline: without the index the list scans brands and sorts", () => {
    const db = openMigratedDb({ exclude: ["0314_brands_worst_email_posture_index.sql"] });
    const p = plan(db, worstBrandsSql).join(" | ");
    expect(p).toMatch(/SCAN b\b/);
    expect(p).toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  for (const [label, prep] of [["without table stats", () => {}], ["with ANALYZE stats", seedScored]] as const) {
    it(`walks the partial index in score order, no sort (${label})`, () => {
      const db = openMigratedDb();
      prep(db);
      const p = plan(db, worstBrandsSql).join(" | ");
      expect(p).toMatch(/(SCAN|SEARCH) b USING INDEX idx_brands_worst_email_posture/);
      expect(p).not.toMatch(/TEMP B-TREE/);
    });
  }

  it("returns the same rows, in the same order, as the unindexed query", () => {
    const db = openMigratedDb();
    seedScored(db);
    const viaIndex = db.prepare(worstBrandsSql).all() as Array<{ id: string; email_security_score: number }>;
    const viaTable = db.prepare(worstBrandsSql.replace("FROM brands b", "FROM brands b NOT INDEXED")).all() as typeof viaIndex;
    expect(viaIndex.length).toBe(200);
    expect(viaIndex.map((r) => r.email_security_score)).toEqual(viaTable.map((r) => r.email_security_score));
    expect(new Set(viaIndex.map((r) => r.id))).toEqual(new Set(viaTable.map((r) => r.id)));
  });
});
