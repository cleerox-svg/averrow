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
import { applyLookalikeSchema, lookalikeSchema } from "./lookalike-schema";

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
// 0031's CREATE TABLE + indexes now arrive via `applyLookalikeSchema`;
// 0268 is still read directly because two assertions are ABOUT the
// migration's text (that it refreshes statistics, table-scoped).
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
// Table AND indexes come from the MIGRATION FILES via
// `test/lookalike-schema.ts` — see that module for why hand-writing
// either is the defect this file exists to correct. `brands` is the only
// hand-written table left: no statement here writes to it, it is joined
// on its primary key alone, and it is not the table whose column set has
// drifted.

const DDL = `
  CREATE TABLE brands (
    id TEXT PRIMARY KEY,
    name TEXT,
    canonical_domain TEXT,
    tier TEXT
  );
`;

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
    applyLookalikeSchema(db);
    // 0031's four indexes + 0227's takedown index + 0268's partial page
    // index. If a migration stops creating one of these the plan
    // assertions below are what notice.
    expect(
      lookalikeSchema().indexes.length,
      "expected index DDL to be extracted from the migrations",
    ).toBe(6);
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
    /**
     * Bind order: registered, aAnswered, ip, mxAnswered, hasMx,
     * webAnswered, hasWeb, firstContactFlag, id.
     */
    function runCheck(id: string, firstContactFlag: 0 | 1, registered = 1) {
      return db.prepare(SQL.perCheckUpdate())
        .run(registered, 1, "5.6.7.8", 1, 1, 1, 1, firstContactFlag, id);
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
      db.prepare(SQL.perCheckUpdate()).run(1, 1, "9.9.9.9", 1, 1, 1, 0, 1, id);
      const row = fetch(id);
      expect(row.registered).toBe(1);
      expect(row.resolves_to).toBe("9.9.9.9");
      expect(row.has_mx).toBe(1);
      expect(row.has_web).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // B3 — an UNANSWERED probe must not overwrite a known value
  // ═════════════════════════════════════════════════════════════════
  //
  // `resolved` is scoped to `registered` alone (a SEEN A record
  // short-circuits it), so this same UPDATE can be reached with any of
  // the three per-field probes having learned nothing. It used to write
  // all three unconditionally.
  //
  // Mutation-checked: replacing any one arm with the bare
  // `<column> = ?` it used to be fails the matching case here.

  describe("the per-check UPDATE's per-field answer gates", () => {
    /** A row with all three facts already KNOWN from an earlier check. */
    function known(): string {
      return insert({
        registered: 1,
        resolves_to: "5.6.7.8",
        has_mx: 1,
        has_web: 1,
        last_checked: "2026-09-01 00:00:00",
      });
    }

    it("an unanswered WEB probe keeps the stored has_web", () => {
      // The one with the sharpest consequence: both page-analysis
      // cohorts require `has_web = 1`, and the page pass is the only
      // producer that can still alert on a row whose `registered === 0`
      // one-shot has already fired. Writing 0 here from a 3s timeout
      // removed the row's last path to an alert.
      const id = known();
      // registered, aAnswered, ip, mxAnswered, hasMx, webAnswered=0, hasWeb=0
      db.prepare(SQL.perCheckUpdate()).run(1, 1, "5.6.7.8", 1, 1, 0, 0, 0, id);
      expect(fetch(id).has_web).toBe(1);
    });

    it("an unanswered MX probe keeps the stored has_mx", () => {
      // A answers with a record -> `resolved` true -> this branch runs,
      // while the MX query timed out. `hasMx = false` over a stored 1
      // erases the mail evidence that IS the BEC-precursor signal.
      const id = known();
      db.prepare(SQL.perCheckUpdate()).run(1, 1, "5.6.7.8", 0, 0, 1, 1, 0, id);
      expect(fetch(id).has_mx).toBe(1);
    });

    it("an unanswered A probe keeps the stored resolves_to", () => {
      // MX answers, A times out: `registered` is true, `resolved` is
      // true, and `result.ip` is undefined. `result.ip ?? null` then
      // ERASED a known IP — and both page cohorts require
      // `resolves_to IS NOT NULL`.
      const id = known();
      db.prepare(SQL.perCheckUpdate()).run(1, 0, null, 1, 1, 1, 1, 0, id);
      expect(fetch(id).resolves_to).toBe("5.6.7.8");
    });

    it("an ANSWERED probe still writes a negative finding", () => {
      // The other direction, which matters just as much: "we looked and
      // there is no web server / no MX / no A record" is a real
      // observation and must be persisted. A gate that swallowed it
      // would make the columns write-once.
      const id = known();
      db.prepare(SQL.perCheckUpdate()).run(0, 1, null, 1, 0, 1, 0, 0, id);
      const row = fetch(id);
      expect(row.registered).toBe(0);
      expect(row.resolves_to).toBeNull();
      expect(row.has_mx).toBe(0);
      expect(row.has_web).toBe(0);
    });

    it("registered is written unconditionally — the branch's precondition covers it", () => {
      // This statement only runs when `resolved` is true, which is
      // exactly the condition that makes `registered` authoritative. So
      // there is deliberately no gate on it, and a 1 -> 0 lapse we DID
      // observe must land.
      const id = known();
      db.prepare(SQL.perCheckUpdate()).run(0, 1, null, 1, 0, 0, 0, 0, id);
      expect(fetch(id).registered).toBe(0);
      // ...while the unanswered web probe still preserved its column.
      expect(fetch(id).has_web).toBe(1);
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
    /**
     * ── WHY THIS BLOCK HAS ITS OWN DATABASES ─────────────────────────
     *
     * The previous version measured all four plans on the table the
     * outer `beforeEach` had just TRUNCATED, and asserted
     * `not.toMatch(/SCAN lookalike_domains\b/)`. Both halves were dead:
     *
     *   * SQLite reports the ALIAS, so the detail line for an
     *     unindexed read of `lookalike_domains ld` is literally
     *     `SCAN ld`. The regex could never match the string it existed
     *     to catch — mutation-checked by deleting
     *     `idx_lookalike_last_checked`, which produced `SCAN ld` and
     *     left the old assertion GREEN.
     *   * On zero rows SQLite prefers an index unconditionally, so the
     *     plans were pinned in the one state where nothing can be
     *     learned.
     *
     * So the plans are now measured on dedicated databases seeded to the
     * projected production shape, and asserted with a bare `\bSCAN\b` —
     * the strongest form, which all four queries genuinely satisfy.
     *
     * TWO databases, with and without `ANALYZE`, because the plans are
     * statistics-dependent and a single state proves only half of it.
     * A fresh D1 has no statistics for this table; a D1 that has run
     * 0123's bare `ANALYZE;` (or 0268's own, added in this round) has
     * measured ones.
     *
     * ── WHY THE TIMESTAMPS ARE PER-ROW ────────────────────────────────
     *
     * `last_checked` / `page_fetched_at` are seeded with a DISTINCT
     * stamp per row, spread over an hour, because `sqlite_stat1` records
     * only average rows-per-value and the plan turns on it. A fixture
     * that seeds two constant timestamps drives that average to
     * 18,670-of-56,010 and the planner then emits `SCAN ld` for the
     * first-contact cohort — measured, and measured to flip back at
     * three or more distinct values. Production stamps `datetime('now')`
     * per row at 50 rows/tick, so it carries thousands of distinct
     * values and is nowhere near that regime. An empty table and a
     * two-value fixture are therefore misleading in OPPOSITE directions,
     * and neither is what this block should be asserting against.
     */
    const ROWS = 56_010;
    const BRANDS = 1_867;

    let planDb: InstanceType<SqliteCtor>;
    let analyzedDb: InstanceType<SqliteCtor>;

    function seeded(analyze: boolean): InstanceType<SqliteCtor> {
      const fresh = new DatabaseSync!(":memory:");
      fresh.exec(DDL);
      applyLookalikeSchema(fresh);

      const bi = fresh.prepare(
        `INSERT INTO brands (id, name, canonical_domain, tier) VALUES (?, ?, ?, ?)`,
      );
      fresh.exec("BEGIN");
      for (let i = 0; i < BRANDS + 33; i += 1) {
        bi.run(`b${i}`, `B${i}`, `b${i}.example`, i < BRANDS ? "monitored" : "tracked");
      }
      // The production mix the population comments in
      // `scanners/lookalike-domains.ts` and
      // `scanners/lookalike-page-analysis.ts` project: ~70% of candidate
      // rows never checked, 25% registered, ~70% of those with a web
      // server, and a fifth of those already page-analyzed. Every cohort
      // predicate therefore selects a NON-EMPTY, non-trivial slice.
      //
      // Timestamps are computed RELATIVE TO THE CLOCK (not hardcoded
      // dates, which silently age out of their own 24-hour window and
      // empty the cohort they exist to populate) and are DISTINCT PER
      // ROW (see the block docstring: a low-cardinality fixture changes
      // the plan). `stale` is comfortably outside the 24 h cadence,
      // `fresh` comfortably inside it.
      const stamp = (base: number, slot: number): string =>
        new Date(base + slot * 1000).toISOString().replace("T", " ").slice(0, 19);
      const now = Date.now();
      const staleBase = now - 30 * 24 * 3600_000;
      const freshBase = now - 3600_000;

      const li = fresh.prepare(
        `INSERT INTO lookalike_domains
           (id, brand_id, domain, permutation_type, registered, resolves_to,
            has_mx, has_web, last_checked, page_fetched_at)
         VALUES (?, ?, ?, 'replacement', ?, ?, ?, ?, ?, ?)`,
      );
      let checkSlot = 0;
      let pageSlot = 0;
      for (let i = 0; i < ROWS; i += 1) {
        const registered = i % 4 === 0 ? 1 : 0;
        const hasWeb = registered === 1 && i % 10 < 7 ? 1 : 0;
        // 30% checked, half of those stale. Each gets its own second.
        let lastChecked: string | null = null;
        if (i % 10 < 3) {
          const slot = checkSlot++;
          lastChecked = stamp(slot % 2 === 0 ? staleBase : freshBase, slot % 1800);
        }
        // A fifth of the has_web rows already page-analyzed, half stale.
        // `hasWeb && i % 5 === 0` forces `i % 20 === 0`, so the
        // stale/fresh split must NOT be keyed on `i % 2` — that made
        // every page row fresh and emptied the re-analysis cohort.
        let pageFetched: string | null = null;
        if (hasWeb === 1 && i % 5 === 0) {
          const slot = pageSlot++;
          pageFetched = stamp(slot % 2 === 0 ? staleBase : freshBase, slot % 1800);
        }
        li.run(
          `l${i}`,
          `b${i % BRANDS}`,
          `acm3-${i}.example`,
          registered,
          registered === 1 ? "1.2.3.4" : null,
          registered === 1 && i % 3 === 0 ? 1 : 0,
          hasWeb,
          lastChecked,
          pageFetched,
        );
      }
      fresh.exec("COMMIT");
      if (analyze) fresh.exec("ANALYZE");
      return fresh;
    }

    beforeAll(() => {
      planDb = seeded(false);
      analyzedDb = seeded(true);
    });

    function plan(target: InstanceType<SqliteCtor>, sql: string, params: unknown[]): string {
      const rows = target.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
      return rows.map((r) => r.detail).join("\n");
    }

    const CASES: Array<{ label: string; sql: () => string; params: unknown[]; index: string }> = [
      { label: "checker / first contact", sql: SQL.firstContactSelect, params: [50], index: "idx_lookalike_last_checked" },
      { label: "checker / re-check", sql: SQL.recheckSelect, params: [50, 0], index: "idx_lookalike_last_checked" },
      { label: "page / first analysis", sql: SQL.firstAnalysisSelect, params: [20], index: "idx_lookalike_page_due" },
      { label: "page / re-analysis", sql: SQL.reanalysisSelect, params: [20, 0], index: "idx_lookalike_page_due" },
    ];

    it("the plan fixture is actually populated — no vacuous plan below", () => {
      // The empty-table mistake, guarded explicitly rather than trusted.
      const c = planDb.prepare(
        `SELECT COUNT(*) AS n,
                SUM(last_checked IS NULL) AS never_checked,
                SUM(registered) AS registered,
                SUM(page_fetched_at IS NOT NULL) AS paged
           FROM lookalike_domains`,
      ).get() as { n: number; never_checked: number; registered: number; paged: number };
      expect(c.n).toBe(ROWS);
      expect(c.never_checked).toBeGreaterThan(30_000);
      expect(c.registered).toBeGreaterThan(10_000);
      expect(c.paged).toBeGreaterThan(1_000);
      // And every cohort SELECT returns rows, so a plan is being chosen
      // for a query that has work to do.
      for (const c2 of CASES) {
        expect((planDb.prepare(c2.sql()).all(...c2.params) as unknown[]).length, c2.label)
          .toBeGreaterThan(0);
      }
    });

    // Both stat states, because a fresh D1 has no statistics for this
    // table while one that has run 0123's bare `ANALYZE;` (or 0268's
    // own) has measured ones — and the plans differ by statistics, not
    // by anything in the query.
    const STATES = (): Array<[string, InstanceType<SqliteCtor>]> => [
      ["no statistics", planDb],
      ["after ANALYZE", analyzedDb],
    ];

    for (const c of CASES) {
      it(`${c.label} SEARCHes ${c.index} and never scans lookalike_domains`, () => {
        for (const [state, target] of STATES()) {
          const detail = plan(target, c.sql(), c.params);
          expect(detail, `${state}: ${detail}`).toContain(c.index);
          // A BARE `\bSCAN\b`. SQLite prints the ALIAS, so an unindexed
          // read of `lookalike_domains ld` reads `SCAN ld` and the old
          // `/SCAN lookalike_domains\b/` could never match the string it
          // existed to catch. Mutation-checked: dropping
          // `idx_lookalike_last_checked` yields `SCAN ld`, which the old
          // assertion passed and this one fails.
          expect(detail, `${state}: ${detail}`).not.toMatch(/\bSCAN\b/);
        }
      });
    }

    for (const c of CASES) {
      it(`${c.label} needs no temp b-tree for ordering`, () => {
        // The ORDER BY must be the index's own order. A sort step here
        // would materialize the whole cohort — ~56,010 rows — per tick,
        // which is the cost the `NULLS FIRST` single query was paying
        // before it was split.
        for (const [state, target] of STATES()) {
          const detail = plan(target, c.sql(), c.params);
          expect(detail, `${state}: ${detail}`).not.toMatch(/TEMP B-TREE/i);
        }
      });
    }

    // ═════════════════════════════════════════════════════════════════
    // What the first-contact plan actually depends on
    // ═════════════════════════════════════════════════════════════════

    it("0268 refreshes statistics, and the plans hold with them", () => {
      // The sibling convention (0099/0100/0101/0123/0197/0200) and the
      // reason it is safe here, asserted together: measured statistics
      // keep all four plans, so the ANALYZE this round adds to 0268 is
      // the sibling behaviour rather than a risk.
      const code = migration0268.replace(/^\s*--.*$/gm, "");
      expect(code, "0268 must refresh statistics like its siblings").toMatch(/\bANALYZE\b/i);
      // Table-scoped, not 0123's bare whole-database form.
      expect(code).toMatch(/ANALYZE\s+lookalike_domains\s*;/i);
    });

    it("the first-contact plan is CARDINALITY-sensitive — which is why the fixture stamps per row", () => {
      // Not a hypothetical, and the reason the seeding above is the way
      // it is. `sqlite_stat1` stores only average rows-per-value, so it
      // cannot express that the NULL bucket of `last_checked` holds most
      // of the table. Drive that average high enough — TWO or fewer
      // distinct non-NULL values across 56,010 rows — and the planner
      // prices the `IS NULL` seek plus a per-row table lookup above an
      // unindexed read with `LIMIT 50`, and emits `SCAN ld`.
      //
      // Production cannot reach that regime (`datetime('now')` per row,
      // 50 rows/tick => thousands of distinct values), but a FIXTURE
      // trivially can — and a fixture that did would have "proved" a
      // full scan that production never performs. Pinned so the next
      // person to simplify the seeding above sees why it is not
      // simplified.
      const degenerate = (distinctStamps: number): string => {
        const d = new DatabaseSync!(":memory:");
        applyLookalikeSchema(d);
        const ins = d.prepare(
          `INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type, last_checked)
           VALUES (?, 'b1', ?, 'replacement', ?)`,
        );
        d.exec("BEGIN");
        for (let i = 0; i < ROWS; i += 1) {
          ins.run(
            `l${i}`,
            `d${i}.example`,
            i % 10 < 3 ? `2026-08-01 00:00:${String(i % distinctStamps).padStart(2, "0")}` : null,
          );
        }
        d.exec("COMMIT");
        d.exec("ANALYZE");
        return plan(d, SQL.firstContactSelect(), [50]);
      };
      expect(degenerate(2), "2 distinct stamps").toMatch(/\bSCAN\b/);
      expect(degenerate(3), "3 distinct stamps").not.toMatch(/\bSCAN\b/);
      // ...and the real fixture is far past the flip point.
      const distinct = (analyzedDb.prepare(
        `SELECT COUNT(DISTINCT last_checked) AS n FROM lookalike_domains`,
      ).get() as { n: number }).n;
      expect(distinct).toBeGreaterThan(1_000);
    });
  });
});
