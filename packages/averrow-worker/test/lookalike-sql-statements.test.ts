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
import {
  LOOKALIKE_DUE_PROBE_LIMIT,
  LOOKALIKE_DUE_GAUGE_CEILING,
  LOOKALIKE_RESCAN_ENQUEUE_LIMIT,
} from "../src/lib/lookalike-budget";
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
const fcSrc = read("../src/agents/flightControl.ts");
// 0031's CREATE TABLE + indexes now arrive via `applyLookalikeSchema`;
// 0268 is still read directly because two assertions are ABOUT the
// migration's text (that it refreshes statistics, table-scoped).
const migration0268 = read("../migrations/0268_lookalike_check_failure_cooldown.sql");
const migration0269 = read("../migrations/0269_lookalike_check_scheduling.sql");
const migration0267 = read("../migrations/0267_lookalike_baseline_established.sql");

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
  let withPredicate = hits[0]!;
  for (const [name, value] of Object.entries(SQL_INTERPOLATIONS)) {
    withPredicate = withPredicate.split(`\${${name}}`).join(String(value));
  }
  expect(withPredicate, "unsubstituted interpolation left in extracted SQL").not.toMatch(/\$\{/);
  return withPredicate;
}

/**
 * Compile-time constants the statements under test interpolate.
 *
 * `MONITORED_BRAND_PREDICATE_SQL` was the only one; Flight Control's due
 * gauge now also inlines `LOOKALIKE_DUE_PROBE_LIMIT`, because `cacheCount`
 * takes a bare SQL string with no bind parameters. Substituting from the
 * REAL exported constants keeps the "never retype a statement" contract
 * intact — a retyped `LIMIT 51` would silently stop tracking the
 * constant, which is the same defect class as the hand-typed `bimiSql`
 * this round deleted.
 */
const SQL_INTERPOLATIONS: Record<string, string | number> = {
  MONITORED_BRAND_PREDICATE_SQL,
  LOOKALIKE_DUE_PROBE_LIMIT,
};

// ─── The statements under test, by marker ─────────────────────────
// Named here so a failure message says WHICH statement moved, and so
// the marker sets are reviewable in one place.

