/**
 * The lookalike scanner's LOAD-BEARING SQL, executed against real
 * SQLite.
 *
 * ── Why this file exists ────────────────────────────────────────────
 *
 * `test/lookalike-first-contact.test.ts` drives `checkLookalikeBatch`
 * through a hand-written D1 mock, which is the right shape for the
 * BEHAVIOURAL questions it asks (does Haiku run? is an alert filed?).
 * But two of the guarantees that change turns on live entirely inside
 * SQL, and that mock RE-IMPLEMENTED both of them:
 *
 *   - the `CASE WHEN ? = 1 AND baseline_established_at IS NULL` arm
 *     that makes `baseline_established_at` single-write, and
 *   - the `AND first_seen IS NULL` guard on the `first_seen` stamp.
 *
 * With the semantics applied in the mock, inverting the real CASE's
 * arms or deleting the real guard left all 21 of those tests green — the
 * mock was asserting against itself. Mutation-checked: both edits now
 * fail here.
 *
 * So this file runs the statements EXTRACTED FROM SOURCE (never
 * retyped — see `sqlContaining`) against `node:sqlite`, following the
 * house pattern in `test/monitored-brands-predicate.test.ts` and
 * `test/geo-exhaustion-and-diag-folds.test.ts`.
 *
 * It also pins the SELECTION PLANS. The four cohort queries replaced
 * two `ORDER BY <stamp> ASC NULLS FIRST` queries whose NULL-first
 * ordering starved the re-check cohort platform-wide; the replacement is
 * only viable if each cohort is an index range scan, because the table
 * is growing ninety-fold and an index-defeating predicate here turns
 * every tick into a full scan. `EXPLAIN QUERY PLAN` is therefore an
 * assertion, not a comment.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { MONITORED_BRAND_PREDICATE_SQL } from "../src/lib/monitored-brands";

type Stmt = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
};
type SqliteCtor = new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
};

// Resolved SYNCHRONOUSLY at collection time — `describe.skipIf` runs
// before any `beforeAll`, so an async import would skip the lane on a
// runtime that actually supports it.
const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: SqliteCtor | null = null;
try {
  DatabaseSync = (nodeRequire("node:sqlite") as { DatabaseSync: SqliteCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}
const hasSqlite = (): boolean => DatabaseSync !== null;

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const scannerSrc = read("../src/scanners/lookalike-domains.ts");
const analyzerSrc = read("../src/scanners/lookalike-page-analysis.ts");
const handlerSrc = read("../src/handlers/lookalikeDomains.ts");
const migration0031 = read("../migrations/0031_lookalike_domains.sql");
const migration0268 = read("../migrations/0268_lookalike_check_failure_cooldown.sql");

/**
 * The single template literal in `src` containing every marker, with
 * `${MONITORED_BRAND_PREDICATE_SQL}` substituted.
 *
 * Same helper as `test/monitored-brands-predicate.test.ts`, and the same
 * reason: extracting rather than retyping is the point. A retyped copy
 * tests the copy, which is precisely the defect this file corrects.
 * Asserts exactly one match so an ambiguous marker set fails loudly
 * instead of silently picking the wrong statement.
 */
function sqlContaining(src: string, markers: string[]): string {
  const literals = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);
  const hits = literals.filter((t) => markers.every((mk) => t.includes(mk)));
  expect(hits.length, `expected exactly 1 template literal matching ${markers.join(" + ")}`).toBe(1);
  const withPredicate = hits[0]!.replace(
    /\$\{MONITORED_BRAND_PREDICATE_SQL\}/g,
    MONITORED_BRAND_PREDICATE_SQL,
  );
  expect(withPredicate, "unsubstituted interpolation left in extracted SQL").not.toMatch(/\$\{/);
  return withPredicate;
}

// ─── The statements under test, by marker ─────────────────────────
// Named here so a failure message says WHICH statement moved, and so
// the marker sets are reviewable in one place.

