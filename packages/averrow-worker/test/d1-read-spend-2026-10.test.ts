/**
 * D1 read-spend fixes (2026-10, read guard in `skip`: 816M rows/24h vs an
 * 833M/day budget). One block per fix, each against the migration-derived
 * SQLite lane (`sqlite-d1-harness.ts`) so a phantom column fails loudly.
 *
 *   #1 DMARC aggregate reads brands.email_security_dmarc_policy
 *   #2 threat-actor ASN joins seek idx_threats_asn       (migration 0277)
 *   #3 GSB work-queue + backlog seek idx_threats_gsb_pending (migration 0277)
 *   #4 every count.threats.total caller shares THREATS_TOTAL_TTL_S
 *   #5 orchestrator drops the unlinked pre-count; backfill probe is capped;
 *      every multi-round caller stops after a round that matched nothing
 *   #7 brand movers rewrite is equivalent to the correlated-MAX form, and
 *      ignores a newest snapshot day that is still being written
 *
 * (#6, the cartographer stamp TTL, is pinned in
 * cartographer-provider-stats-throttle.test.ts beside the window tests.)
 *
 * Indexes: `migration-schema.ts` deliberately derives table SHAPE only, so
 * the plan tests below replay every migration's CREATE/DROP INDEX for the
 * materialised tables in file order — the planner then sees the same
 * competing indexes production has, not just the new one.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasSqlite,
  openDerivedDb,
  d1FromSqlite,
  fakeKv,
  sqlContaining,
  type SqliteDb,
  type StatementLogEntry,
} from "./sqlite-d1-harness";
import { splitStatements } from "./migration-schema";
import type { Env } from "../src/types";
import {
  emailSecurityAggregate,
  postureAggregate,
  settledSnapshotDay,
  settledThreshold,
  SNAPSHOT_SETTLED_RATIO,
} from "../src/lib/brand-aggregates";
import { threatAggregate, THREAT_AGGREGATE_TTL_S } from "../src/lib/threat-aggregates";
import { THREATS_TOTAL_TTL_S } from "../src/lib/cached-count";
import {
  runBrandMatchBackfill,
  runBrandMatchRounds,
  BRAND_MATCH_BATCH,
  BRAND_MATCH_PENDING_CAP,
} from "../src/handlers/admin/backfills";

const ROOT = resolve(__dirname, "..");
const MIGRATIONS_DIR = resolve(ROOT, "migrations");
const src = (rel: string): string => readFileSync(resolve(ROOT, "src", rel), "utf8");

/** Replay every migration's CREATE/DROP INDEX touching `tables`, in order. */
function replayIndexes(db: SqliteDb, tables: string[]): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    for (const st of splitStatements(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))) {
      const create = st.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(\w+)/i);
      const isDrop = /^DROP\s+INDEX/i.test(st);
      if ((create && tables.includes(create[1]!)) || isDrop) {
        // An index over a column a later migration retired legitimately
        // fails to build here; it would not exist in prod either.
        try { db.exec(st); } catch { /* skip */ }
      }
    }
  }
}

function plan(db: SqliteDb, sql: string, params: unknown[] = []): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((r) => r.detail);
}

function envFor(db: SqliteDb, log?: StatementLogEntry[]): Env {
  return { DB: d1FromSqlite(db, { log }), CACHE: fakeKv() } as unknown as Env;
}

/** YYYY-MM-DD, `n` days before today (UTC — same clock as SQLite date('now')). */
function dayAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

// ─── #1 DMARC aggregate ─────────────────────────────────────────────