const SQL = {
  /** The per-check UPDATE. Carries the single-write baseline CASE. */
  perCheckUpdate: () => sqlContaining(scannerSrc, ["SET registered = ?", "baseline_established_at = CASE"]),
  /**
   * The MONOTONIC threat_level + non-blanking ai_assessment persist.
   *
   * Markers are the two SET clauses, deliberately NOT the rank CASE's
   * contents: matching on those would make a deletion of the guard fail
   * at EXTRACTION rather than at the semantic assertions, which detects
   * exactly one edit and nothing else.
   */
  compositePersist: () => sqlContaining(scannerSrc, ["SET threat_level = CASE", "ai_assessment = CASE"]),
  /** The recurring BEC lane's guarded claim. */
  bimiClaim: () => sqlContaining(scannerSrc, ["SET bimi_first_seen_at = datetime('now')"]),
  /** The claim release, for any path that did not file the alert. */
  bimiRelease: () => sqlContaining(scannerSrc, ["SET bimi_first_seen_at = NULL"]),
  /** The Haiku lifetime gate's guarded claim (replaces a snapshot read). */
  haikuClaim: () => sqlContaining(scannerSrc, ["SET ai_claimed_at = datetime('now')"]),
  /** Its release, for a pass that produced no assessment. */
  haikuRelease: () => sqlContaining(scannerSrc, ["SET ai_claimed_at = NULL"]),
  /** The bounded un-park sweep — the ladder's only automatic way back. */
  unparkSweep: () => sqlContaining(scannerSrc, ["SET check_due_at = datetime('now')", "LIMIT ?"]),
  /** Sparrow's verification contract, reused from the lapse branch. */
  takedownDown: () => sqlContaining(scannerSrc, ["UPDATE takedown_requests", "verification_status = 'down'"]),
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
  /** The F6 unresolved-check branch: failure record + backoff, no state. */
  failureCooldown: () => sqlContaining(scannerSrc, ["SET last_check_failed_at = datetime('now')"]),
  /** "Scan now" — a priority ENQUEUE on `check_due_at`. */
  handlerReset: () => sqlContaining(handlerSrc, ["SET check_due_at = '1970-01-01 00:00:00'"]),
  firstContactSelect: () => sqlContaining(scannerSrc, ["FROM lookalike_domains ld", "ld.baseline_established_at IS NULL"]),
  recheckSelect: () => sqlContaining(scannerSrc, ["FROM lookalike_domains ld", "ld.baseline_established_at IS NOT NULL"]),
  /** The operator rescan's brand-scoped, bounded selector. */
  brandDueSelect: () => sqlContaining(scannerSrc, ["FROM lookalike_domains ld", "ld.brand_id = ?"]),
  firstAnalysisSelect: () => sqlContaining(analyzerSrc, ["FROM lookalike_domains ld", "page_fetched_at IS NULL"]),
  reanalysisSelect: () => sqlContaining(analyzerSrc, ["FROM lookalike_domains ld", "page_fetched_at IS NOT NULL"]),
  /**
   * Flight Control's two gauges. Extracted from FC rather than retyped
   * for the usual reason, plus one specific to them: the due gauge is
   * written as a SUM OF TWO COHORT SUBQUERIES purely so each half can
   * use its partial index, and a retyped single-predicate copy would
   * "prove" a plan the deployed query does not have.
   */
  fcDueGauge: () => sqlContaining(fcSrc, [
    "FROM lookalike_domains",
    "baseline_established_at IS NULL",
    "baseline_established_at IS NOT NULL",
  ]),
  fcParkedGauge: () => sqlContaining(fcSrc, ["FROM lookalike_domains", "WHERE check_due_at IS NULL"]),
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
  CREATE TABLE takedown_requests (
    id TEXT PRIMARY KEY,
    status TEXT,
    verification_status TEXT,
    last_verified_at TEXT,
    updated_at TEXT
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
      // Migration 0269. `check_due_at` defaults to DUE so a row seeded
      // here behaves like one the seeder inserted; a test that wants a
      // parked or future row says so.
      check_due_at: "2026-01-01 00:00:00",
      check_attempts: 0,
      bimi_first_seen_at: null,
      ai_claimed_at: null,
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
      check_due_at: string | null;
      check_attempts: number;
      bimi_first_seen_at: string | null;
      ai_claimed_at: string | null;
      threat_level: string | null;
      ai_assessment: string | null;
    };
  }

  beforeAll(() => {
    db = new DatabaseSync!(":memory:");
    db.exec(DDL);
    applyLookalikeSchema(db);
    // 0031's four indexes + 0227's takedown index + 0268's partial page
    // index + 0269's THREE (two cohort, one parked). If a migration
    // stops creating one of these the plan assertions below are what
    // notice.
    //
    // Three, not four: 0269 carried `idx_lookalike_bimi_due` on
    // `(registered, has_mx) WHERE registered = 1 AND has_mx = 1 AND
    // bimi_first_seen_at IS NULL` and it has been REMOVED as dead. No
    // query in `src/` selects on that predicate — the lane's only
    // statements are its guarded claim and release, both PK seeks — so
    // it cost an index entry per eligible row over a 56,010-row seed,
    // rewritten on every successful check (the success path writes both
    // `registered` and `has_mx`), for zero reads. The test that
    // "proved" it was hand-typing a `bimiSql` that existed nowhere in
    // `src/`, in the one file whose whole contract is that extracting
    // beats retyping.
    expect(
      lookalikeSchema().indexes.length,
      "expected index DDL to be extracted from the migrations",
    ).toBe(9);
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
     * webAnswered, hasWeb, firstContactFlag, cadenceModifier, id.
     *
     * The cadence modifier (migration 0269) is BOUND rather than inlined
     * so there is one named constant for "+24 hours" instead of the same
     * number written into three statements — which is how the old "Scan
     * now" handler came to encode it as the magic `-25 hours`.
     */
    function runCheck(id: string, firstContactFlag: 0 | 1, registered = 1) {
      return db.prepare(SQL.perCheckUpdate())
        .run(registered, 1, "5.6.7.8", 1, 1, 1, 1, firstContactFlag, "+24 hours", id);
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

    it("schedules the next check one cadence out and resets the attempt counter", () => {
      // Migration 0269: dueness is `check_due_at` and nothing else, so
      // the success path has to advance it. If it did not, every row
      // would stay permanently due and the cohort selects would re-serve
      // the same 50 rows every tick.
      const id = insert({ check_due_at: "2026-01-01 00:00:00", check_attempts: 4 });
      runCheck(id, 1);
      const row = fetch(id);
      expect(row.check_attempts).toBe(0);
      expect(row.check_due_at).not.toBe("2026-01-01 00:00:00");
      // ...and it is genuinely in the FUTURE, which is the property the
      // cohort predicate (`check_due_at <= datetime('now')`) reads.
      const stillDue = db.prepare(
        `SELECT 1 AS n FROM lookalike_domains
         WHERE id = ? AND check_due_at <= datetime('now')`,
      ).get(id);
      expect(stillDue, "a just-checked row must not still be due").toBeUndefined();
    });

    it("UN-PARKS a row the ladder had given up on", () => {
      // A parked row (`check_due_at IS NULL`) is unreachable by the
      // cohort selects, so the only ways back are the operator rescan
      // and — if something else reaches it — a successful check. Pinned
      // because the success path writes `check_due_at` unconditionally,
      // and that unconditional write is what makes recovery possible.
      const id = insert({ check_due_at: null, check_attempts: 9 });
      runCheck(id, 0);
      const row = fetch(id);
      expect(row.check_due_at).not.toBeNull();
      expect(row.check_attempts).toBe(0);
    });

    it("writes the DNS facts it is given", () => {
      const id = insert();
      db.prepare(SQL.perCheckUpdate()).run(1, 1, "9.9.9.9", 1, 1, 1, 0, 1, "+24 hours", id);
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
      db.prepare(SQL.perCheckUpdate()).run(1, 1, "5.6.7.8", 1, 1, 0, 0, 0, "+24 hours", id);
      expect(fetch(id).has_web).toBe(1);
    });

    it("an unanswered MX probe keeps the stored has_mx", () => {
      // A answers with a record -> `resolved` true -> this branch runs,
      // while the MX query timed out. `hasMx = false` over a stored 1
      // erases the mail evidence that IS the BEC-precursor signal.
      const id = known();
      db.prepare(SQL.perCheckUpdate()).run(1, 1, "5.6.7.8", 0, 0, 1, 1, 0, "+24 hours", id);
      expect(fetch(id).has_mx).toBe(1);
    });

    it("an unanswered A probe keeps the stored resolves_to", () => {
      // MX answers, A times out: `registered` is true, `resolved` is
      // true, and `result.ip` is undefined. `result.ip ?? null` then
      // ERASED a known IP — and both page cohorts require
      // `resolves_to IS NOT NULL`.
      const id = known();
      db.prepare(SQL.perCheckUpdate()).run(1, 0, null, 1, 1, 1, 1, 0, "+24 hours", id);
      expect(fetch(id).resolves_to).toBe("5.6.7.8");
    });

    it("an ANSWERED probe still writes a negative finding", () => {
      // The other direction, which matters just as much: "we looked and
      // there is no web server / no MX / no A record" is a real
      // observation and must be persisted. A gate that swallowed it
      // would make the columns write-once.
      const id = known();
      db.prepare(SQL.perCheckUpdate()).run(0, 1, null, 1, 0, 1, 0, 0, "+24 hours", id);
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
      db.prepare(SQL.perCheckUpdate()).run(0, 1, null, 1, 0, 0, 0, 0, "+24 hours", id);
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

  describe("the failed-check UPDATE", () => {
    /**
     * Bind order: attempts, nextDueAt (NULL = PARK), id.
     *
     * `check_attempts` is BOUND, not `check_attempts + 1`. The
     * statement used to derive the increment itself while the caller
     * derived it independently from the SELECT snapshot to pick the
     * ladder step — two derivations that diverge the moment anything
     * writes the column in between, which `persistCheckFacts` does
     * (`check_attempts = 0`) before every throw the per-row catch
     * absorbs. The ACCUMULATION and PARKING consequences are driven
     * end-to-end in `test/lookalike-review-fixes.test.ts`; what this
     * lane pins is that the statement writes exactly the value it is
     * handed.
     */
    const fail = (id: string, nextDueAt: string | null, attempts = 1) =>
      db.prepare(SQL.failureCooldown()).run(attempts, nextDueAt, id);

    it("writes NO registration state, and does not touch last_checked", () => {
      const id = insert({
        registered: 1,
        resolves_to: "5.6.7.8",
        has_mx: 1,
        has_web: 1,
        last_checked: "2026-09-01 00:00:00",
        first_seen: "2026-03-04 05:06:07",
      });
      fail(id, "2026-10-01 01:00:00");
      const row = fetch(id);
      // The whole point: a 3s DNS timeout must not manufacture a lapse.
      expect(row.registered).toBe(1);
      expect(row.resolves_to).toBe("5.6.7.8");
      // `last_checked` means "when did we last SUCCESSFULLY observe".
      expect(row.last_checked).toBe("2026-09-01 00:00:00");
      expect(row.first_seen).toBe("2026-03-04 05:06:07");
      expect(row.last_check_failed_at).not.toBeNull();
    });

    it("leaves baseline_established_at alone, so a failed first contact STAYS first contact", () => {
      // Since 0267's amendment this is the discriminator. A failed
      // attempt that stamped it would reclassify a never-observed row as
      // "baselined" while `registered` still held the seeder's INSERT
      // default — and the next successful check would then read the
      // resulting 0 -> 1 as a registration event.
      const id = insert();
      fail(id, "2026-10-01 01:00:00");
      const row = fetch(id);
      expect(row.baseline_established_at).toBeNull();
      expect(row.last_check_failed_at).not.toBeNull();
    });

    it("writes the attempt count it is GIVEN, not the column plus one", () => {
      // The mutation this catches: restoring `check_attempts =
      // check_attempts + 1` makes this 3 (2 in the column + 1) instead
      // of the 7 the caller computed. Those are the same number only
      // while nothing else writes the column, which is exactly the
      // assumption that failed.
      const id = insert({ check_attempts: 2 });
      fail(id, "9999-01-01 00:00:00", 7);
      const row = fetch(id);
      expect(row.check_attempts).toBe(7);
      expect(row.check_due_at).toBe("9999-01-01 00:00:00");
      // ...and it is therefore out of its cohort.
      const first = (db.prepare(SQL.firstContactSelect()).all(50) as Array<{ id: string }>).map((r) => r.id);
      expect(first, "deferred by the ladder").not.toContain(id);
    });

    it("A NULL due stamp PARKS the row out of both cohort indexes entirely", () => {
      // The terminal step, and the structural part of it: a parked row
      // is not merely deprioritized, it holds no entry in either partial
      // index. The predicates below are the ones the indexes are built
      // on, so "absent from both" is the same statement as "costs zero
      // reads".
      const parked = insert({ check_attempts: 8 });
      const healthy = insert({ baseline_established_at: "2026-06-01 00:00:00" });
      fail(parked, null, 9);
      expect(fetch(parked).check_due_at).toBeNull();
      expect(fetch(parked).check_attempts).toBe(9);

      const first = (db.prepare(SQL.firstContactSelect()).all(50) as Array<{ id: string }>).map((r) => r.id);
      const recheck = (db.prepare(SQL.recheckSelect()).all(50, 0) as Array<{ id: string }>).map((r) => r.id);
      expect(first).not.toContain(parked);
      expect(recheck).not.toContain(parked);
      // The healthy row is still there, so this is not a vacuous pass
      // from an empty cohort.
      expect(recheck).toContain(healthy);
    });

    it("the parked row is exactly what Flight Control's parked gauge counts", () => {
      insert();
      insert({ baseline_established_at: "2026-06-01 00:00:00" });
      const parked = insert();
      fail(parked, null);
      const n = (db.prepare(SQL.fcParkedGauge()).get() as { count: number }).count;
      expect(n).toBe(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // The monotonic persist + the non-blanking assessment
  // ═════════════════════════════════════════════════════════════════
  //
  // Mutation-checked: replacing the rank CASE with a bare
  // `threat_level = ?` fails three cases here; replacing the assessment
  // CASE with a bare `ai_assessment = ?` fails two.

  describe("the compositor's persist UPDATE", () => {
    const RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    /** Bind order: newRank, newLevel, hasAssessment, assessment, id. */
    const persist = (id: string, level: string, assessment: string | null) =>
      db.prepare(SQL.compositePersist())
        .run(RANK[level]!, level, assessment === null ? 0 : 1, assessment, id);

    it("raises a stored level", () => {
      const id = insert({ threat_level: "MEDIUM" });
      persist(id, "HIGH", null);
      expect(fetch(id).threat_level).toBe("HIGH");
    });

    it("NEVER lowers a stored level", () => {
      // The live bug re-entrancy created. `threat_level` was seeded
      // fresh at MEDIUM each pass and written back unconditionally, so a
      // row at CRITICAL from a page escalation was written DOWN to HIGH
      // on any pass where the inline page budget was exhausted — and
      // `agents/sparrow.ts` reads this column for takedown ELIGIBILITY
      // and PRIORITY.
      const id = insert({ threat_level: "CRITICAL" });
      persist(id, "HIGH", null);
      expect(fetch(id).threat_level).toBe("CRITICAL");
    });

    it("restates an equal level rather than losing it", () => {
      const id = insert({ threat_level: "HIGH" });
      persist(id, "HIGH", null);
      expect(fetch(id).threat_level).toBe("HIGH");
    });

    it("materializes a level on a row whose threat_level is NULL", () => {
      // The reason the rank comparison is `>=` and not `>`. A NULL
      // ranks as the floor (0), so a LOW verdict would be `0 > 0` —
      // false — and the row would stay NULL forever, unreachable by the
      // only verdict that could ever describe it.
      const id = insert({ threat_level: null });
      persist(id, "LOW", null);
      expect(fetch(id).threat_level).toBe("LOW");
    });

    it("does NOT blank a good ai_assessment when this pass produced none", () => {
      // The second live bug. `ai_assessment` was written unconditionally
      // from a variable initialised `''`, so a failed or throttled Haiku
      // call erased the assessment `agents/sparrow.ts` embeds in the
      // takedown evidence packet.
      const id = insert({ ai_assessment: "a careful earlier verdict" });
      persist(id, "HIGH", null);
      expect(fetch(id).ai_assessment).toBe("a careful earlier verdict");
    });

    it("writes an assessment this pass DID produce", () => {
      const id = insert({ ai_assessment: null });
      persist(id, "HIGH", "fresh verdict");
      expect(fetch(id).ai_assessment).toBe("fresh verdict");
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // The recurring BEC lane's claim-then-act
  // ═════════════════════════════════════════════════════════════════

  describe("the BIMI claim and release", () => {
    it("claims an unclaimed row exactly once", () => {
      const id = insert();
      const first = db.prepare(SQL.bimiClaim()).run(id);
      expect(first.changes, "the claim").toBe(1);
      const second = db.prepare(SQL.bimiClaim()).run(id);
      // THE idempotency guarantee: only the writer that sees 1 may file,
      // so a second pass (or a second producer) files nothing.
      expect(second.changes, "the second claim").toBe(0);
      expect(fetch(id).bimi_first_seen_at).not.toBeNull();
    });

    it("the release puts the row back in the lane", () => {
      // Without the release a thrown `createAlert` would leave the row
      // marked "BIMI recorded" with no alert anywhere, and the lane's own
      // eligibility predicate would never offer it again.
      const id = insert();
      db.prepare(SQL.bimiClaim()).run(id);
      db.prepare(SQL.bimiRelease()).run(id);
      expect(fetch(id).bimi_first_seen_at).toBeNull();
      expect(db.prepare(SQL.bimiClaim()).run(id).changes).toBe(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // The lapse branch reuses Sparrow's verification contract
  // ═════════════════════════════════════════════════════════════════

  describe("the takedown verification write", () => {
    beforeEach(() => {
      db.prepare(`DELETE FROM takedown_requests`).run();
    });

    it("stamps a taken-down takedown as verified down", () => {
      db.prepare(
        `INSERT INTO takedown_requests (id, status, verification_status, last_verified_at)
         VALUES ('td1', 'taken_down', NULL, NULL)`,
      ).run();
      const res = db.prepare(SQL.takedownDown()).run("td1");
      expect(res.changes).toBe(1);
      const td = db.prepare(`SELECT * FROM takedown_requests WHERE id = 'td1'`).get() as {
        verification_status: string | null; last_verified_at: string | null;
      };
      expect(td.verification_status).toBe("down");
      expect(td.last_verified_at).not.toBeNull();
    });

    it("does NOT touch a takedown that is not in 'taken_down' status", () => {
      // `verification_status` describes a taken-down target. A
      // submitted-but-unconfirmed takedown's lifecycle stays Sparrow's
      // to advance, and writing 'down' on it would claim a confirmation
      // nobody gave.
      db.prepare(
        `INSERT INTO takedown_requests (id, status, verification_status, last_verified_at)
         VALUES ('td2', 'submitted', NULL, NULL)`,
      ).run();
      expect(db.prepare(SQL.takedownDown()).run("td2").changes).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // The Haiku lifetime gate is a CLAIM, not a snapshot read
  // ═════════════════════════════════════════════════════════════════
  //
  // The gate was `row.ai_assessment === null` off the SELECT snapshot —
  // a read-then-act, where the BIMI lane (whose cost is a DNS lookup
  // rather than tokens) already used a guarded claim. Two concurrent
  // runs over the same first-contact row, which is what repeated
  // "Scan now" presses produce, could both read NULL and both spend.

  describe("the Haiku claim", () => {
    /** Bind order: id, staleness modifier. */
    const claim = (id: string, stale = "-1 hour") =>
      db.prepare(SQL.haikuClaim()).run(id, stale);

    it("exactly ONE of two concurrent claims on the same row succeeds", () => {
      const id = insert();
      expect(claim(id).changes, "first claim").toBe(1);
      expect(claim(id).changes, "second claim").toBe(0);
      expect(fetch(id).ai_claimed_at).not.toBeNull();
    });

    it("refuses a row that already HAS an assessment", () => {
      // The lifetime bound itself. `ai_assessment IS NULL` is restated
      // in the statement rather than trusted from the caller's snapshot,
      // which is the whole point — the snapshot may be stale.
      const id = insert({ ai_assessment: "assessed already" });
      expect(claim(id).changes).toBe(0);
      expect(fetch(id).ai_claimed_at).toBeNull();
    });

    it("the release makes the row claimable again", () => {
      // A throttled or failed call must leave the row DEFERRED, not
      // retired — exactly what the pre-claim read did for that case.
      const id = insert();
      expect(claim(id).changes).toBe(1);
      db.prepare(SQL.haikuRelease()).run(id);
      expect(fetch(id).ai_claimed_at).toBeNull();
      expect(claim(id).changes).toBe(1);
    });

    it("a STALE claim is reclaimable, so a killed worker cannot retire the row", () => {
      // Why this is a dedicated column and not a sentinel written into
      // `ai_assessment`. A worker killed between claim and persist leaves
      // the marker behind; with the marker in `ai_assessment` the gate
      // would never fire again, the compositor's base would fall back to
      // the stored LOW, and both infrastructure boosts are MEDIUM-only —
      // so a mail+web row would sit at LOW forever and never clear the
      // HIGH alert floor. Mutation-checked: deleting the
      // `ai_claimed_at <= datetime('now', ?)` arm makes this 0.
      const id = insert({ ai_claimed_at: "2020-01-01 00:00:00" });
      expect(claim(id).changes).toBe(1);
    });

    it("a FRESH claim is not reclaimable", () => {
      // The other direction: the staleness window must not be so loose
      // that it defeats the claim it is protecting.
      const id = insert();
      expect(claim(id).changes).toBe(1);
      expect(claim(id).changes).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // The un-park sweep — the ladder's only AUTOMATIC way back
  // ═════════════════════════════════════════════════════════════════

  describe("the un-park sweep", () => {
    /** Bind order: minimum park age (a datetime modifier), LIMIT. */
    const sweep = (modifier = "-7 days", limit = 25) =>
      db.prepare(SQL.unparkSweep()).run(modifier, limit);

    const parkedAt = (stamp: string, over: Record<string, unknown> = {}) =>
      insert({ check_due_at: null, check_attempts: 9, last_check_failed_at: stamp, ...over });

    it("re-admits a long-parked row into its cohort", () => {
      // The gap this closes: FOUR writers touch `check_due_at` and three
      // of them require the row to have been SELECTED, which a parked row
      // is not. The only exit was the MANUAL per-brand rescan.
      const id = parkedAt("2020-01-01 00:00:00", { baseline_established_at: "2026-06-01 00:00:00" });
      expect(sweep().changes).toBe(1);
      expect(fetch(id).check_due_at).not.toBeNull();
      const recheck = (db.prepare(SQL.recheckSelect()).all(50, 0) as Array<{ id: string }>).map((r) => r.id);
      expect(recheck).toContain(id);
    });

    it("leaves a RECENTLY parked row alone", () => {
      // The self-throttle. `last_check_failed_at` is written only by the
      // failure path, so on a parked row it is frozen at the moment it
      // parked — which is what makes "parked for longer than the window"
      // a true statement with no cursor and no counter column.
      // Mutation-checked: deleting the age term makes this 1.
      const id = parkedAt("2026-09-30 23:00:00");
      expect(sweep().changes).toBe(0);
      expect(fetch(id).check_due_at).toBeNull();
    });

    it("is BOUNDED, oldest park first", () => {
      const oldest = parkedAt("2019-01-01 00:00:00");
      const middle = parkedAt("2020-01-01 00:00:00");
      const newest = parkedAt("2021-01-01 00:00:00");
      expect(sweep("-7 days", 2).changes).toBe(2);
      expect(fetch(oldest).check_due_at).not.toBeNull();
      expect(fetch(middle).check_due_at).not.toBeNull();
      expect(fetch(newest).check_due_at).toBeNull();
    });

    it("does NOT reset check_attempts — one probe per window, not a ladder replay", () => {
      // Resetting the counter would send a still-dead row back through
      // the whole 1h/4h/12h/24h/48h ladder — ~8 further DNS probes over
      // 10 days — every window. Leaving it past the terminal count means
      // the row is probed ONCE and re-parks on that single failure,
      // which is what makes the sweep affordable at scale. A SUCCESSFUL
      // observation still resets it, via the success path.
      const id = parkedAt("2020-01-01 00:00:00");
      sweep();
      expect(fetch(id).check_attempts).toBe(9);
    });

    it("touches no row that is not parked", () => {
      const healthy = insert({ check_due_at: "2026-09-29 12:00:00", last_check_failed_at: "2019-01-01 00:00:00" });
      sweep();
      expect(fetch(healthy).check_due_at).toBe("2026-09-29 12:00:00");
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // "Scan now" is a priority ENQUEUE
  // ═════════════════════════════════════════════════════════════════

  describe("the handleScanLookalikes enqueue UPDATE", () => {
    /**
     * Bind order: brandId, LIMIT.
     *
     * The LIMIT is the bound this round added. The statement used to be
     * `WHERE brand_id = ?` with no cap, over a GLOBAL cross-tenant queue
     * ordered by `check_due_at ASC` and drained 50 rows a tick — so an
     * org-scoped caller scripting the endpoint could pin an unbounded
     * number of their own rows to the head of that queue and starve
     * every other tenant indefinitely. The default here is the
     * production value so the ordinary assertions read unchanged; the
     * bound itself gets its own cases below.
     */
    const enqueue = (limit = LOOKALIKE_RESCAN_ENQUEUE_LIMIT) =>
      db.prepare(SQL.handlerReset()).run("b1", limit);

    it("puts the brand's rows at the FRONT of their cohort, ahead of every real stamp", () => {
      // What the old `-25 hours` CASE could only approximate. The epoch
      // is earlier than any stamp the system can produce, so these rows
      // sort first unconditionally rather than "first among rows checked
      // more than 25 hours ago".
      const ahead = insert({ baseline_established_at: "2026-06-01 00:00:00", check_due_at: "2020-01-01 00:00:00" });
      enqueue();
      const order = (db.prepare(SQL.recheckSelect()).all(50, 0) as Array<{ id: string }>).map((r) => r.id);
      expect(order[0]).toBe(ahead);
      expect(fetch(ahead).check_due_at).toBe("1970-01-01 00:00:00");
    });

    it("does NOT touch last_checked, so first contact is unforgeable from here", () => {
      // THE fix this endpoint needed. Its previous two forms both wrote
      // `last_checked` — first NULL (which CLAIMED we had never looked,
      // reclassifying a real registration as a baseline), then a `CASE`
      // working around that. With dueness in its own column there is
      // nothing to work around: the discriminator is simply not
      // reachable from here.
      const checked = insert({ last_checked: "2026-09-29 12:00:00", baseline_established_at: "2026-06-01 00:00:00", registered: 1 });
      const never = insert();
      enqueue();
      expect(fetch(checked).last_checked).toBe("2026-09-29 12:00:00");
      expect(fetch(checked).baseline_established_at).toBe("2026-06-01 00:00:00");
      expect(fetch(never).last_checked).toBeNull();
      expect(fetch(never).baseline_established_at).toBeNull();
      // ...and each still lands in the cohort it belongs to.
      const recheck = (db.prepare(SQL.recheckSelect()).all(50, 0) as Array<{ id: string }>).map((r) => r.id);
      const first = (db.prepare(SQL.firstContactSelect()).all(50) as Array<{ id: string }>).map((r) => r.id);
      expect(recheck).toContain(checked);
      expect(first).toContain(never);
    });

    it("REVIVES a row the backoff ladder had parked", () => {
      // An operator asking for a scan is exactly the signal that the
      // ladder's give-up verdict should be retried, and a parked row is
      // unreachable by the cohort selects — so without the
      // `check_attempts = 0` + epoch write it would stay unreachable
      // forever.
      const parked = insert({ check_due_at: null, check_attempts: 9, baseline_established_at: "2026-06-01 00:00:00" });
      enqueue();
      const row = fetch(parked);
      expect(row.check_due_at).toBe("1970-01-01 00:00:00");
      expect(row.check_attempts).toBe(0);
      const recheck = (db.prepare(SQL.recheckSelect()).all(50, 0) as Array<{ id: string }>).map((r) => r.id);
      expect(recheck).toContain(parked);
    });

    it("clears the DNS failure record so the rescan is not held off", () => {
      const id = insert({ last_check_failed_at: "2026-09-30 11:00:00" });
      enqueue();
      expect(fetch(id).last_check_failed_at).toBeNull();
    });

    it("touches only the named brand", () => {
      db.prepare(`INSERT OR IGNORE INTO brands (id, name, canonical_domain, tier) VALUES ('b2','Other','other.example','monitored')`).run();
      const mine = insert({ check_due_at: "2026-09-29 12:00:00" });
      const theirs = insert({ brand_id: "b2", check_due_at: "2026-09-29 12:00:00" });
      enqueue();
      expect(fetch(mine).check_due_at).toBe("1970-01-01 00:00:00");
      expect(fetch(theirs).check_due_at).toBe("2026-09-29 12:00:00");
    });

    it("is BOUNDED — one press cannot enqueue more than its limit", () => {
      // THE UNBOUNDED CASE. Both cohort selectors are `ORDER BY
      // check_due_at ASC` over a global, cross-tenant queue drained 50
      // rows a tick, so an un-capped epoch write is a
      // queue-starvation primitive: a scripted caller pins an arbitrary
      // number of their own rows to the head of it. Mutation-checked:
      // deleting the `LIMIT ?` makes this 7 instead of 3.
      const ids = Array.from({ length: 7 }, (_, i) =>
        insert({ check_due_at: `2026-09-2${i} 12:00:00` }));
      enqueue(3);
      const stamped = ids.filter((id) => fetch(id).check_due_at === "1970-01-01 00:00:00");
      expect(stamped.length).toBe(3);
    });

    it("prefers PARKED rows, then the most overdue", () => {
      // `ORDER BY check_due_at ASC` puts SQLite's NULLs first, which is
      // the behaviour we want: an operator pressing "Scan now" is
      // asking for exactly the rows the ladder gave up on, and those are
      // the rows no other writer can reach.
      const parked = insert({ check_due_at: null, check_attempts: 9 });
      const old = insert({ check_due_at: "2026-01-01 00:00:00" });
      const recent = insert({ check_due_at: "2026-09-30 00:00:00" });
      enqueue(2);
      expect(fetch(parked).check_due_at).toBe("1970-01-01 00:00:00");
      expect(fetch(old).check_due_at).toBe("1970-01-01 00:00:00");
      expect(fetch(recent).check_due_at).toBe("2026-09-30 00:00:00");
    });

    it("SKIPS rows already at the epoch, so repeated presses cannot grow the claim", () => {
      // What makes the bound hold over TIME rather than per call. A
      // scripted loop re-stamps NOTHING until the previous batch has
      // drained, so one brand can hold at most `limit` rows at the head
      // of the global queue at any instant and can only refresh them as
      // fast as the checker drains them — no cooldown table, no KV, no
      // clock. Mutation-checked: deleting the `check_due_at >
      // '1970-01-01 00:00:00'` term makes the second press report 2
      // changed rows instead of 1, and the brand's head-of-queue claim
      // then grows without limit across presses.
      const first = insert({ check_due_at: "2026-01-01 00:00:00" });
      const second = insert({ check_due_at: "2026-02-01 00:00:00" });
      expect(enqueue(1).changes).toBe(1);
      expect(fetch(first).check_due_at).toBe("1970-01-01 00:00:00");
      // Second press: the already-enqueued row is skipped, so the one
      // slot goes to the NEXT row rather than re-stamping the first.
      expect(enqueue(1).changes).toBe(1);
      expect(fetch(second).check_due_at).toBe("1970-01-01 00:00:00");
      // Third press with both enqueued: nothing left to claim.
      expect(enqueue(1).changes).toBe(0);
    });

    it("the brand-scoped selector serves only that brand, bounded", () => {
      db.prepare(`INSERT OR IGNORE INTO brands (id, name, canonical_domain, tier) VALUES ('b2','Other','other.example','monitored')`).run();
      const mine = [insert(), insert(), insert()];
      const theirs = insert({ brand_id: "b2" });
      const got = (db.prepare(SQL.brandDueSelect()).all("b1", 2) as Array<{ id: string }>).map((r) => r.id);
      expect(got.length, "bounded by the limit").toBe(2);
      for (const id of got) expect(mine).toContain(id);
      expect(got).not.toContain(theirs);
    });

    it("the brand-scoped selector skips rows that are not due, and parked ones", () => {
      const due = insert();
      const later = insert({ check_due_at: "9999-01-01 00:00:00" });
      const parked = insert({ check_due_at: null });
      const got = (db.prepare(SQL.brandDueSelect()).all("b1", 50) as Array<{ id: string }>).map((r) => r.id);
      expect(got).toEqual([due]);
      expect(got).not.toContain(later);
      expect(got).not.toContain(parked);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // NO DOUBLE-SOURCING — the comment, as a failing test
  // ═════════════════════════════════════════════════════════════════

  describe("the cohort SELECTs source dueness from ONE column", () => {
    /** The WHERE clause only — the projection may legitimately read anything. */
    function whereOf(sql: string): string {
      const m = sql.match(/\bWHERE\b([\s\S]*)$/i);
      expect(m, "no WHERE clause found — the extraction moved").toBeTruthy();
      return m![1]!;
    }

    for (const [label, sql] of [
      ["first contact", SQL.firstContactSelect],
      ["re-check", SQL.recheckSelect],
      ["brand-scoped", SQL.brandDueSelect],
    ] as Array<[string, () => string]>) {
      it(`${label} mentions neither last_checked nor last_check_failed_at in its WHERE`, () => {
        // `last_checked` used to carry THREE jobs — last success, dueness
        // and the first-contact discriminator — so every scheduling write
        // was also a reclassification. It now carries exactly one, and
        // `last_check_failed_at` is a pure historical record. Both have
        // live READERS that mean precisely that (`agents/observer.ts`'s
        // 24 h briefing count, the staff and tenant column lists), which
        // is why neither was deleted; what must not come back is either
        // one appearing in a SELECTION predicate. A comment saying so
        // decays. This does not.
        const where = whereOf(sql());
        expect(where, `${label} WHERE: ${where}`).not.toMatch(/\blast_checked\b/);
        expect(where, `${label} WHERE: ${where}`).not.toMatch(/\blast_check_failed_at\b/);
      });
    }

    it("Flight Control's due gauge is sourced the same way", () => {
      const sql = SQL.fcDueGauge();
      expect(sql).not.toMatch(/\blast_checked\b/);
      expect(sql).not.toMatch(/\blast_check_failed_at\b/);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // B1 — the cohorts are DISJOINT and their union is the old set
  // ═════════════════════════════════════════════════════════════════

  describe("the four cohort SELECTs partition the due set", () => {
    it("the checker's two cohorts are disjoint and cover every due row", () => {
      const never = insert();
      const stale = insert({ baseline_established_at: "2026-06-01 00:00:00" });
      const fresh = insert({ check_due_at: "9999-01-01 00:00:00" });

      const first = (db.prepare(SQL.firstContactSelect()).all(50) as Array<{ id: string }>).map((r) => r.id);
      const recheck = (db.prepare(SQL.recheckSelect()).all(50, 0) as Array<{ id: string }>).map((r) => r.id);

      expect(first).toEqual([never]);
      expect(recheck).toEqual([stale]);
      // A row not yet due is in NEITHER — the split did not widen the
      // population, only how its budget is allocated.
      expect([...first, ...recheck]).not.toContain(fresh);
    });

    it("the due gauge counts exactly the union of the two cohorts", () => {
      // Flight Control's gauge is written as a sum of two cohort
      // subqueries so each half can use its partial index. This pins
      // that the arithmetic agrees with what the checker would select —
      // a gauge that counts a different set is worse than no gauge.
      insert();
      insert();
      insert({ baseline_established_at: "2026-06-01 00:00:00" });
      insert({ check_due_at: "9999-01-01 00:00:00" });
      insert({ check_due_at: null });
      const first = (db.prepare(SQL.firstContactSelect()).all(500) as unknown[]).length;
      const recheck = (db.prepare(SQL.recheckSelect()).all(500, 0) as unknown[]).length;
      const gauge = (db.prepare(SQL.fcDueGauge()).get() as { count: number }).count;
      expect(gauge).toBe(first + recheck);
      expect(gauge).toBe(3);
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
        insert({
          baseline_established_at: "2026-06-01 00:00:00",
          check_due_at: `2026-09-0${n} 00:00:00`,
        }),
      );
      const head = (db.prepare(SQL.recheckSelect()).all(2, 0) as Array<{ id: string }>).map((r) => r.id);
      const spill = (db.prepare(SQL.recheckSelect()).all(3, 2) as Array<{ id: string }>).map((r) => r.id);
      // MOST OVERDUE first, and the two slices tile the cohort without
      // overlapping — which is what makes the spill safe to merge.
      expect(head).toEqual(ids.slice(0, 2));
      expect(spill).toEqual(ids.slice(2, 5));
    });

    it("both cohorts serve the MOST OVERDUE row first", () => {
      // The due timestamp IS the priority — there is no `priority`
      // column, deliberately (see migration 0269: with no equality on a
      // leading column, `ORDER BY priority DESC, check_due_at ASC`
      // cannot seek and walks the whole `priority = 0` group). So the
      // ordering has to be load-bearing on its own, in BOTH cohorts.
      const newer = insert({ check_due_at: "2026-09-20 00:00:00" });
      const older = insert({ check_due_at: "2026-02-02 00:00:00" });
      const first = (db.prepare(SQL.firstContactSelect()).all(50) as Array<{ id: string }>).map((r) => r.id);
      expect(first).toEqual([older, newer]);

      const rNewer = insert({ baseline_established_at: "2026-06-01 00:00:00", check_due_at: "2026-09-20 00:00:00" });
      const rOlder = insert({ baseline_established_at: "2026-06-01 00:00:00", check_due_at: "2026-02-02 00:00:00" });
      const recheck = (db.prepare(SQL.recheckSelect()).all(50, 0) as Array<{ id: string }>).map((r) => r.id);
      expect(recheck).toEqual([rOlder, rNewer]);
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
     * `check_due_at` / `page_fetched_at` are seeded with a DISTINCT
     * stamp per row, spread over an hour, because `sqlite_stat1` records
     * only average rows-per-value and a plan can turn on it. The
     * measured case is 0268's: a fixture seeding two constant
     * `last_checked` values drives that average to 18,670-of-56,010 and
     * the planner then emits `SCAN ld` for the old `IS NULL`-keyed
     * first-contact cohort, flipping back at three or more distinct
     * values. Read that migration's "ONE MEASURED SENSITIVITY" note
     * before simplifying any of this.
     *
     * 0269's two cohort indexes are NOT exposed to that particular
     * regime — they are partial on `check_due_at IS NOT NULL`, so every
     * indexed row has a real value and there is no NULL bucket for
     * stat1 to mis-price. The per-row stamping is kept anyway: it is
     * what the page cohorts still need, and a fixture that is realistic
     * in one dimension and degenerate in another is the shape that
     * produced the dead assertions this block replaced.
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
      /** Comfortably in the FUTURE — a `check_due_at` that is not yet due. */
      const laterBase = now + 20 * 3600_000;

      const li = fresh.prepare(
        `INSERT INTO lookalike_domains
           (id, brand_id, domain, permutation_type, registered, resolves_to,
            has_mx, has_web, last_checked, page_fetched_at,
            baseline_established_at, check_due_at, check_attempts,
            bimi_first_seen_at)
         VALUES (?, ?, ?, 'replacement', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let checkSlot = 0;
      let pageSlot = 0;
      let dueSlot = 0;
      for (let i = 0; i < ROWS; i += 1) {
        const registered = i % 4 === 0 ? 1 : 0;
        const hasWeb = registered === 1 && i % 10 < 7 ? 1 : 0;
        const hasMx = registered === 1 && i % 3 === 0 ? 1 : 0;
        // 30% already baselined (observed at least once), half of those
        // with a stale `last_checked`. Each gets its own second.
        let lastChecked: string | null = null;
        if (i % 10 < 3) {
          const slot = checkSlot++;
          lastChecked = stamp(slot % 2 === 0 ? staleBase : freshBase, slot % 1800);
        }
        // `baseline_established_at` is now the COHORT discriminator, and
        // it tracks `last_checked` on a real row (migration 0267's
        // disambiguation UPDATE sets exactly that for legacy rows).
        const baseline = lastChecked;
        // `check_due_at` is the SCHEDULING column and is independent of
        // the cohort: ~half the table is due now, ~half is not, and 1%
        // is PARKED (NULL) so both cohort indexes have entries excluded
        // and the parked gauge has something to count.
        let checkDue: string | null;
        if (i % 100 === 0) checkDue = null;
        else {
          const slot = dueSlot++;
          checkDue = stamp(slot % 2 === 0 ? staleBase : laterBase, slot % 1800);
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
          hasMx,
          hasWeb,
          lastChecked,
          pageFetched,
          baseline,
          checkDue,
          checkDue === null ? 9 : 0,
          // A seventh of the mail-bearing rows already claimed by the
          // BEC lane, so `idx_lookalike_bimi_due`'s partial predicate
          // excludes a real slice rather than nothing.
          registered === 1 && hasMx === 1 && i % 7 === 0 ? "2026-09-01 00:00:00" : null,
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
      { label: "checker / first contact", sql: SQL.firstContactSelect, params: [50], index: "idx_lookalike_due_first_contact" },
      { label: "checker / re-check", sql: SQL.recheckSelect, params: [50, 0], index: "idx_lookalike_due_recheck" },
      { label: "page / first analysis", sql: SQL.firstAnalysisSelect, params: [20], index: "idx_lookalike_page_due" },
      { label: "page / re-analysis", sql: SQL.reanalysisSelect, params: [20, 0], index: "idx_lookalike_page_due" },
    ];

    it("the plan fixture is actually populated — no vacuous plan below", () => {
      // The empty-table mistake, guarded explicitly rather than trusted.
      const c = planDb.prepare(
        `SELECT COUNT(*) AS n,
                SUM(baseline_established_at IS NULL) AS never_baselined,
                SUM(registered) AS registered,
                SUM(page_fetched_at IS NOT NULL) AS paged,
                SUM(check_due_at IS NULL) AS parked,
                SUM(check_due_at IS NOT NULL AND check_due_at <= datetime('now')) AS due
           FROM lookalike_domains`,
      ).get() as {
        n: number; never_baselined: number; registered: number;
        paged: number; parked: number; due: number;
      };
      expect(c.n).toBe(ROWS);
      expect(c.never_baselined).toBeGreaterThan(30_000);
      expect(c.registered).toBeGreaterThan(10_000);
      expect(c.paged).toBeGreaterThan(1_000);
      // Both ends of the scheduling column are represented: a parked
      // slice (excluded from both cohort indexes) and a large due slice.
      expect(c.parked).toBeGreaterThan(100);
      expect(c.due).toBeGreaterThan(10_000);
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
          // existed to catch. Mutation-checked: dropping either cohort
          // index yields `SCAN ld`, which the old assertion passed and
          // this one fails.
          expect(detail, `${state}: ${detail}`).not.toMatch(/\bSCAN\b/);
        }
      });
    }

    it("the checker's cohorts use SEPARATE indexes — neither borrows the other's", () => {
      // The split is only worth its two indexes if each cohort actually
      // uses its own. A single shared index on `check_due_at` would make
      // both cohorts scan past the other's rows, which is the cost the
      // partial predicates exist to avoid.
      for (const [state, target] of STATES()) {
        const first = plan(target, SQL.firstContactSelect(), [50]);
        const recheck = plan(target, SQL.recheckSelect(), [50, 0]);
        expect(first, `${state}: ${first}`).not.toContain("idx_lookalike_due_recheck");
        expect(recheck, `${state}: ${recheck}`).not.toContain("idx_lookalike_due_first_contact");
      }
    });

    it("Flight Control's gauges are index reads, not table scans", () => {
      // The due gauge is a sum of two cohort subqueries precisely so each
      // half implies a partial index; a single-predicate
      // `check_due_at <= datetime('now')` count would imply neither and
      // full-scan the table on every FC tick. The parked gauge reads its
      // own partial index, which is tiny by construction — an index-only
      // `SCAN ... USING INDEX` there is the cheap form, not the one the
      // bare `\bSCAN\b` assertion above is hunting.
      for (const [state, target] of STATES()) {
        const due = plan(target, SQL.fcDueGauge(), []);
        expect(due, `${state}: ${due}`).toContain("idx_lookalike_due_first_contact");
        expect(due, `${state}: ${due}`).toContain("idx_lookalike_due_recheck");
        expect(due, `${state}: ${due}`).not.toMatch(/\bSCAN lookalike_domains\b(?! USING)/);

        const parked = plan(target, SQL.fcParkedGauge(), []);
        expect(parked, `${state}: ${parked}`).toContain("idx_lookalike_parked");
      }
    });

    it("the due gauge is a BOUNDED probe — it stops counting at its ceiling", () => {
      // The gauge's two consumers are a log string and the boolean
      // `current > drainPerTick`, and both cohort halves are index RANGE
      // counts — one index entry read per DUE row. The plan fixture
      // seeds ~half the table due, at a projected 56,010 rows, and the
      // gauge is recomputed ~12x/day: 300K-600K index reads a day to
      // produce a boolean.
      //
      // `LIMIT 51` per cohort answers that boolean EXACTLY (51 already
      // beats the 50-row drain however the cohorts split it) for at
      // most 102 reads. Measured against the SEEDED fixture, not an
      // empty table, so a removed LIMIT genuinely overshoots.
      // Mutation-checked: deleting either `LIMIT` returns tens of
      // thousands and fails this.
      for (const [state, target] of STATES()) {
        const row = target.prepare(SQL.fcDueGauge()).get() as { count: number };
        expect(row.count, `${state}: gauge above its ceiling`)
          .toBeLessThanOrEqual(LOOKALIKE_DUE_GAUGE_CEILING);
        // And not vacuously small — the fixture has far more than a
        // tick's worth due, so the probe must be pegged AT the ceiling.
        expect(row.count, `${state}: gauge should be saturated on this fixture`)
          .toBe(LOOKALIKE_DUE_GAUGE_CEILING);
      }
    });

    // NO PLAN TEST FOR THE BEC LANE, deliberately. There is no cohort
    // query to plan: the lane rides the DNS checker's own selection and
    // its two statements are PK seeks. The test that used to live here
    // hand-typed a `bimiSql` that appears nowhere in `src/` and asserted
    // a plan for it, which tested SQLite rather than Averrow — in the one
    // file whose stated contract is that extracting beats retyping. The
    // index it "proved" is gone with it; see the index-count assertion
    // above.

    it("the un-park sweep is an index range scan over the parked set", () => {
      // The oldest-parked subquery, over a set that is tiny by
      // construction but still must not be a table scan: it runs on
      // EVERY checker tick. `idx_lookalike_parked` is keyed on
      // `last_check_failed_at` (not `id`) precisely so this is a range
      // scan in index order with no sort step — the gauge above is served
      // either way, this is the reader that needed the key.
      for (const [state, target] of STATES()) {
        const detail = plan(target, SQL.unparkSweep(), ["-7 days", 25]);
        expect(detail, `${state}: ${detail}`).toContain("idx_lookalike_parked");
        expect(detail, `${state}: ${detail}`).not.toMatch(/\bSCAN lookalike_domains\b(?! USING)/);
        expect(detail, `${state}: ${detail}`).not.toMatch(/TEMP B-TREE/i);
      }
    });

    it("the bounded rescan enqueue seeks by brand", () => {
      // The epoch write is now `WHERE id IN (SELECT ... LIMIT ?)`. The
      // inner select must still seek on `brand_id` rather than scan a
      // table headed for ~56,010 rows — a sort over one brand's ~30 rows
      // is acceptable and is what the ORDER BY buys (parked rows first),
      // so TEMP B-TREE is deliberately NOT asserted against here.
      for (const [state, target] of STATES()) {
        const detail = plan(target, SQL.handlerReset(), ["b3", 100]);
        expect(detail, `${state}: ${detail}`).toContain("idx_lookalike_brand");
        expect(detail, `${state}: ${detail}`).not.toMatch(/\bSCAN lookalike_domains\b(?! USING)/);
      }
    });

    it("the brand-scoped rescan selector seeks by brand and needs no sort", () => {
      for (const [state, target] of STATES()) {
        const detail = plan(target, SQL.brandDueSelect(), ["b3", 10]);
        expect(detail, `${state}: ${detail}`).toContain("idx_lookalike_brand");
        expect(detail, `${state}: ${detail}`).not.toMatch(/\bSCAN\b/);
        // No `ORDER BY`, deliberately: the rescan handler stamps every
        // row of the brand with the SAME `check_due_at`, so ordering
        // would buy nothing and cost a temp b-tree.
        expect(detail, `${state}: ${detail}`).not.toMatch(/TEMP B-TREE/i);
      }
    });

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

    it("0268 and 0269 both refresh statistics, table-scoped", () => {
      // The sibling convention (0099/0100/0101/0123/0197/0200) and the
      // reason it is safe here, asserted together: measured statistics
      // keep every plan above, so each ANALYZE is sibling behaviour
      // rather than a risk. Table-scoped, not 0123's bare
      // whole-database form, which reads every index in the database.
      for (const [label, sql] of [["0268", migration0268], ["0269", migration0269]] as const) {
        const code = sql.replace(/^\s*--.*$/gm, "");
        expect(code, `${label} must refresh statistics like its siblings`).toMatch(/\bANALYZE\b/i);
        expect(code, label).toMatch(/ANALYZE\s+lookalike_domains\s*;/i);
      }
    });

    it("0269 backfills check_due_at, so no pre-existing row reads as PARKED", () => {
      // The one way this migration could brick the whole lane: the new
      // predicates read `check_due_at IS NULL` as parked, and every row
      // that existed before the ADD COLUMN has exactly that. Asserted
      // against the migration TEXT because the statement is a data
      // UPDATE, which `lookalikeSchema()` deliberately does not apply.
      const code = migration0269.replace(/^\s*--.*$/gm, "");
      expect(code).toMatch(/UPDATE\s+lookalike_domains[\s\S]*SET\s+check_due_at\s*=/i);
      expect(code, "the backfill must be idempotent").toMatch(/WHERE\s+check_due_at\s+IS\s+NULL/i);

      // ...and it does the right thing on both row shapes. Run against
      // real SQLite rather than pattern-matched, on a table seeded as it
      // would be the moment before the migration runs.
      const d = new DatabaseSync!(":memory:");
      applyLookalikeSchema(d);
      d.prepare(
        `INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type, last_checked, check_due_at)
         VALUES ('never', 'b1', 'a.example', 'replacement', NULL, NULL),
                ('stale', 'b1', 'b.example', 'replacement', '2026-01-01 00:00:00', NULL),
                ('kept',  'b1', 'c.example', 'replacement', NULL, '2099-01-01 00:00:00')`,
      ).run();
      const backfill = code.match(/UPDATE\s+lookalike_domains[\s\S]*?;/i);
      expect(backfill, "could not extract the backfill UPDATE").toBeTruthy();
      d.exec(backfill![0]!);
      const rows = d.prepare(
        `SELECT id, check_due_at,
                (check_due_at IS NOT NULL AND check_due_at <= datetime('now')) AS due
           FROM lookalike_domains ORDER BY id`,
      ).all() as Array<{ id: string; check_due_at: string | null; due: number }>;
      const by = new Map(rows.map((r) => [r.id, r]));
      // Never observed -> due NOW. Stale -> one cadence past a date in
      // the past, so also due now. Neither may be left parked.
      expect(by.get("never")!.due, "never-observed row must be due").toBe(1);
      expect(by.get("stale")!.due, "stale row must be due").toBe(1);
      // An already-scheduled row is not re-stamped (idempotence).
      expect(by.get("kept")!.check_due_at).toBe("2099-01-01 00:00:00");
    });

    it("0267 disambiguates the pre-existing rows, so none reads as first contact", () => {
      // THE OTHER WAY THIS DEPLOY COULD GO WRONG, and the mirror image
      // of 0269's backfill. 0267 flipped the first-contact discriminator
      // from `last_checked IS NULL` to `baseline_established_at IS
      // NULL`. Under the old rule the ~120 production rows classified
      // correctly WITHOUT the column, because their `last_checked` was
      // already non-NULL. Under the new rule every one of them reads as
      // first contact on the first tick after deploy: re-baselined,
      // `first_seen` suppressed, alerts withheld unless mail+web
      // happened to be present. Silently, and once per row forever.
      //
      // Asserted against the migration TEXT because the statement is a
      // data UPDATE, which `lookalikeSchema()` deliberately does not
      // apply — then EXECUTED, because a pattern match would pass on an
      // UPDATE that set the wrong column.
      const code = migration0267.replace(/^\s*--.*$/gm, "");
      const stmt = code.match(/UPDATE\s+lookalike_domains[\s\S]*?;/i);
      expect(stmt, "0267 must carry the disambiguation UPDATE").toBeTruthy();
      expect(stmt![0], "and it must be idempotent")
        .toMatch(/WHERE\s+baseline_established_at\s+IS\s+NULL/i);

      const d = new DatabaseSync!(":memory:");
      applyLookalikeSchema(d);
      d.prepare(
        `INSERT INTO lookalike_domains
           (id, brand_id, domain, permutation_type, registered, last_checked,
            baseline_established_at, check_due_at)
         VALUES ('legacy', 'b1', 'a.example', 'replacement', 1, '2026-05-01 00:00:00', NULL, '2026-01-01 00:00:00'),
                ('fresh',  'b1', 'b.example', 'replacement', 0, NULL, NULL, '2026-01-01 00:00:00'),
                ('done',   'b1', 'c.example', 'replacement', 1, '2026-05-01 00:00:00', '2026-04-01 00:00:00', '2026-01-01 00:00:00')`,
      ).run();
      d.exec(stmt![0]!);

      const rows = d.prepare(
        `SELECT id, baseline_established_at FROM lookalike_domains ORDER BY id`,
      ).all() as Array<{ id: string; baseline_established_at: string | null }>;
      const by = new Map(rows.map((r) => [r.id, r.baseline_established_at]));
      // An observed row IS baselined, and its `last_checked` is the best
      // evidence we have of when.
      expect(by.get("legacy")).toBe("2026-05-01 00:00:00");
      // A genuinely never-observed row stays first contact.
      expect(by.get("fresh")).toBeNull();
      // An already-disambiguated row is not re-stamped (idempotence).
      expect(by.get("done")).toBe("2026-04-01 00:00:00");

      // ...and the cohort SELECTs agree, which is the property the
      // column values are only evidence for.
      const first = (d.prepare(SQL.firstContactSelect()).all(50) as Array<{ id: string }>).map((r) => r.id);
      const recheck = (d.prepare(SQL.recheckSelect()).all(50, 0) as Array<{ id: string }>).map((r) => r.id);
      expect(first).toEqual(["fresh"]);
      expect(recheck.sort()).toEqual(["done", "legacy"]);
    });

    it("the new cohort plans are NOT cardinality-sensitive the way 0268's were", () => {
      // 0268 documents a measured degenerate regime: `sqlite_stat1`
      // records only average rows-per-value, so it could not express
      // that the NULL bucket of `last_checked` held most of the table,
      // and at TWO or fewer distinct non-NULL values across 56,010 rows
      // the planner priced the old `last_checked IS NULL` seek above an
      // unindexed read with `LIMIT 50` and emitted `SCAN ld`.
      //
      // 0269's cohort indexes are PARTIAL on `check_due_at IS NOT NULL`,
      // so every indexed row carries a real value and there is no NULL
      // bucket to mis-price. This pins that claim at the SAME degenerate
      // cardinality that broke the old plan — one distinct stamp across
      // the whole table — rather than asserting it in prose.
      const degenerate = (distinctStamps: number): { first: string; recheck: string } => {
        const d = new DatabaseSync!(":memory:");
        applyLookalikeSchema(d);
        const ins = d.prepare(
          `INSERT INTO lookalike_domains
             (id, brand_id, domain, permutation_type, baseline_established_at, check_due_at)
           VALUES (?, 'b1', ?, 'replacement', ?, ?)`,
        );
        d.exec("BEGIN");
        for (let i = 0; i < ROWS; i += 1) {
          ins.run(
            `l${i}`,
            `d${i}.example`,
            // 30% baselined, exactly as the real fixture.
            i % 10 < 3 ? "2026-06-01 00:00:00" : null,
            `2026-08-01 00:00:${String(i % distinctStamps).padStart(2, "0")}`,
          );
        }
        d.exec("COMMIT");
        d.exec("ANALYZE");
        return {
          first: plan(d, SQL.firstContactSelect(), [50]),
          recheck: plan(d, SQL.recheckSelect(), [50, 0]),
        };
      };
      for (const n of [1, 2, 3]) {
        const { first, recheck } = degenerate(n);
        expect(first, `${n} distinct stamps / first: ${first}`).not.toMatch(/\bSCAN\b/);
        expect(recheck, `${n} distinct stamps / recheck: ${recheck}`).not.toMatch(/\bSCAN\b/);
      }
    });
  });
});