const SQL = {
  /** The per-check UPDATE. Carries the single-write baseline CASE. */
  perCheckUpdate: () => sqlContaining(scannerSrc, ["SET registered = ?", "baseline_established_at = CASE"]),
  /**
   * The observed-transition `first_seen` stamp.
   *
   * The marker is the SET clause ONLY, deliberately NOT the
   * `first_seen IS NULL` guard: matching on the guard would make a
   * deletion of it fail here at EXTRACTION ("0 literals matched"), which
   * detects that exact edit and nothing else. Matching on the SET clause
   * extracts whatever guard the statement now carries and lets the
   * semantic assertions below judge it — so inverting the guard to
   * `IS NOT NULL` fails too, not just removing it.
   */
  firstSeenStamp: () => sqlContaining(scannerSrc, ["SET first_seen = datetime('now')"]),
  /** The F6 unresolved-check branch: cooldown only. */
  failureCooldown: () => sqlContaining(scannerSrc, ["SET last_check_failed_at = datetime('now')"]),
  /** "Scan now" (B2) — makes rows due without forging first contact. */
  handlerReset: () => sqlContaining(handlerSrc, ["SET last_checked = CASE", "WHEN last_checked IS NULL THEN NULL"]),
  firstContactSelect: () => sqlContaining(scannerSrc, ["FROM lookalike_domains ld", "ld.last_checked IS NULL"]),
  recheckSelect: () => sqlContaining(scannerSrc, ["FROM lookalike_domains ld", "ld.last_checked IS NOT NULL"]),
  firstAnalysisSelect: () => sqlContaining(analyzerSrc, ["FROM lookalike_domains ld", "page_fetched_at IS NULL"]),
  reanalysisSelect: () => sqlContaining(analyzerSrc, ["FROM lookalike_domains ld", "page_fetched_at IS NOT NULL"]),
};

// ─── Schema ───────────────────────────────────────────────────────
// The column set the statements above touch. Indexes come from the
// MIGRATION FILES rather than being retyped, so a plan assertion below
// fails if a migration's index definition drifts from what the query
// needs (which is exactly how a "cheap" query becomes a full scan).

const DDL = `
  CREATE TABLE lookalike_domains (
    id TEXT PRIMARY KEY,
    brand_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    permutation_type TEXT,
    registered INTEGER DEFAULT 0,
    resolves_to TEXT,
    has_mx INTEGER DEFAULT 0,
    has_web INTEGER DEFAULT 0,
    first_seen TEXT,
    last_checked TEXT,
    threat_level TEXT DEFAULT 'LOW',
    alert_id TEXT,
    unicode_domain TEXT,
    page_fetched_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    baseline_established_at TEXT,
    last_check_failed_at TEXT
  );
  CREATE TABLE brands (
    id TEXT PRIMARY KEY,
    name TEXT,
    canonical_domain TEXT,
    tier TEXT
  );
`;

/**
 * Every `CREATE INDEX ... ;` statement in a migration file.
 *
 * `--` comments are stripped first: both migrations discuss indexes in
 * prose ("ADD COLUMN / CREATE INDEX, never DROP/ALTER"), and a match
 * starting inside a comment would run to the next real semicolon and
 * swallow the statement after it.
 */
function indexStatements(migration: string): string[] {
  const code = migration.replace(/^\s*--.*$/gm, "");
  return [...code.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX[\s\S]*?;/gi)].map((m) => m[0]);
}