describe.skipIf(!hasSqlite())("#1 emailSecurityAggregate DMARC distribution", () => {
  it("reads the denormalized brands column, never email_security_scans", async () => {
    const db = openDerivedDb(["brands"]);
    const ins = db.prepare(
      `INSERT INTO brands (id, name, canonical_domain, email_security_score, email_security_grade, email_security_dmarc_policy)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    ins.run("b1", "One", "one.com", 90, "A", "reject");
    ins.run("b2", "Two", "two.com", 80, "B", "reject");
    ins.run("b3", "Three", "three.com", 60, "C", "quarantine");
    ins.run("b4", "Four", "four.com", 30, "F", "none");
    ins.run("b5", "Five", "five.com", 10, "F", null);    // scanned, no DMARC record
    ins.run("b6", "Six", "six.com", null, null, null);    // never scanned — not counted
    ins.run("b7", "Seven", "seven.com", null, null, "reject"); // stray policy without a scan — not counted

    const log: StatementLogEntry[] = [];
    const agg = await emailSecurityAggregate(envFor(db, log));

    expect(agg.dmarc_distribution.map((r) => r.count)).toEqual([2, 2, 1]); // ORDER BY count DESC
    expect(Object.fromEntries(agg.dmarc_distribution.map((r) => [r.policy, r.count])))
      .toEqual({ reject: 2, quarantine: 1, none: 2 });
    expect(agg.dmarc_enforcing).toBe(3);
    expect(agg.total_graded).toBe(5);
    expect(log.some((e) => /email_security_scans/.test(e.sql))).toBe(false);
    expect(log.every((e) => !e.error)).toBe(true);
  });

  it("caches for 30 min (was 5)", () => {
    expect(src("lib/brand-aggregates.ts")).toMatch(/'brand-aggregate\.email-security', 1800,/);
  });
});

// ─── #2 threat-actor ASN joins ──────────────────────────────────────

const AGG_TABLES = [
  "threats", "brands", "hosting_providers", "campaigns",
  "threat_actors", "threat_actor_infrastructure",
];

function seedThreatAggDb(analyze: boolean): SqliteDb {
  const db = openDerivedDb(AGG_TABLES);
  replayIndexes(db, AGG_TABLES);
  db.prepare("INSERT INTO threat_actors (id, name) VALUES (?, ?)").run("ta1", "Actor One");
  db.prepare("INSERT INTO threat_actors (id, name) VALUES (?, ?)").run("ta2", "Actor Two");
  const tai = db.prepare("INSERT INTO threat_actor_infrastructure (id, threat_actor_id, asn) VALUES (?, ?, ?)");
  tai.run("i1", "ta1", "AS1");
  tai.run("i2", "ta1", "AS2");
  tai.run("i3", "ta2", "AS2"); // shared ASN — COUNT(DISTINCT) vs semi-join must agree
  tai.run("i4", "ta2", null);
  db.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES ('b1','B1','b1.com'), ('b2','B2','b2.com')").run();
  const t = db.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, ioc_value, asn, target_brand_id, status, severity, created_at, first_seen)
     VALUES (?, 'feed', 'phishing', ?, ?, ?, 'active', 'high', datetime('now'), datetime('now'))`,
  );
  const n = analyze ? 3000 : 40;
  for (let i = 0; i < n; i++) {
    const asn = i % 4 === 0 ? null : `AS${i % 200}`;
    t.run(`t${i}`, `ioc${i}`, asn, i % 2 === 0 ? "b1" : "b2");
  }
  if (analyze) db.exec("ANALYZE");
  return db;
}

describe.skipIf(!hasSqlite())("#2 threatAggregate ASN joins use idx_threats_asn", () => {
  for (const analyze of [true, false]) {
    it(`every threat_actor_infrastructure query seeks the index (${analyze ? "with" : "without"} table stats)`, async () => {
      const db = seedThreatAggDb(analyze);
      const log: StatementLogEntry[] = [];
      await threatAggregate(envFor(db, log), {});
      const asnQueries = [...new Set(log.filter((e) => /threat_actor_infrastructure/.test(e.sql)).map((e) => e.sql))];
      // attributed + top_actors + multi_brand_actors
      expect(asnQueries).toHaveLength(3);
      for (const sql of asnQueries) {
        const p = plan(db, sql);
        expect(p.join(" | ")).toMatch(/idx_threats_asn \(asn=\?\)/);
        expect(p.some((d) => /^SCAN (t|threats)\b/.test(d))).toBe(false);
      }
      expect(log.every((e) => !e.error)).toBe(true);
    });
  }

  it("semi-join `attributed` equals the former COUNT(DISTINCT t.id) JOIN form", async () => {
    const db = seedThreatAggDb(false);
    const agg = await threatAggregate(envFor(db), {});
    const old = db.prepare(
      `SELECT COUNT(DISTINCT t.id) AS attributed FROM threats t
       JOIN threat_actor_infrastructure tai_attr ON tai_attr.asn = t.asn`,
    ).all() as Array<{ attributed: number }>;
    expect(agg.attributed).toBe(old[0]!.attributed);
    expect(agg.attributed).toBeGreaterThan(0);
  });

  it("caches the aggregate for 30 min (was 5)", () => {
    expect(THREAT_AGGREGATE_TTL_S).toBe(1800);
    expect(src("lib/threat-aggregates.ts")).toMatch(/cachedValue<ThreatAggregate>\(env, cacheKey, THREAT_AGGREGATE_TTL_S,/);
  });
});

// ─── #3 GSB work-queue + backlog ────────────────────────────────────

describe.skipIf(!hasSqlite())("#3 GSB queries use idx_threats_gsb_pending", () => {
  const db = openDerivedDb(["threats"]);
  replayIndexes(db, ["threats"]);
  // Mirror PROD: migration 0001's idx_threats_first_seen exists in a
  // migration-built schema but was dropped out of band in prod (verified
  // read-only 2026-10-04: prod plans the GSB query as SCAN threats). Left
  // in place, it would let the planner range-seek first_seen without
  // 0277, and this test would pass whether or not the GSB index exists.
  const hadFirstSeenIdx = (db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_threats_first_seen'",
  ).all() as unknown[]).length === 1;
  db.exec("DROP INDEX IF EXISTS idx_threats_first_seen");

  it("the harness had idx_threats_first_seen to drop (prod-mirroring step is live)", () => {
    expect(hadFirstSeenIdx).toBe(true);
  });

  const feedSql = sqlContaining(src("feeds/googleSafeBrowsing.ts"), ["gsb_checked = 0", "FROM threats"]);
  const backlogSql = sqlContaining(src("agents/flightControl.ts"), ["gsb_checked = 0", "COUNT(*)"]);

  for (const [name, sql] of [["feed candidate SELECT", feedSql], ["FC backlog.gsb count", backlogSql]] as const) {
    it(`${name} is a range SEARCH on the partial index`, () => {
      const p = plan(db, sql);
      expect(p.join(" | ")).toMatch(/SEARCH threats USING INDEX idx_threats_gsb_pending \(first_seen>\?\)/);
      expect(p.some((d) => /^SCAN threats\b/.test(d))).toBe(false);
    });
  }

  it("migration 0277 creates both indexes", () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(names).toContain("idx_threats_asn");
    expect(names).toContain("idx_threats_gsb_pending");
  });
});

// ─── #4 count.threats.total TTL ─────────────────────────────────────

describe("#4 count.threats.total shares one TTL constant", () => {
  const CALLERS = [
    "agents/sentinel.ts",
    "handlers/admin/health.ts",
    "handlers/stats.ts",
    "handlers/dashboard.ts",
    "lib/enrichment.ts",
    "lib/platform-milestones.ts",
    "lib/public-stats.ts",
    "handlers/admin/stats.ts",
  ];

  it("is 6h", () => {
    expect(THREATS_TOTAL_TTL_S).toBe(21600);
  });

  for (const file of CALLERS) {
    it(`${file} passes THREATS_TOTAL_TTL_S`, () => {
      expect(src(file)).toMatch(/['"]count\.threats\.total['"], THREATS_TOTAL_TTL_S\b/);
    });
  }

  it("no caller anywhere in src passes a literal TTL for the key", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(resolve(dir, d.name)) : d.name.endsWith(".ts") ? [resolve(dir, d.name)] : []);
    const offenders = walk(resolve(ROOT, "src")).filter((f) => {
      const s = readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");
      return /['"]count\.threats\.total['"],\s*\d/.test(s);
    });
    expect(offenders).toEqual([]);
  });
});

// ─── #5 unlinked-brand pre-count ────────────────────────────────────

describe("#5 orchestrator no longer pre-counts unlinked threats", () => {
  it("has no bare COUNT(*) over target_brand_id IS NULL", () => {
    const orch = src("cron/orchestrator.ts");
    expect(orch).not.toMatch(/COUNT\(\*\)[^"`]*FROM threats WHERE target_brand_id IS NULL/);
    expect(orch).toMatch(/runBrandMatchRounds\(env, 2\)/);
  });

  it("no caller outside backfills.ts hand-rolls a runBrandMatchBackfill loop", () => {
    for (const file of ["cron/orchestrator.ts", "handlers/admin/brand-candidates.ts"]) {
      expect(src(file)).not.toMatch(/runBrandMatchBackfill\(/);
    }
    expect(src("cron/orchestrator.ts")).toMatch(/runBrandMatchRounds\(env, 5\)/);
    expect(src("handlers/admin/brand-candidates.ts")).toMatch(/runBrandMatchRounds\(env, 10\)/);
    expect(src("handlers/admin/backfills.ts")).toMatch(/await runBrandMatchRounds\(env, rounds\)/);
  });
});

function seedBackfillDb(unlinked: number): SqliteDb {
  const db = openDerivedDb(["threats", "brands"]);
  db.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES ('b1', 'Acmeqq', 'acmeqq.com')").run();
  const t = db.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, ioc_value, malicious_domain, created_at)
     VALUES (?, 'feed', 'phishing', ?, ?, datetime('now'))`,
  );
  // Domains no brand fuzzy-matches, so every row stays unlinked.
  for (let i = 0; i < unlinked; i++) t.run(`u${i}`, `zx${i}q.invalid`, `zx${i}q.invalid`);
  return db;
}

describe.skipIf(!hasSqlite())("#5 runBrandMatchBackfill capped pending probe", () => {
  it("no work → one capped probe and nothing else (no brands read)", async () => {
    const db = seedBackfillDb(0);
    const log: StatementLogEntry[] = [];
    const r = await runBrandMatchBackfill(envFor(db, log));
    expect(r).toEqual({ matched: 0, checked: 0, pending: 0, pending_capped: false });
    expect(log).toHaveLength(1);
    expect(log[0]!.sql).toMatch(/SELECT COUNT\(\*\) AS n FROM \(\s*SELECT 1 FROM threats[\s\S]*LIMIT \?\s*\)/);
  });

  it("reports exact pending below the cap", async () => {
    const db = seedBackfillDb(BRAND_MATCH_BATCH + 200);
    const r = await runBrandMatchBackfill(envFor(db));
    expect(r.checked).toBe(BRAND_MATCH_BATCH);
    expect(r.pending).toBe(200);
    expect(r.pending_capped).toBe(false);
  });

  it("caps pending and flags it when the backlog exceeds the cap", async () => {
    const db = seedBackfillDb(BRAND_MATCH_BATCH + BRAND_MATCH_PENDING_CAP + 300);
    const log: StatementLogEntry[] = [];
    const r = await runBrandMatchBackfill(envFor(db, log));
    expect(r.checked).toBe(BRAND_MATCH_BATCH);
    expect(r.pending).toBe(BRAND_MATCH_PENDING_CAP);
    expect(r.pending_capped).toBe(true);
    // The probe read at most BATCH + CAP + 1 rows, never the whole backlog.
    expect(log.some((e) => /^SELECT COUNT\(\*\) AS n FROM threats WHERE target_brand_id IS NULL/.test(e.sql.trim()))).toBe(false);
  });

  it("rounds stop after a round that matched nothing (it would re-read the same rows)", async () => {
    const db = seedBackfillDb(BRAND_MATCH_BATCH + 300);
    const log: StatementLogEntry[] = [];
    const r = await runBrandMatchRounds(envFor(db, log), 5);
    expect(r.rounds_run).toBe(1);
    expect(r.matched).toBe(0);
    expect(log.filter((e) => /ORDER BY created_at DESC/.test(e.sql))).toHaveLength(1);
  });

  it("rounds continue while a round links rows, then stop at the first empty one", async () => {
    const db = seedBackfillDb(BRAND_MATCH_BATCH + 300);
    // 500 NEWER threats on the brand's canonical domain: round 1 links all
    // of them, round 2 reaches the unmatched tail and matches nothing.
    const t = db.prepare(
      `INSERT INTO threats (id, source_feed, threat_type, ioc_value, malicious_domain, created_at)
       VALUES (?, 'feed', 'phishing', ?, 'acmeqq.com', datetime('now', '+1 hour'))`,
    );
    for (let i = 0; i < BRAND_MATCH_BATCH; i++) t.run(`m${i}`, `m${i}`);
    const r = await runBrandMatchRounds(envFor(db), 5);
    expect(r.rounds_run).toBe(2);
    expect(r.matched).toBe(BRAND_MATCH_BATCH);
    expect(r.checked).toBe(2 * BRAND_MATCH_BATCH);
  });

  it("admin endpoint response carries pending_capped", () => {
    expect(src("handlers/admin/backfills.ts")).toMatch(/pending: r\.pending, pending_capped: r\.pending_capped/);
  });
});

// ─── #7 brand movers ────────────────────────────────────────────────

// The pre-2026-10 query, verbatim: per-brand correlated MAX(snapshot_day)
// over the whole history + julianday() on the column.
const OLD_MOVERS_SQL = `
  WITH paired AS (
    SELECT
      s.brand_id,
      s.brand_health_score AS latest,
      (SELECT brand_health_score
       FROM brand_score_snapshots s2
       WHERE s2.brand_id = s.brand_id
         AND julianday('now') - julianday(s2.snapshot_day) BETWEEN 1 AND 8
         AND s2.snapshot_day <> s.snapshot_day
       ORDER BY s2.snapshot_day ASC LIMIT 1) AS prev
    FROM brand_score_snapshots s
    WHERE s.snapshot_day = (
      SELECT MAX(snapshot_day) FROM brand_score_snapshots
      WHERE brand_id = s.brand_id
    )
      AND s.brand_health_score IS NOT NULL
  )
  SELECT
    p.brand_id, b.name AS brand_name, b.canonical_domain, b.logo_url,
    p.latest, (p.latest - p.prev) AS delta
  FROM paired p
  JOIN brands b ON b.id = p.brand_id
  WHERE p.prev IS NOT NULL AND p.latest <> p.prev
  ORDER BY ABS(p.latest - p.prev) DESC, p.latest DESC
  LIMIT 20
`;

type Mover = { brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; latest: number; delta: number };

function oldMovers(db: SqliteDb): { improving: Mover[]; declining: Mover[] } {
  const rows = db.prepare(OLD_MOVERS_SQL).all() as Mover[];
  return {
    improving: rows.filter((m) => m.delta > 0).slice(0, 5),
    declining: rows.filter((m) => m.delta < 0).slice(0, 5),
  };
}

/** snapshots: brand → [daysAgo, score|null][] */
function seedSnapshots(snapshots: Record<string, Array<[number, number | null]>>): SqliteDb {
  const tables = ["brands", "brand_score_snapshots"];
  const db = openDerivedDb(tables);
  replayIndexes(db, tables);
  const b = db.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES (?, ?, ?)");
  const s = db.prepare("INSERT INTO brand_score_snapshots (brand_id, snapshot_day, brand_health_score) VALUES (?, ?, ?)");
  for (const [id, rows] of Object.entries(snapshots)) {
    b.run(id, id.toUpperCase(), `${id}.com`);
    for (const [ago, score] of rows) s.run(id, dayAgo(ago), score);
  }
  return db;
}

describe.skipIf(!hasSqlite())("#7 postureAggregate movers rewrite", () => {
  // Normal case: every brand is in the newest batch (today).
  const normal: Record<string, Array<[number, number | null]>> = {
    full:      [[0, 70], [1, 68], [2, 66], [3, 64], [4, 62], [5, 60], [6, 58], [7, 50]], // prev = day-7
    gaps:      [[0, 40], [3, 45], [6, 55]],          // prev = day-6
    noYday:    [[0, 80], [2, 71]],                    // missing yesterday → prev = day-2
    onlyToday: [[0, 50]],                             // no prev → excluded
    nullNow:   [[0, null], [3, 20]],                  // latest score NULL → excluded
    tooOld:    [[0, 30], [9, 90]],                    // outside window → excluded
    edge8:     [[0, 33], [8, 99]],                    // day-8 is outside the window
    flat:      [[0, 60], [4, 60]],                    // no change → excluded
    nullPrev:  [[0, 10], [5, null], [4, 30]],         // oldest-in-window is NULL → excluded (both forms)
    drop:      [[0, 20], [1, 45]],                    // big decline
    rise:      [[0, 95], [7, 61]],                    // big rise
  };

  it("matches the old query when the newest batch covers every brand (today)", async () => {
    const db = seedSnapshots(normal);
    const agg = await postureAggregate(envFor(db));
    const old = oldMovers(db);
    expect(old.improving.length + old.declining.length).toBeGreaterThan(3);
    expect(agg.improving_brands).toEqual(old.improving);
    expect(agg.declining_brands).toEqual(old.declining);
  });

  it("matches the old query when the newest batch is yesterday's (today's cron not run yet)", async () => {
    const shifted = Object.fromEntries(
      Object.entries(normal).map(([k, rows]) => [k, rows.map(([ago, sc]) => [ago + 1, sc] as [number, number | null])]),
    );
    const db = seedSnapshots(shifted);
    const agg = await postureAggregate(envFor(db));
    const old = oldMovers(db);
    expect(old.improving.length + old.declining.length).toBeGreaterThan(0);
    expect(agg.improving_brands).toEqual(old.improving);
    expect(agg.declining_brands).toEqual(old.declining);
  });

  it("documented difference: a brand missing from the newest batch is no longer a mover", async () => {
    const db = seedSnapshots({ ...normal, stale: [[1, 90], [4, 40]] });
    const old = oldMovers(db);
    expect(old.improving.map((m) => m.brand_id)).toContain("stale");
    const agg = await postureAggregate(envFor(db));
    expect(agg.improving_brands.map((m) => m.brand_id)).not.toContain("stale");
    // Everything else is unchanged.
    expect(agg.improving_brands).toEqual(old.improving.filter((m) => m.brand_id !== "stale").slice(0, 5));
    expect(agg.declining_brands).toEqual(old.declining);
  });

  it("ignores a newest day that is still being written (in-progress 00:16 batch)", async () => {
    // Today holds only 2 of 11 brands → below 80% of yesterday → movers are
    // computed against yesterday, exactly as before today's batch started.
    const yesterdayBatch = Object.fromEntries(
      Object.entries(normal).map(([k, rows]) => [k, rows.map(([ago, sc]) => [ago + 1, sc] as [number, number | null])]),
    );
    const before = seedSnapshots(yesterdayBatch);
    const expected = await postureAggregate(envFor(before));
    expect(expected.improving_brands.length + expected.declining_brands.length).toBeGreaterThan(0);

    const during = seedSnapshots(yesterdayBatch);
    const ins = during.prepare("INSERT INTO brand_score_snapshots (brand_id, snapshot_day, brand_health_score) VALUES (?, ?, ?)");
    ins.run("full", dayAgo(0), 5);   // would be a -63 "decliner" against day-7
    ins.run("gaps", dayAgo(0), 99);
    expect(await settledSnapshotDay(envFor(during))).toBe(dayAgo(1));
    const agg = await postureAggregate(envFor(during));
    expect(agg.improving_brands).toEqual(expected.improving_brands);
    expect(agg.declining_brands).toEqual(expected.declining_brands);
  });

  it("switches to the newest day once it reaches the settled ratio", async () => {
    const db = seedSnapshots({
      a: [[1, 10], [0, 11]], b: [[1, 10], [0, 11]], c: [[1, 10], [0, 11]], d: [[1, 10], [0, 11]], e: [[1, 10]],
    });
    // 4 of 5 = 80% → settled.
    expect(await settledSnapshotDay(envFor(db))).toBe(dayAgo(0));
    db.prepare("DELETE FROM brand_score_snapshots WHERE brand_id = 'd' AND snapshot_day = ?").run(dayAgo(0));
    // 3 of 5 = 60% → still in progress.
    expect(await settledSnapshotDay(envFor(db))).toBe(dayAgo(1));
  });

  it("threshold math and single-day history", async () => {
    expect(SNAPSHOT_SETTLED_RATIO).toBe(0.8);
    expect(settledThreshold(5)).toBe(4);
    expect(settledThreshold(114_000)).toBe(91_200);
    expect(settledThreshold(0)).toBe(1);
    expect(await settledSnapshotDay(envFor(seedSnapshots({ a: [[0, 1]] })))).toBe(dayAgo(0));
    expect(await settledSnapshotDay(envFor(seedSnapshots({})))).toBeNull();
  });

  it("settled-day probes are index-only on idx_brand_score_snapshots_day", async () => {
    const db = seedSnapshots(normal);
    const log: StatementLogEntry[] = [];
    const env = envFor(db, log);
    await settledSnapshotDay(env);
    const probes = log.map((e) => e.sql);
    expect(probes).toHaveLength(4);
    for (const sql of probes) {
      const binds = (sql.match(/\?/g) ?? []).map((_, i) => (i === 0 ? dayAgo(0) : 1));
      const p = plan(db, sql, binds).join(" | ");
      expect(p).not.toMatch(/SCAN brand_score_snapshots(?! USING COVERING INDEX)/);
      expect(p).toMatch(/idx_brand_score_snapshots_day/);
    }
    // The previous (immutable) day's count is cached under a per-day key.
    const kv = (env as unknown as { CACHE: { store: Map<string, string> } }).CACHE.store;
    expect([...kv.keys()]).toContain(`cc:count.brand_score_snapshots.day.${dayAgo(1)}`);
  });

  it("empty snapshot table → no movers, no error", async () => {
    const db = seedSnapshots({});
    const log: StatementLogEntry[] = [];
    const agg = await postureAggregate(envFor(db, log));
    expect(agg.improving_brands).toEqual([]);
    expect(agg.declining_brands).toEqual([]);
    expect(log.every((e) => !e.error)).toBe(true);
  });

  it("uses index seeks only — no full scan of the snapshot history", async () => {
    const db = seedSnapshots(normal);
    const log: StatementLogEntry[] = [];
    await postureAggregate(envFor(db, log));
    const moverSql = log.find((e) => /WITH paired AS/.test(e.sql))!.sql;
    const p = plan(db, moverSql, [dayAgo(0), dayAgo(0)]);
    expect(p.some((d) => /^SCAN s2?\b/.test(d))).toBe(false);
    expect(p.join(" | ")).toMatch(/SEARCH s USING INDEX idx_brand_score_snapshots_day \(snapshot_day=\?\)/);
    expect(p.join(" | ")).toMatch(/SEARCH s2 USING [A-Z ]*INDEX sqlite_autoindex_brand_score_snapshots_1 \(brand_id=\? AND snapshot_day>\? AND snapshot_day<\?\)/);
  });

  it("caches for 1h (was 5 min)", () => {
    expect(src("lib/brand-aggregates.ts")).toMatch(/'brand-aggregate\.posture', 3600,/);
  });
});