describe.skipIf(!hasSqlite())("lookalike scanner SQL — real SQLite", () => {
  let db: InstanceType<SqliteCtor>;

  let seq = 0;

  function insert(over: Record<string, unknown> = {}): string {
    seq += 1;
    const row = {
      id: `l_${seq}`,
      brand_id: "b1",
      // Unique per row: `idx_lookalike_brand_domain` is a real UNIQUE
      // index on (brand_id, domain), extracted from migration 0031.
      domain: `acm3-${seq}.example`,
      permutation_type: "replacement",
      registered: 0,
      last_checked: null,
      first_seen: null,
      baseline_established_at: null,
      last_check_failed_at: null,
      ...over,
    };
    const cols = Object.keys(row);
    db.prepare(
      `INSERT INTO lookalike_domains (${cols.join(", ")})
       VALUES (${cols.map(() => "?").join(", ")})`,
    ).run(...cols.map((c) => (row as Record<string, unknown>)[c] as null));
    return row.id as string;
  }

  function fetch(id: string) {
    return db.prepare(`SELECT * FROM lookalike_domains WHERE id = ?`).get(id) as {
      registered: number;
      resolves_to: string | null;
      has_mx: number;
      has_web: number;
      last_checked: string | null;
      last_check_failed_at: string | null;
      first_seen: string | null;
      baseline_established_at: string | null;
    };
  }

  beforeAll(() => {
    db = new DatabaseSync!(":memory:");
    db.exec(DDL);
    const indexes = [...indexStatements(migration0031), ...indexStatements(migration0268)];
    // The base table's four indexes plus 0268's partial page index. If a
    // migration stops creating one of these the plan assertions below
    // are what notice.
    expect(indexes.length, "expected index DDL to be extracted from both migrations").toBe(5);
    for (const stmt of indexes) db.exec(stmt);
    db.prepare(`INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b1','Acme','acme.example','monitored')`).run();
  });

  beforeEach(() => {
    db.prepare(`DELETE FROM lookalike_domains`).run();
  });

  // ═════════════════════════════════════════════════════════════════
  // baseline_established_at is STRUCTURALLY single-write
  // ═════════════════════════════════════════════════════════════════
  //
  // Mutation-checked: swapping the CASE's THEN/ELSE arms in
  // `lookalike-domains.ts` fails the second and fourth cases here.

  describe("the per-check UPDATE's baseline CASE", () => {
    /** Bind order: registered, ip, hasMx, hasWeb, firstContactFlag, id. */
    function runCheck(id: string, firstContactFlag: 0 | 1, registered = 1) {
      return db.prepare(SQL.perCheckUpdate()).run(registered, "5.6.7.8", 1, 1, firstContactFlag, id);
    }

    it("stamps the column on first contact", () => {
      const id = insert();
      runCheck(id, 1);
      expect(fetch(id).baseline_established_at).not.toBeNull();
    });

    it("does NOT re-stamp a column that is already set — even with the first-contact flag set", () => {
      // THE INVARIANT migration 0267 declares. Before the `AND
      // baseline_established_at IS NULL` term this held only because
      // `last_checked` happened to be non-NULL on every later check —
      // which the "Scan now" handler used to clear wholesale, making it
      // false for every rescanned brand. The flag is passed as 1 here
      // precisely to prove the guard, not the caller, is what holds.
      const id = insert({ baseline_established_at: "2026-06-01 00:00:00" });
      runCheck(id, 1);
      expect(fetch(id).baseline_established_at).toBe("2026-06-01 00:00:00");
    });

    it("leaves the column NULL when the flag is 0", () => {
      const id = insert();
      runCheck(id, 0);
      expect(fetch(id).baseline_established_at).toBeNull();
    });

    it("leaves an existing value untouched when the flag is 0", () => {
      const id = insert({ baseline_established_at: "2026-06-01 00:00:00" });
      runCheck(id, 0);
      expect(fetch(id).baseline_established_at).toBe("2026-06-01 00:00:00");
    });

    it("advances last_checked and CLEARS the failure cooldown", () => {
      const id = insert({ last_check_failed_at: "2026-09-01 00:00:00" });
      runCheck(id, 1);
      const row = fetch(id);
      expect(row.last_checked).not.toBeNull();
      // A successful observation supersedes any run of failures.
      expect(row.last_check_failed_at).toBeNull();
    });

    it("writes the DNS facts it is given", () => {
      const id = insert();
      db.prepare(SQL.perCheckUpdate()).run(1, "9.9.9.9", 1, 0, 1, id);
      const row = fetch(id);
      expect(row.registered).toBe(1);
      expect(row.resolves_to).toBe("9.9.9.9");
      expect(row.has_mx).toBe(1);
      expect(row.has_web).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // first_seen is write-once
  // ═════════════════════════════════════════════════════════════════
  //
  // Mutation-checked: deleting `AND first_seen IS NULL` fails the second
  // case here.

  describe("the first_seen stamp", () => {
    it("stamps a NULL first_seen", () => {
      const id = insert({ last_checked: "2026-09-01 00:00:00" });
      const res = db.prepare(SQL.firstSeenStamp()).run(id);
      expect(res.changes).toBe(1);
      expect(fetch(id).first_seen).not.toBeNull();
    });

    it("does NOT overwrite an existing first_seen, and reports zero changes", () => {
      // The appearance date of a squat is a fact recorded once. A later
      // lapse-and-re-registration is a NEW appearance, but the platform
      // deliberately keeps the FIRST one — and the 0-row result is what
      // a caller would need to detect a re-registration if that ever
      // changes.
      const id = insert({ first_seen: "2026-03-04 05:06:07", last_checked: "2026-09-01 00:00:00" });
      const res = db.prepare(SQL.firstSeenStamp()).run(id);
      expect(res.changes).toBe(0);
      expect(fetch(id).first_seen).toBe("2026-03-04 05:06:07");
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // F6 — an unresolved check writes NO registration state
  // ═════════════════════════════════════════════════════════════════

  describe("the unresolved-check cooldown UPDATE", () => {
    it("advances only last_check_failed_at — registration state and last_checked are untouched", () => {
      const id = insert({
        registered: 1,
        resolves_to: "5.6.7.8",
        has_mx: 1,
        has_web: 1,
        last_checked: "2026-09-01 00:00:00",
        first_seen: "2026-03-04 05:06:07",
      });
      db.prepare(SQL.failureCooldown()).run(id);
      const row = fetch(id);
      // The whole point: a 3s DNS timeout must not manufacture a lapse.
      expect(row.registered).toBe(1);
      expect(row.resolves_to).toBe("5.6.7.8");
      expect(row.last_checked).toBe("2026-09-01 00:00:00");
      expect(row.first_seen).toBe("2026-03-04 05:06:07");
      expect(row.last_check_failed_at).not.toBeNull();
    });

    it("leaves last_checked NULL on a never-observed row, so it stays first contact", () => {
      // If this wrote `last_checked`, the row would be re-classified as
      // "checked before" while `registered` still held the seeder's
      // INSERT default — and the next successful check would read the
      // resulting 0 -> 1 as a registration event. The failure cooldown
      // exists as its own column for exactly this reason.
      const id = insert();
      db.prepare(SQL.failureCooldown()).run(id);
      const row = fetch(id);
      expect(row.last_checked).toBeNull();
      expect(row.baseline_established_at).toBeNull();
      expect(row.last_check_failed_at).not.toBeNull();
    });

    it("keeps the row out of BOTH cohorts for 24h, then readmits it", () => {
      const id = insert();
      db.prepare(SQL.failureCooldown()).run(id);
      const due = () =>
        (db.prepare(SQL.firstContactSelect()).all(50) as Array<{ id: string }>).map((r) => r.id);
      expect(due(), "cooling down").not.toContain(id);

      db.prepare(
        `UPDATE lookalike_domains SET last_check_failed_at = datetime('now', '-25 hours') WHERE id = ?`,
      ).run(id);
      expect(due(), "cooldown expired").toContain(id);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // B2 — "Scan now" makes rows due without forging first contact
  // ═════════════════════════════════════════════════════════════════

  describe("the handleScanLookalikes reset UPDATE", () => {
    it("stamps a checked row STALE rather than NULL, so it lands in the re-check cohort", () => {
      const id = insert({ last_checked: "2026-09-29 12:00:00", registered: 1, baseline_established_at: "2026-06-01 00:00:00" });
      db.prepare(SQL.handlerReset()).run("b1");
      const row = fetch(id);
      // NOT NULL — that is the whole fix. NULL would have re-classified
      // a real registration as a baseline and re-stamped 0267's column.
      expect(row.last_checked).not.toBeNull();
      const recheckIds = (db.prepare(SQL.recheckSelect()).all(50, 0) as Array<{ id: string }>).map((r) => r.id);
      const firstIds = (db.prepare(SQL.firstContactSelect()).all(50) as Array<{ id: string }>).map((r) => r.id);
      expect(recheckIds).toContain(id);
      expect(firstIds).not.toContain(id);
    });

    it("leaves a genuinely never-checked row NULL — the mirror-image bug", () => {
      // Writing the stale stamp over a never-checked row would demote a
      // real first contact to a fake re-check, which is the one state
      // that CAN mint a false `first_seen`.
      const id = insert();
      db.prepare(SQL.handlerReset()).run("b1");
      const row = fetch(id);
      expect(row.last_checked).toBeNull();
      const firstIds = (db.prepare(SQL.firstContactSelect()).all(50) as Array<{ id: string }>).map((r) => r.id);
      expect(firstIds).toContain(id);
    });

    it("clears the DNS failure cooldown so the rescan is not held off", () => {
      const id = insert({ last_checked: "2026-09-29 12:00:00", last_check_failed_at: "2026-09-30 11:00:00" });
      db.prepare(SQL.handlerReset()).run("b1");
      expect(fetch(id).last_check_failed_at).toBeNull();
    });

    it("touches only the named brand", () => {
      db.prepare(`INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b2','Other','other.example','monitored')`).run();
      const mine = insert({ last_checked: "2026-09-29 12:00:00" });
      const theirs = insert({ brand_id: "b2", last_checked: "2026-09-29 12:00:00" });
      db.prepare(SQL.handlerReset()).run("b1");
      expect(fetch(mine).last_checked).not.toBe("2026-09-29 12:00:00");
      expect(fetch(theirs).last_checked).toBe("2026-09-29 12:00:00");
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // B1 — the cohorts are DISJOINT and their union is the old set
  // ═════════════════════════════════════════════════════════════════

  describe("the four cohort SELECTs partition the due set", () => {
    it("the checker's two cohorts are disjoint and cover every due row", () => {
      const never = insert();
      const stale = insert({ last_checked: "2026-09-01 00:00:00" });
      const fresh = insert({ last_checked: "9999-01-01 00:00:00" });

      const first = (db.prepare(SQL.firstContactSelect()).all(50) as Array<{ id: string }>).map((r) => r.id);
      const recheck = (db.prepare(SQL.recheckSelect()).all(50, 0) as Array<{ id: string }>).map((r) => r.id);

      expect(first).toEqual([never]);
      expect(recheck).toEqual([stale]);
      // A row checked within the cadence is in NEITHER — the split did
      // not widen the population, only how its budget is allocated.
      expect([...first, ...recheck]).not.toContain(fresh);
    });

    it("the page pass's two cohorts are disjoint and cover every due row", () => {
      const never = insert({ registered: 1, has_web: 1, resolves_to: "1.2.3.4", page_fetched_at: null });
      const stale = insert({ registered: 1, has_web: 1, resolves_to: "1.2.3.4", page_fetched_at: "2026-09-01 00:00:00" });
      const fresh = insert({ registered: 1, has_web: 1, resolves_to: "1.2.3.4", page_fetched_at: "9999-01-01 00:00:00" });

      const first = (db.prepare(SQL.firstAnalysisSelect()).all(20) as Array<{ id: string }>).map((r) => r.id);
      const recheck = (db.prepare(SQL.reanalysisSelect()).all(20, 0) as Array<{ id: string }>).map((r) => r.id);

      expect(first).toEqual([never]);
      expect(recheck).toEqual([stale]);
      expect([...first, ...recheck]).not.toContain(fresh);
    });

    it("the re-check OFFSET spill serves the NEXT slice, not the same one", () => {
      const ids = [1, 2, 3, 4, 5].map((n) =>
        insert({ last_checked: `2026-09-0${n} 00:00:00` }),
      );
      const head = (db.prepare(SQL.recheckSelect()).all(2, 0) as Array<{ id: string }>).map((r) => r.id);
      const spill = (db.prepare(SQL.recheckSelect()).all(3, 2) as Array<{ id: string }>).map((r) => r.id);
      // Stalest first, and the two slices tile the cohort without
      // overlapping — which is what makes the spill safe to merge.
      expect(head).toEqual(ids.slice(0, 2));
      expect(spill).toEqual(ids.slice(2, 5));
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // Plans. An index-defeating predicate here is a full scan of a table
  // about to grow ninety-fold, every tick.
  // ═════════════════════════════════════════════════════════════════

  describe("EXPLAIN QUERY PLAN — every cohort query is an index range scan", () => {
    function plan(sql: string, params: unknown[]): string {
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
      return rows.map((r) => r.detail).join("\n");
    }

    const CASES: Array<{ label: string; sql: () => string; params: unknown[]; index: string }> = [
      { label: "checker / first contact", sql: SQL.firstContactSelect, params: [50], index: "idx_lookalike_last_checked" },
      { label: "checker / re-check", sql: SQL.recheckSelect, params: [50, 0], index: "idx_lookalike_last_checked" },
      { label: "page / first analysis", sql: SQL.firstAnalysisSelect, params: [20], index: "idx_lookalike_page_due" },
      { label: "page / re-analysis", sql: SQL.reanalysisSelect, params: [20, 0], index: "idx_lookalike_page_due" },
    ];

    for (const c of CASES) {
      it(`${c.label} SEARCHes ${c.index} and never scans lookalike_domains`, () => {
        const detail = plan(c.sql(), c.params);
        expect(detail, detail).toContain(c.index);
        // "SCAN lookalike_domains" (as opposed to "SEARCH") is the
        // full-table read this whole arrangement exists to avoid.
        expect(detail, detail).not.toMatch(/SCAN lookalike_domains\b/);
      });
    }

    for (const c of CASES) {
      it(`${c.label} needs no temp b-tree for ordering`, () => {
        // The ORDER BY must be the index's own order. A sort step here
        // would materialize the whole cohort — ~56,010 rows — per tick,
        // which is the cost the `NULLS FIRST` single query was paying
        // before it was split.
        const detail = plan(c.sql(), c.params);
        expect(detail, detail).not.toMatch(/TEMP B-TREE/i);
      });
    }
  });
});
