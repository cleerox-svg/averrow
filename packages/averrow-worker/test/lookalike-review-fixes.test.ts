/**
 * The four review findings that had no coverage, driven end-to-end
 * against REAL SQLITE.
 *
 *   B1 — the first-contact / re-check budget split actually holds when
 *        one cohort is oversupplied (the `NULLS FIRST` starvation).
 *   B2 — `handleScanLookalikes` makes rows due WITHOUT forging first
 *        contact, so a rescan can't reclassify a real registration as a
 *        baseline or re-stamp `baseline_established_at`.
 *   B3 — a `has_web = 0` mail-only baseline IS BIMI-checked and IS
 *        alertable (no other producer can see that shape).
 *   F6 — a registered -> DNS-failure -> registered flap does not mint a
 *        `first_seen`, a Haiku call, or an alert.
 *
 * ── Why real SQLite and not a statement mock ────────────────────────
 *
 * B1 is a question about LIMIT interaction between two queries. A mock
 * that returns a fixture for any `.all()` cannot answer it — it would
 * have to re-implement `WHERE ... IS NULL` and `LIMIT`, which is the
 * class of test the F7 finding was about. So `env.DB` here is a thin D1
 * shim over `node:sqlite` and the scanner's own SQL does the selecting.
 * Only the NETWORK and TOKEN-SPENDING collaborators are mocked; their
 * call counts are themselves assertion targets.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";
import { applyLookalikeSchema } from "./lookalike-schema";

// ─── Collaborator mocks ───────────────────────────────────────────

const { checkDomainSpy, analyzeWithHaikuSpy, checkBIMISpy, createAlertSpy, pageAnalysisSpy } =
  vi.hoisted(() => ({
    checkDomainSpy: vi.fn(),
    analyzeWithHaikuSpy: vi.fn(),
    checkBIMISpy: vi.fn(),
    createAlertSpy: vi.fn(),
    pageAnalysisSpy: vi.fn(),
  }));

vi.mock("../src/lib/domain-checker", () => ({ checkDomain: checkDomainSpy }));
vi.mock("../src/lib/haiku", () => ({ analyzeWithHaiku: analyzeWithHaikuSpy }));
vi.mock("../src/email-security", () => ({ checkBIMIExists: checkBIMISpy }));
vi.mock("../src/lib/alerts", () => ({ createAlert: createAlertSpy }));
vi.mock("../src/scanners/lookalike-page-analysis", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/scanners/lookalike-page-analysis")>();
  return { ...actual, runPageAnalysisForDomain: pageAnalysisSpy };
});

const {
  checkLookalikeBatch, checkLookalikeBatchForBrand, generateAndStoreLookalikes,
  lookalikeCheckDefects,
} = await import("../src/scanners/lookalike-domains");
const { handleScanLookalikes } = await import("../src/handlers/lookalikeDomains");
const { LOOKALIKE_UNPARK_PER_RUN } = await import("../src/lib/lookalike-budget");
type LookalikeCheckSummary =
  Awaited<ReturnType<typeof checkLookalikeBatch>>;

// ─── A minimal D1 shim over node:sqlite ───────────────────────────

type Stmt = {
  all(...p: unknown[]): unknown[];
  get(...p: unknown[]): unknown;
  run(...p: unknown[]): { changes: number };
};
type SqliteCtor = new (path: string) => { exec(sql: string): void; prepare(sql: string): Stmt };

const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: SqliteCtor | null = null;
try {
  DatabaseSync = (nodeRequire("node:sqlite") as { DatabaseSync: SqliteCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}
const hasSqlite = (): boolean => DatabaseSync !== null;

/**
 * `lookalike_domains` is built from the MIGRATION FILES
 * (`applyLookalikeSchema`), not declared here. A hand-written copy of a
 * 33-column table cannot fail on a column the code invents — it can only
 * be edited to match one — which is exactly how three phantom columns
 * survived a whole review round in a sibling test file.
 */
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
    target_type TEXT,
    target_value TEXT,
    verification_status TEXT,
    last_verified_at TEXT,
    updated_at TEXT
  );
`;

interface Harness {
  env: Env;
  /** Insert a candidate row; returns its id. */
  seed(over?: Record<string, unknown>): string;
  row(id: string): Record<string, unknown>;
  /** Domains handed to `checkDomain` this run, in call order. */
  checked(): string[];
  /**
   * Make every `.run()` whose SQL contains `fragment` throw.
   *
   * Needed because the one defect this round's blocker is about — the
   * split read-modify-write on `check_attempts` — is only reachable from
   * a throw that happens AFTER `persistCheckFacts` has reset the column.
   * Mocking a collaborator cannot produce that: `checkDomain` throws
   * BEFORE the reset, and every other collaborator past it
   * (`checkBIMIExists`, `analyzeWithHaiku`, `runPageAnalysisForDomain`,
   * `createAlert` on the BIMI path) is caught by a narrower try/catch.
   * The BEC lane's guarded CLAIM is the statement that is deliberately
   * un-caught, and it runs on every due pass of a registered + MX row.
   */
  failOn(fragment: string): void;
}

function harness(): Harness {
  const db = new DatabaseSync!(":memory:");
  db.exec(DDL);
  applyLookalikeSchema(db);
  db.prepare(
    `INSERT INTO brands (id, name, canonical_domain, tier)
     VALUES ('b1', 'Acme', 'acme.example', 'monitored')`,
  ).run();

  type Bound = { sql: string; params: unknown[] };

  const failing: string[] = [];

  const DB = {
    prepare(sql: string) {
      const wrap = (params: unknown[]) => {
        const self = {
          sql,
          params,
          async all<T>() {
            return { results: db.prepare(sql).all(...params) as T[], meta: {} };
          },
          async first<T>() {
            return (db.prepare(sql).get(...params) ?? null) as T | null;
          },
          async run() {
            const hit = failing.find((f) => sql.includes(f));
            if (hit) throw new Error(`injected D1 failure on: ${hit}`);
            return { meta: { changes: db.prepare(sql).run(...params).changes } };
          },
        };
        return self;
      };
      return {
        ...wrap([]),
        bind: (...p: unknown[]) => wrap(p),
      };
    },
    // `generateAndStoreLookalikes` inserts through `DB.batch`. Executed
    // sequentially here — D1's batch is a transaction, which `node:sqlite`
    // gives us by default for a statement run, and nothing under test
    // depends on the atomicity.
    async batch(stmts: Bound[]) {
      return stmts.map((st) => ({
        meta: { changes: db.prepare(st.sql).run(...st.params).changes },
      }));
    },
  };

  let seq = 0;
  return {
    env: { DB } as unknown as Env,
    seed(over: Record<string, unknown> = {}) {
      seq += 1;
      const row: Record<string, unknown> = {
        id: `l_${String(seq).padStart(4, "0")}`,
        brand_id: "b1",
        domain: `acm3-${seq}.example`,
        permutation_type: "replacement",
        registered: 0,
        has_mx: 0,
        has_web: 0,
        resolves_to: null,
        first_seen: null,
        last_checked: null,
        baseline_established_at: null,
        last_check_failed_at: null,
        threat_level: null,
        alert_id: null,
        ai_assessment: null,
        // Migration 0269. DUE by default, so a row seeded here behaves
        // like one the seeder inserted (`check_due_at = datetime('now')`).
        // A test that wants a deferred or PARKED row says so.
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
      ).run(...cols.map((c) => row[c] as null));
      return row.id as string;
    },
    row(id: string) {
      return db.prepare(`SELECT * FROM lookalike_domains WHERE id = ?`).get(id) as Record<string, unknown>;
    },
    checked() {
      return checkDomainSpy.mock.calls.map((c) => c[0] as string);
    },
    failOn(fragment: string) {
      failing.push(fragment);
    },
  };
}

/**
 * A resolved DNS answer. `resolved: true` means "this IS an
 * observation", and the three per-probe flags default to true — i.e.
 * every probe answered, which is what "an answer" means.
 *
 * They are explicit rather than assumed because they are what the
 * per-check UPDATE now gates each field's write on: a test that omitted
 * them would silently assert the DON'T-OVERWRITE path while claiming to
 * test the normal one.
 */
function answer(
  over: Partial<{
    registered: boolean; ip: string; hasMx: boolean; hasWeb: boolean;
    aAnswered: boolean; mxAnswered: boolean; webAnswered: boolean;
  }> = {},
) {
  return {
    registered: false, resolved: true, hasMx: false, hasWeb: false,
    aAnswered: true, mxAnswered: true, webAnswered: true,
    ...over,
  };
}

/** A FAILED check — a timeout or non-ok DoH response. Not an observation. */
const NO_ANSWER = {
  registered: false, resolved: false, hasMx: false, hasWeb: false,
  aAnswered: false, mxAnswered: false, webAnswered: false,
};

function haikuSays(level: string) {
  return {
    success: true,
    data: { response: "", structured: { threat_level: level, assessment: `assessed ${level}` } },
  };
}

const STALE = "2026-09-01 00:00:00";

/**
 * The RE-CHECK cohort marker.
 *
 * The cohort discriminator is `baseline_established_at` (migration 0267,
 * amended) and NOT `last_checked`, which now carries exactly one job:
 * "when did we last successfully observe this row". These tests used to
 * seed `last_checked: STALE` to mean BOTH "already observed" and "due",
 * which is precisely the conflation the change removed — so the two
 * facts are now stated separately. `check_due_at` defaults to due in the
 * harness, so this says only the first.
 */
const BASELINED = { baseline_established_at: STALE, last_checked: STALE } as const;

/**
 * An all-zero summary, taken FROM THE SOURCE rather than retyped.
 *
 * A run over an empty table returns `emptySummary()` verbatim, so this
 * cannot drift out of step with the interface the way a hand-written
 * object literal would — and a new counter added without a default would
 * show up here rather than being silently absent.
 */
async function emptyLikeSummary(): Promise<LookalikeCheckSummary> {
  return checkLookalikeBatch(harness().env);
}

/**
 * Make the row due again AND drop `has_web`, so the next pass observes a
 * `web_gained` transition.
 *
 * ── Why a bare `makeDue` is not enough to re-reach the compositor ────
 *
 * `compositeAndPersist` runs only on `first_contact`,
 * `registration_gained` or an mx/web GAIN. A row that has already
 * baselined with mail+web present yields the `none` transition on every
 * later pass, so a deferred Haiku call (capped, thrown, or empty) is NOT
 * in fact retried "on its next due pass" — it is retried on its next
 * TRANSITION, which for a stable row may be never.
 *
 * That is a real limitation of the compositor's dispatch and not of the
 * claim (the claim is released either way, which is what keeps the row
 * CLAIMABLE); it is recorded in `HAIKU_CALLS_PER_RUN`'s docstring rather
 * than papered over here, and these tests drive the transition
 * explicitly rather than asserting a cadence the code does not have.
 */
async function webFlap(h: Harness, id: string): Promise<void> {
  await h.env.DB.prepare(
    `UPDATE lookalike_domains
     SET has_web = 0, check_due_at = datetime('now', '-1 hour')
     WHERE id = ?`,
  ).bind(id).run();
}

/** Re-admit a row the backoff ladder deferred, so the next tick sees it. */
async function makeDue(h: Harness, id: string): Promise<void> {
  await h.env.DB.prepare(
    `UPDATE lookalike_domains SET check_due_at = datetime('now', '-1 hour') WHERE id = ?`,
  ).bind(id).run();
}

beforeEach(() => {
  vi.clearAllMocks();
  checkBIMISpy.mockResolvedValue(false);
  createAlertSpy.mockResolvedValue("alert_1");
  analyzeWithHaikuSpy.mockResolvedValue(haikuSays("MEDIUM"));
  pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
});

// ═══════════════════════════════════════════════════════════════════
// B1 — the budget split
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("checkLookalikeBatch — first-contact / re-check budget split", () => {
  /** Which cohort each checked domain came from, by its seeded id. */
  function cohorts(h: Harness, firstIds: string[], recheckIds: string[]) {
    const byDomain = new Map<string, string>();
    for (const id of [...firstIds, ...recheckIds]) byDomain.set(h.row(id).domain as string, id);
    const seen = h.checked().map((d) => byDomain.get(d)!);
    return {
      firstContact: seen.filter((id) => firstIds.includes(id)).length,
      recheck: seen.filter((id) => recheckIds.includes(id)).length,
      total: seen.length,
    };
  }

  it("does NOT let an oversupplied first-contact cohort starve the re-check cohort", async () => {
    // THE BLOCKER. 120 never-checked rows against 40 known ones is the
    // seeder-drain shape in miniature (~300 inserted per tick against a
    // 50/tick drain). Under `ORDER BY last_checked ASC NULLS FIRST` all
    // 50 slots went to the NULLs and not one known row was sampled —
    // for the whole ~187-tick drain, platform-wide.
    const h = harness();
    checkDomainSpy.mockResolvedValue(answer());
    const firstIds = Array.from({ length: 120 }, () => h.seed());
    const recheckIds = Array.from({ length: 40 }, () => h.seed(BASELINED));

    await checkLookalikeBatch(h.env);

    const c = cohorts(h, firstIds, recheckIds);
    // Unchanged total — the split lives INSIDE the existing budget.
    expect(c.total).toBe(50);
    expect(c.recheck).toBe(20);
    expect(c.firstContact).toBe(30);
  });

  it("gives the re-check cohort's unused slots to first contact", async () => {
    // Today's real shape: 120 known rows total, so only a handful are
    // ever due in one tick. The re-check floor must not become a
    // 20-slot hole in the drain's throughput.
    const h = harness();
    checkDomainSpy.mockResolvedValue(answer());
    const firstIds = Array.from({ length: 120 }, () => h.seed());
    const recheckIds = Array.from({ length: 5 }, () => h.seed(BASELINED));

    await checkLookalikeBatch(h.env);

    const c = cohorts(h, firstIds, recheckIds);
    expect(c.total).toBe(50);
    // Every due known row is checked...
    expect(c.recheck).toBe(5);
    // ...and first contact absorbs the rest rather than leaving it idle.
    expect(c.firstContact).toBe(45);
  });

  it("gives first contact's unused slots BACK to re-check (the post-drain state)", async () => {
    // Once the drain finishes the first-contact cohort is permanently
    // empty. A one-directional split would have capped re-check at 20
    // per tick forever — a 117-day cycle over the eventual ~56,010-row
    // known population. The spill is what prevents that.
    const h = harness();
    checkDomainSpy.mockResolvedValue(answer());
    const recheckIds = Array.from({ length: 80 }, () => h.seed(BASELINED));

    await checkLookalikeBatch(h.env);

    const c = cohorts(h, [], recheckIds);
    expect(c.total).toBe(50);
    expect(c.recheck).toBe(50);
  });

  it("never exceeds the per-run total even when BOTH cohorts are oversupplied", async () => {
    const h = harness();
    checkDomainSpy.mockResolvedValue(answer());
    const firstIds = Array.from({ length: 200 }, () => h.seed());
    const recheckIds = Array.from({ length: 200 }, () => h.seed(BASELINED));

    await checkLookalikeBatch(h.env);

    const c = cohorts(h, firstIds, recheckIds);
    expect(c.total).toBe(50);
    expect(c.recheck).toBe(20);
    expect(c.firstContact).toBe(30);
    // And no row is checked twice — the spill's OFFSET tiles the cohort
    // and the merge dedupes by id.
    expect(new Set(h.checked()).size).toBe(50);
  });

  it("takes the stalest known rows first", async () => {
    const h = harness();
    checkDomainSpy.mockResolvedValue(answer());
    // 30 known rows, dated so the ordering is unambiguous.
    const recheckIds = Array.from({ length: 30 }, (_, i) =>
      h.seed({ ...BASELINED, check_due_at: `2026-08-${String(i + 1).padStart(2, "0")} 00:00:00` }),
    );
    Array.from({ length: 60 }, () => h.seed());

    await checkLookalikeBatch(h.env);

    const checkedDomains = new Set(h.checked());
    const staleTwenty = recheckIds.slice(0, 20).map((id) => h.row(id).domain as string);
    for (const d of staleTwenty) expect(checkedDomains, d).toContain(d);
  });
});

// ═══════════════════════════════════════════════════════════════════
// B2 — "Scan now" is a PRIORITY ENQUEUE, brand-scoped and bounded
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("handleScanLookalikes — the rescan path", () => {
  const ctx = { userId: "u1", orgId: null, role: "super_admin" } as unknown as AuthContext;
  const req = () => new Request("https://averrow.test/api/lookalikes/b1/scan", { method: "POST" });

  it("a genuine registration on a RESCANNED brand is still a registration, not a baseline", async () => {
    // The endpoint's two earlier forms both wrote `last_checked`: first
    // NULL (which CLAIMED we had never looked, so the 0 -> 1 that
    // followed was reclassified as BASELINE — no `first_seen`, no Haiku,
    // no alert unless MX and web happened to coincide, and 0267's column
    // re-stamped), then a `CASE` working around that. Scheduling has its
    // own column now, so there is nothing left to work around.
    const h = harness();
    const id = h.seed({
      registered: 0,
      last_checked: "2026-09-29 12:00:00",
      baseline_established_at: "2026-06-01 00:00:00",
    });
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }),
    );
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("HIGH"));

    const res = await handleScanLookalikes(req(), h.env, "b1", ctx);
    expect(res.status).toBe(200);

    const row = h.row(id);
    // The transition path ran: a real appearance, a real assessment.
    expect(row.first_seen).not.toBeNull();
    expect(analyzeWithHaikuSpy).toHaveBeenCalledTimes(1);
    expect(row.threat_level).toBe("HIGH");
    // And 0267's column is untouched — single-write, structurally.
    expect(row.baseline_established_at).toBe("2026-06-01 00:00:00");
  });

  it("does NOT touch last_checked — first contact is unforgeable from here", async () => {
    // The structural half of the fix. The handler's UPDATE no longer
    // mentions the discriminator at all, so no sequence of rescans can
    // reclassify a row. Both shapes are checked: an already-observed row
    // keeps its record until the CHECK advances it, and a never-observed
    // one stays never-observed.
    const h = harness();
    const observed = h.seed({
      last_checked: "2026-09-29 12:00:00",
      baseline_established_at: "2026-06-01 00:00:00",
    });
    const never = h.seed();
    // No check runs: an empty due set is impossible here (the enqueue
    // makes everything due), so suppress the probe instead.
    checkDomainSpy.mockResolvedValue(NO_ANSWER);

    await handleScanLookalikes(req(), h.env, "b1", ctx);

    expect(h.row(observed).last_checked).toBe("2026-09-29 12:00:00");
    expect(h.row(observed).baseline_established_at).toBe("2026-06-01 00:00:00");
    expect(h.row(never).last_checked).toBeNull();
    expect(h.row(never).baseline_established_at).toBeNull();
  });

  it("a BARE registration spends no Haiku — the mail+web gate applies to transitions too", async () => {
    // A DELIBERATE NARROWING in this change, pinned so it is not
    // mistaken for a regression. Haiku used to run on EVERY observed
    // 0 -> 1 regardless of infrastructure. It is now gated on mail+web
    // (and on `ai_assessment IS NULL`) on every path, including this
    // one. What is given up is a Haiku-only HIGH on a registration with
    // neither mail nor web; what covers that case instead is the
    // deterministic page pass, which sees any row with a web server one
    // pass later and can raise the alert itself.
    const h = harness();
    const id = h.seed({ ...BASELINED, registered: 0 });
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8" }));

    await checkLookalikeBatch(h.env);

    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    // The transition itself is still RECORDED — withholding the token
    // spend is not withholding the finding.
    expect(h.row(id).first_seen).not.toBeNull();
  });

  it("leaves a never-checked row at first contact", async () => {
    const h = harness();
    const id = h.seed();
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasWeb: true }));

    await handleScanLookalikes(req(), h.env, "b1", ctx);

    const row = h.row(id);
    // Baseline establishment: web only is not a signal, so no tokens
    // and no alert, and `first_seen` stays NULL.
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(row.first_seen).toBeNull();
    expect(row.baseline_established_at).not.toBeNull();
    expect(row.registered).toBe(1);
  });

  it("enqueues the brand's rows at the front and reports both counts", async () => {
    const h = harness();
    h.seed({
      last_checked: "2026-09-29 12:00:00",
      baseline_established_at: "2026-09-29 12:00:00",
      last_check_failed_at: "2026-09-30 11:00:00",
    });
    h.seed({ last_check_failed_at: "2026-09-30 11:00:00" });
    checkDomainSpy.mockResolvedValue(answer());

    const res = await handleScanLookalikes(req(), h.env, "b1", ctx);
    const body = await res.json() as {
      data: { domains_queued: number; domains_checked_inline: number };
    };
    expect(body.data.domains_queued).toBe(2);
    // Both were checked in the same call — an operator asking for a scan
    // should not wait out a DNS-failure backoff.
    expect(body.data.domains_checked_inline).toBe(2);
    expect(h.checked().length).toBe(2);
  });

  it("the inline run is BRAND-SCOPED — it no longer checks other brands' rows", async () => {
    // THE AMPLIFIER THIS REMOVES. The handler used to `await
    // checkLookalikeBatch(env)`, the GLOBAL batch: up to 100 DoH
    // queries, 50 HEAD probes, 50 Haiku calls and 10 page fetches per
    // button press, against rows belonging to brands the caller never
    // asked about, with no rate limit of any kind in front of it.
    const h = harness();
    await h.env.DB.prepare(
      `INSERT INTO brands (id, name, canonical_domain, tier)
       VALUES ('b2', 'Other', 'other.example', 'monitored')`,
    ).run();
    const mine = h.seed();
    const theirs = h.seed({ brand_id: "b2" });
    checkDomainSpy.mockResolvedValue(answer());

    await handleScanLookalikes(req(), h.env, "b1", ctx);

    expect(h.checked()).toEqual([h.row(mine).domain]);
    expect(h.checked()).not.toContain(h.row(theirs).domain);
    // The other brand's row is untouched — not even its schedule.
    expect(h.row(theirs).check_due_at).toBe("2026-01-01 00:00:00");
  });

  it("the inline run is BOUNDED — a 40-row brand does not spend 40 checks in the request", async () => {
    // `SCAN_NOW_CHECK_LIMITS.rows` is 10. The remainder is not dropped:
    // every row of the brand now carries `check_due_at =
    // '1970-01-01 00:00:00'`, which beats every other row in its cohort
    // unconditionally, so the cron drains them from the front.
    const h = harness();
    const ids = Array.from({ length: 40 }, () => h.seed());
    checkDomainSpy.mockResolvedValue(answer());

    const res = await handleScanLookalikes(req(), h.env, "b1", ctx);
    const body = await res.json() as {
      data: { domains_queued: number; domains_checked_inline: number };
    };

    expect(body.data.domains_queued).toBe(40);
    expect(body.data.domains_checked_inline).toBe(10);
    expect(h.checked()).toHaveLength(10);
    // The un-checked remainder is still enqueued ahead of everything.
    const stillQueued = ids.filter((id) => h.row(id).check_due_at === "1970-01-01 00:00:00");
    expect(stillQueued).toHaveLength(30);
  });

  it("REVIVES a parked row", async () => {
    // A parked row is unreachable by the cohort selects, so without the
    // `check_attempts = 0` + epoch write it would stay unreachable
    // forever. An operator asking for a scan is exactly the signal that
    // the ladder's give-up verdict should be retried.
    const h = harness();
    const id = h.seed({ check_due_at: null, check_attempts: 9 });
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8" }));

    await handleScanLookalikes(req(), h.env, "b1", ctx);

    expect(h.checked()).toEqual([h.row(id).domain]);
    expect(h.row(id).check_attempts).toBe(0);
    expect(h.row(id).check_due_at).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// B3 — the email lane is not gated on the web condition
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("checkLookalikeBatch — mail-only first contact", () => {
  it("BIMI-checks a has_web = 0 baseline and files the fixed-HIGH alert", async () => {
    // The shape that was permanently unalertable: registered, MX set,
    // NO web. The checker's early return skipped BIMI entirely, and
    // `analyzeLookalikePages` requires `has_web = 1`, so NO producer
    // could ever see it — while this scanner's own comments call BIMI
    // the single most damning email signal it can find. It is also the
    // BEC-precursor shape: a domain set up to RECEIVE mail and serve
    // nothing.
    const h = harness();
    const id = h.seed();
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true }));
    checkBIMISpy.mockResolvedValue(true);

    await checkLookalikeBatch(h.env);

    expect(checkBIMISpy).toHaveBeenCalledWith(h.row(id).domain);
    const calls = createAlertSpy.mock.calls.map((c) => c[1] as { alertType: string; severity: string });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.alertType).toBe("typosquat_bimi");
    expect(calls[0]!.severity).toBe("HIGH");

    // Cost discipline is intact: no Haiku, no page fetch. One DNS
    // lookup is the entire price of admitting this lane.
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    expect(pageAnalysisSpy).not.toHaveBeenCalled();

    const row = h.row(id);
    expect(row.has_mx).toBe(1);
    expect(row.has_web).toBe(0);
    // Still a baseline, not an appearance. And the BIMI alert is NOT
    // linked as `alert_id` (it never was), so the page producer can
    // still raise the primary alert if a web server appears later.
    expect(row.baseline_established_at).not.toBeNull();
    expect(row.first_seen).toBeNull();
    expect(row.alert_id).toBeNull();
  });

  it("files nothing when the mail-only baseline has NO BIMI record", async () => {
    const h = harness();
    h.seed();
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true }));
    checkBIMISpy.mockResolvedValue(false);

    await checkLookalikeBatch(h.env);

    expect(checkBIMISpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
  });

  it("does NOT spend a BIMI lookup on a web-only baseline", async () => {
    // BIMI is a MAIL signal; a squat with no MX cannot use one. The
    // gate is `hasMx`, not "any signal-less baseline", so the cohort
    // paying for this lookup stays bounded.
    const h = harness();
    h.seed();
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasWeb: true }));

    await checkLookalikeBatch(h.env);

    expect(checkBIMISpy).not.toHaveBeenCalled();
    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("a BIMI lookup failure is non-blocking — the baseline still lands", async () => {
    const h = harness();
    const id = h.seed();
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true }));
    checkBIMISpy.mockRejectedValue(new Error("DoH 503"));

    await checkLookalikeBatch(h.env);

    expect(createAlertSpy).not.toHaveBeenCalled();
    const row = h.row(id);
    expect(row.registered).toBe(1);
    expect(row.baseline_established_at).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// F6 — a DNS blip must not latch a false first_seen
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("checkLookalikeBatch — registered -> DNS failure -> registered", () => {
  it("an unresolved check leaves registration state alone, and the flap produces nothing", async () => {
    const h = harness();
    const id = h.seed({
      registered: 1,
      resolves_to: "5.6.7.8",
      has_mx: 1,
      has_web: 1,
      last_checked: STALE,
      first_seen: "2026-01-15 00:00:00",
      baseline_established_at: "2026-01-15 00:00:00",
      threat_level: "HIGH",
    });

    // ── Tick 1: the resolver times out.
    checkDomainSpy.mockResolvedValue(NO_ANSWER);
    await checkLookalikeBatch(h.env);

    let row = h.row(id);
    // No manufactured lapse. This is the whole finding: `registered`
    // going 1 -> 0 here is what makes the NEXT success read as a
    // registration event.
    expect(row.registered).toBe(1);
    expect(row.resolves_to).toBe("5.6.7.8");
    expect(row.last_checked).toBe(STALE);
    expect(row.last_check_failed_at).not.toBeNull();
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    expect(createAlertSpy).not.toHaveBeenCalled();

    // ── Tick 2: the resolver recovers. Re-admit the row, because the
    // backoff ladder deferred it (that deferral is what stops a dead
    // resolver from head-of-line blocking the batch every tick).
    expect(row.check_attempts).toBe(1);
    await makeDue(h, id);
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    await checkLookalikeBatch(h.env);

    row = h.row(id);
    // Nothing "appeared" — it never went away.
    expect(row.first_seen).toBe("2026-01-15 00:00:00");
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(row.last_check_failed_at).toBeNull();
    expect(row.last_checked).not.toBe(STALE);
  });

  it("a FAILED first contact stays first contact — it does not become a fake re-check", async () => {
    // The subtle half. If the failure branch wrote `last_checked`, this
    // row would arrive at tick 2 as "checked before" with `registered`
    // still at the seeder's INSERT default of 0 — and a squat registered
    // in 2019 would be stamped with today's `first_seen`, spend a Haiku
    // call and file a permanent alert. That is why the cooldown needed
    // its own column rather than reusing `last_checked`.
    const h = harness();
    const id = h.seed();

    checkDomainSpy.mockResolvedValue(NO_ANSWER);
    await checkLookalikeBatch(h.env);
    let row = h.row(id);
    expect(row.last_checked).toBeNull();
    expect(row.baseline_established_at).toBeNull();

    await makeDue(h, id);
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasWeb: true }));
    await checkLookalikeBatch(h.env);

    row = h.row(id);
    expect(row.registered).toBe(1);
    // Baseline, not appearance — the classification survived the blip.
    expect(row.baseline_established_at).not.toBeNull();
    expect(row.first_seen).toBeNull();
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("a backed-off row is not re-selected, so a dead resolver cannot block the batch", async () => {
    const h = harness();
    const dead = h.seed(BASELINED);
    const live = h.seed(BASELINED);

    checkDomainSpy.mockResolvedValue(NO_ANSWER);
    await checkLookalikeBatch(h.env);
    expect(h.checked().length).toBe(2);

    vi.clearAllMocks();
    checkDomainSpy.mockResolvedValue(answer());
    await checkLookalikeBatch(h.env);
    // Both sit behind the ladder's first step now.
    expect(h.checked()).not.toContain(h.row(dead).domain);
    expect(h.checked()).not.toContain(h.row(live).domain);
    expect(h.checked().length).toBe(0);
  });

  it("the ladder escalates, and PARKS a row that never answers", async () => {
    // The sticky-row fix. The old flat 24 h cooldown re-admitted a row
    // whose resolver always times out EVERY DAY, FOREVER, at the head of
    // a cohort it could never leave. The ladder climbs (1 h / 4 h / 12 h
    // / 24 h / 48 h) and then parks: `check_due_at = NULL` drops the row
    // out of both partial cohort indexes, so a permanently-dead row
    // costs zero reads STRUCTURALLY rather than being deprioritized.
    const h = harness();
    const id = h.seed(BASELINED);
    checkDomainSpy.mockResolvedValue(NO_ANSWER);

    // The ladder's terminal is 8 consecutive failures, so the 9th
    // attempt is the one that parks. Each tick needs the row re-admitted
    // because the previous tick deferred it — which is itself the
    // property under test.
    let summary = await checkLookalikeBatch(h.env);
    for (let i = 2; i <= 9; i += 1) {
      expect(h.row(id).check_attempts, `after attempt ${i - 1}`).toBe(i - 1);
      // Up to the terminal step the row always has a future due time.
      expect(h.row(id).check_due_at, `after attempt ${i - 1}`).not.toBeNull();
      await makeDue(h, id);
      summary = await checkLookalikeBatch(h.env);
    }

    const row = h.row(id);
    expect(row.check_attempts).toBe(9);
    expect(row.check_due_at, "the 9th failure parks the row").toBeNull();
    expect(summary.rows_parked).toBe(1);

    // And a parked row is UNREACHABLE — not merely last in line.
    vi.clearAllMocks();
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8" }));
    const after = await checkLookalikeBatch(h.env);
    expect(after.checked).toBe(0);
    expect(h.checked()).toHaveLength(0);
  });

  it("a successful check UN-PARKS the row and resets the ladder", async () => {
    const h = harness();
    const id = h.seed({ ...BASELINED, check_due_at: null, check_attempts: 9 });
    // Only an operator rescan can reach a parked row, so reach it the
    // way that endpoint does.
    await h.env.DB.prepare(
      `UPDATE lookalike_domains SET check_due_at = '1970-01-01 00:00:00', check_attempts = 0 WHERE id = ?`,
    ).bind(id).run();
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8" }));

    await checkLookalikeBatch(h.env);

    const row = h.row(id);
    expect(row.check_attempts).toBe(0);
    expect(row.check_due_at).not.toBeNull();
    expect(row.check_due_at).not.toBe("1970-01-01 00:00:00");
  });
});

// ═══════════════════════════════════════════════════════════════════
// B3 — an unanswered probe must not erase known evidence
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("checkLookalikeBatch — unanswered probes preserve evidence", () => {
  /** A row already known to be registered, resolving, mail+web. */
  function knownGood(h: Harness): string {
    return h.seed({
      registered: 1,
      resolves_to: "5.6.7.8",
      has_mx: 1,
      has_web: 1,
      last_checked: STALE,
      first_seen: "2026-01-15 00:00:00",
      baseline_established_at: "2026-01-15 00:00:00",
      threat_level: "HIGH",
    });
  }

  it("a web probe that never answered does not flip has_web to 0", async () => {
    // `resolved` is scoped to `registered`, so a SEEN A record makes it
    // true even though the HEAD probes both died at the connection
    // level. The row stays in the page-analysis cohorts — which require
    // `has_web = 1` — and those are the only producer that can still
    // alert on a row whose `registered === 0` one-shot has fired.
    const h = harness();
    const id = knownGood(h);
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: false, webAnswered: false }),
    );

    await checkLookalikeBatch(h.env);

    const row = h.row(id);
    expect(row.has_web).toBe(1);
    // The rest of the observation still landed.
    expect(row.registered).toBe(1);
    expect(row.last_checked).not.toBe(STALE);
  });

  it("an MX probe that never answered does not flip has_mx to 0", async () => {
    const h = harness();
    const id = knownGood(h);
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: false, mxAnswered: false, hasWeb: true }),
    );

    await checkLookalikeBatch(h.env);

    expect(h.row(id).has_mx).toBe(1);
  });

  it("an A probe that never answered does not erase resolves_to", async () => {
    // MX answered, A timed out: `registered` true, `resolved` true, and
    // `result.ip` undefined. `result.ip ?? null` used to write NULL,
    // which drops the row out of both page cohorts (`resolves_to IS NOT
    // NULL`) until the next good A probe.
    const h = harness();
    const id = knownGood(h);
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, hasMx: true, hasWeb: true, aAnswered: false }),
    );

    await checkLookalikeBatch(h.env);

    expect(h.row(id).resolves_to).toBe("5.6.7.8");
  });

  it("an ANSWERED negative still lands — the gate is not a write-once latch", async () => {
    // The direction that would be just as wrong: "we looked and there is
    // no web server now" is a real observation about a squat that has
    // been parked, and must overwrite the stored 1.
    const h = harness();
    const id = knownGood(h);
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: false, hasWeb: false }),
    );

    await checkLookalikeBatch(h.env);

    const row = h.row(id);
    expect(row.has_web).toBe(0);
    expect(row.has_mx).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// F8 — one bad row must not abort the batch
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("checkLookalikeBatch — per-row error isolation", () => {
  it("a throwing row does not stop the rest of the batch, and is cooled down", async () => {
    // Before per-row isolation: the throw rejected that row's promise,
    // `Promise.all(checks)` rejected, and the tick aborted — every
    // remaining row went unprocessed AND unstamped, so the next tick
    // re-selected the same set and hit the same row again. A permanent
    // tick killer at 56,010 rows.
    const h = harness();
    const bad = h.seed({ ...BASELINED, registered: 0 });
    const good = h.seed({ ...BASELINED, registered: 0 });

    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }),
    );
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("HIGH"));
    // The unguarded await that made this reachable in production.
    createAlertSpy.mockImplementation(async (_db: unknown, p: { sourceId?: string }) => {
      if (p.sourceId === bad) throw new Error("alerts table is having a day");
      return "alert_1";
    });

    const summary = await checkLookalikeBatch(h.env);

    // Both rows were attempted...
    expect(h.checked()).toHaveLength(2);
    // ...the good one completed and got its alert linked...
    expect(h.row(good).alert_id).toBe("alert_1");
    expect(h.row(good).threat_level).toBe("HIGH");
    // ...and the bad one is counted rather than swallowed.
    expect(summary.row_errors).toBe(1);
    expect(summary.checked).toBe(2);
    // The failure is VISIBLE and the row is cooled down, so the next
    // tick does not immediately re-select it and throw again.
    expect(h.row(bad).last_check_failed_at).not.toBeNull();
  });

  it("the cooled-down bad row is not re-selected on the next tick", async () => {
    const h = harness();
    const bad = h.seed({ ...BASELINED, registered: 0 });
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("HIGH"));
    createAlertSpy.mockRejectedValue(new Error("boom"));

    await checkLookalikeBatch(h.env);
    expect(h.row(bad).last_check_failed_at).not.toBeNull();

    vi.clearAllMocks();
    checkDomainSpy.mockResolvedValue(answer());
    const second = await checkLookalikeBatch(h.env);
    expect(h.checked()).toHaveLength(0);
    expect(second.checked).toBe(0);
  });

  it("a typosquat_bimi alert that throws costs the row NOTHING — and releases its claim", async () => {
    // This used to be the second unguarded await: `fileBimiAlert` sat at
    // the very END of the row body, AFTER the primary alert had been
    // filed and linked, so a throw there discarded every REMAINING row
    // in the batch while this row's own work was already complete. The
    // tick therefore lost DIFFERENT rows than the one that failed, and
    // none of them were stamped. Per-row isolation downgraded that from
    // "tick killer" to "one counted row error".
    //
    // Making the BEC lane RECURRING improves on it again, and in a way
    // worth pinning rather than inferring. The lane runs BEFORE the
    // compositor (its answer feeds the MEDIUM boost) and owns its own
    // try/catch, so a thrown `createAlert` here is no longer a row
    // error at all: the row goes on to complete its full assessment, and
    // the lane RELEASES its `bimi_first_seen_at` claim so the finding is
    // retried on the next pass instead of being marked recorded with no
    // alert anywhere.
    const h = harness();
    const id = h.seed({ ...BASELINED, registered: 0 });
    const other = h.seed({ ...BASELINED, registered: 0 });
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("HIGH"));
    const badDomain = h.row(id).domain as string;
    // BIMI is present on the bad row only, so only it reaches the lane's
    // alert path.
    checkBIMISpy.mockImplementation(async (domain: string) => domain === badDomain);
    createAlertSpy.mockImplementation(async (_db: unknown, p: { alertType: string; sourceId?: string }) => {
      if (p.alertType === "typosquat_bimi") throw new Error("alerts insert failed");
      return "alert_1";
    });

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.checked).toBe(2);
    // NOT a row error any more — the lane contained it.
    expect(summary.row_errors).toBe(0);
    expect(summary.bimi_alerts).toBe(0);
    // The sibling row completed end to end, which was the original
    // property...
    expect(h.row(other).alert_id).toBe("alert_1");
    expect(h.row(other).threat_level).toBe("HIGH");
    // ...and so did the row whose BIMI alert threw.
    expect(h.row(id).threat_level).toBe("HIGH");
    expect(h.row(id).alert_id).toBe("alert_1");
    // THE CLAIM IS RELEASED. Without this the row would read as "BIMI
    // recorded" with no alert in existence, and the lane's eligibility
    // predicate (`bimi_first_seen_at IS NULL`) would never offer it
    // again — a permanently lost finding, silently.
    expect(h.row(id).bimi_first_seen_at).toBeNull();
    // ...so the very next pass retries it, and succeeds.
    vi.clearAllMocks();
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    checkBIMISpy.mockResolvedValue(true);
    createAlertSpy.mockResolvedValue("alert_2");
    await makeDue(h, id);
    const retry = await checkLookalikeBatch(h.env);
    expect(retry.bimi_alerts).toBe(1);
    expect(h.row(id).bimi_first_seen_at).not.toBeNull();
  });

  // ═════════════════════════════════════════════════════════════════
  // The recurring BEC lane
  // ═════════════════════════════════════════════════════════════════

  it("re-checks BIMI on a row baselined months ago — the lane is RECURRING", async () => {
    // THE BLIND SPOT THIS CLOSES. The BIMI check used to be reachable
    // exactly once, on first contact, so a squat that published a BIMI
    // record a month after we baselined it was invisible FOREVER — and
    // `analyzeLookalikePages` cannot see the shape either, because it
    // requires `has_web = 1`. Nothing else in the platform looks at
    // mail-only squats.
    const h = harness();
    const id = h.seed({
      ...BASELINED,
      registered: 1,
      resolves_to: "5.6.7.8",
      has_mx: 1,
      has_web: 0,
      first_seen: null,
      threat_level: "LOW",
      ai_assessment: "assessed LOW",
    });
    // No transition at all this pass: the stored state and the observed
    // state agree. The lane must still run.
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true }));
    checkBIMISpy.mockResolvedValue(true);

    const summary = await checkLookalikeBatch(h.env);

    expect(checkBIMISpy).toHaveBeenCalledWith(h.row(id).domain);
    expect(summary.bimi_alerts).toBe(1);
    const types = createAlertSpy.mock.calls.map((c) => (c[1] as { alertType: string }).alertType);
    expect(types).toEqual(["typosquat_bimi"]);
    expect(h.row(id).bimi_first_seen_at).not.toBeNull();
    // The BIMI id is NOT linked as `alert_id`:
    // `raiseUnalertedPhishingPageAlert` keys on `alert_id IS NULL`, so
    // one parked there would permanently suppress that row's
    // phishing-page alert.
    expect(h.row(id).alert_id).toBeNull();
  });

  it("files the BIMI alert ONCE per row, ever", async () => {
    const h = harness();
    const id = h.seed({ ...BASELINED, registered: 1, resolves_to: "5.6.7.8", has_mx: 1 });
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true }));
    checkBIMISpy.mockResolvedValue(true);

    const first = await checkLookalikeBatch(h.env);
    expect(first.bimi_alerts).toBe(1);

    vi.clearAllMocks();
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true }));
    checkBIMISpy.mockResolvedValue(true);
    await makeDue(h, id);
    const second = await checkLookalikeBatch(h.env);

    // Claimed, so no second alert AND no second lookup: the claim is
    // also what keeps the lane's DNS cost bounded over time.
    expect(second.bimi_alerts).toBe(0);
    expect(second.bimi_lookups).toBe(0);
    expect(checkBIMISpy).not.toHaveBeenCalled();
    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("NEVER records BIMI absence, so a lookup failure is retried", async () => {
    // `checkBIMIExists` catches its own errors and returns `false`, so
    // absence and lookup-failure are the SAME value at the call site.
    // Recording either would mark the row "we checked, there is none"
    // from a transient resolver blip and retire it from the lane
    // permanently — which is migration 0268's defect in a new column.
    const h = harness();
    const id = h.seed({ ...BASELINED, registered: 1, resolves_to: "5.6.7.8", has_mx: 1 });
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true }));
    checkBIMISpy.mockResolvedValue(false);

    await checkLookalikeBatch(h.env);
    expect(h.row(id).bimi_first_seen_at).toBeNull();

    vi.clearAllMocks();
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true }));
    checkBIMISpy.mockResolvedValue(true);
    await makeDue(h, id);
    const retry = await checkLookalikeBatch(h.env);
    expect(retry.bimi_alerts).toBe(1);
  });

  it("the per-run cap is checked BEFORE the claim, so a capped row still alerts later", async () => {
    // The ordering bug this avoids: a row that claimed and THEN hit the
    // cap would be marked recorded with no alert filed, and the lane
    // would never offer it again. `SCAN_NOW_CHECK_LIMITS.bimiLookups` is
    // 5, which is the smallest cap in the codebase and therefore the
    // cheapest way to drive it.
    const h = harness();
    const ids = Array.from({ length: 8 }, () =>
      h.seed({ ...BASELINED, registered: 1, resolves_to: "5.6.7.8", has_mx: 1 }),
    );
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8", hasMx: true }));
    checkBIMISpy.mockResolvedValue(true);

    const summary = await checkLookalikeBatchForBrand(h.env, "b1");

    expect(summary.bimi_lookups).toBe(5);
    expect(summary.bimi_alerts).toBe(5);
    expect(summary.bimi_cap_hit).toBe(true);
    // The three capped rows are UNCLAIMED, so they are still eligible.
    const unclaimed = ids.filter((id) => h.row(id).bimi_first_seen_at === null);
    expect(unclaimed).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Re-entrancy — the two bugs the one-shot compositor hid
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("checkLookalikeBatch — re-entrant compositor, real SQLite", () => {
  /** A registered, resolving, web-only row already at CRITICAL. */
  function critical(h: Harness, over: Record<string, unknown> = {}): string {
    return h.seed({
      ...BASELINED,
      registered: 1,
      resolves_to: "5.6.7.8",
      has_mx: 0,
      has_web: 1,
      // A page escalation put it here. `agents/sparrow.ts` reads this
      // column for takedown eligibility and priority.
      threat_level: "CRITICAL",
      ai_assessment: "credential harvest kit",
      ...over,
    });
  }

  it("a re-composite with an EXHAUSTED page budget does not write the row DOWN", async () => {
    // THE PRODUCTION SCENARIO. `threat_level` used to be seeded fresh at
    // `'MEDIUM'` each pass and written back unconditionally, so a row at
    // CRITICAL from a page escalation was written DOWN to HIGH on any
    // pass where the inline page budget was exhausted — silently
    // de-queuing a confirmed credential-harvest kit from Sparrow.
    //
    // Driven through `checkLookalikeBatchForBrand`, whose
    // `inlinePageFetches` budget is 2: the first two rows consume it and
    // the third re-composites with NO page verdict at all, which is
    // exactly the state that used to downgrade.
    const h = harness();
    const ids = [critical(h), critical(h), critical(h)];
    // Every row gains MX, so every row re-opens the compositor.
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }),
    );
    // A page pass that scores nothing, so no escalation can mask the bug.
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });

    await checkLookalikeBatchForBrand(h.env, "b1");

    // At most 2 page fetches were attempted — so at least one row went
    // through the compositor with no page verdict.
    expect(pageAnalysisSpy.mock.calls.length).toBeLessThanOrEqual(2);
    for (const id of ids) {
      expect(h.row(id).threat_level, id).toBe("CRITICAL");
    }
  });

  it("a Haiku verdict BELOW the stored level does not lower it", async () => {
    // The veto applies to the INITIAL assessment; the monotonic persist
    // applies to the stored value. They only meet when a stored level
    // already EXCEEDS the model's verdict, and there the deterministic
    // page escalation that produced it wins.
    const h = harness();
    const id = critical(h, { ai_assessment: null, has_mx: 0 });
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }),
    );
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("LOW"));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });

    await checkLookalikeBatchForBrand(h.env, "b1");

    expect(analyzeWithHaikuSpy).toHaveBeenCalledTimes(1);
    const row = h.row(id);
    expect(row.threat_level).toBe("CRITICAL");
    // The assessment itself IS recorded — the verdict is data even when
    // it does not move the level.
    expect(row.ai_assessment).toBe("assessed LOW");
  });

  it("a failed Haiku call does not blank the stored assessment", async () => {
    const h = harness();
    const id = critical(h);
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }),
    );
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });

    await checkLookalikeBatchForBrand(h.env, "b1");

    // `ai_assessment` is already set, so no call is even attempted —
    // and the text `agents/sparrow.ts` embeds in the takedown evidence
    // packet survives.
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    expect(h.row(id).ai_assessment).toBe("credential harvest kit");
  });

  it("an answered lapse stamps the linked takedown down, reusing Sparrow's contract", async () => {
    // Same two columns Sparrow's Phase F writes on its own 7-day
    // cadence, from the same `checkDomain` observation arriving via the
    // lookalike lane — often sooner.
    const h = harness();
    await h.env.DB.prepare(
      `INSERT INTO takedown_requests (id, status, target_type, target_value, verification_status, last_verified_at)
       VALUES ('td1', 'taken_down', 'domain', 'acm3-1.example', NULL, NULL)`,
    ).run();
    const id = critical(h, { takedown_id: "td1" });
    checkDomainSpy.mockResolvedValue(answer({ registered: false }));

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.registrations_lost).toBe(1);
    expect(summary.takedowns_verified_down).toBe(1);
    const td = await h.env.DB.prepare(
      `SELECT verification_status, last_verified_at FROM takedown_requests WHERE id = 'td1'`,
    ).first<{ verification_status: string | null; last_verified_at: string | null }>();
    expect(td!.verification_status).toBe("down");
    expect(td!.last_verified_at).not.toBeNull();
    // The lapse is persisted but the level is NOT downgraded: a squat
    // that lapsed is still evidence of who targeted this brand, and
    // Sparrow reads this column for takedown priority.
    expect(h.row(id).registered).toBe(0);
    expect(h.row(id).threat_level).toBe("CRITICAL");
    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("a lapse on a takedown that is NOT taken_down leaves it alone", async () => {
    const h = harness();
    await h.env.DB.prepare(
      `INSERT INTO takedown_requests (id, status, target_type, target_value, verification_status, last_verified_at)
       VALUES ('td2', 'submitted', 'domain', 'acm3-1.example', NULL, NULL)`,
    ).run();
    critical(h, { takedown_id: "td2" });
    checkDomainSpy.mockResolvedValue(answer({ registered: false }));

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.registrations_lost).toBe(1);
    // `verification_status` describes a TAKEN-DOWN target. A
    // submitted-but-unconfirmed takedown's lifecycle stays Sparrow's to
    // advance; writing 'down' here would claim a confirmation nobody
    // gave.
    expect(summary.takedowns_verified_down).toBe(0);
    const td = await h.env.DB.prepare(
      `SELECT verification_status FROM takedown_requests WHERE id = 'td2'`,
    ).first<{ verification_status: string | null }>();
    expect(td!.verification_status).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// The seeder must put new candidates ON the schedule
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("generateAndStoreLookalikes — new rows are DUE, not parked", () => {
  it("a freshly seeded candidate is checked on the very next tick", async () => {
    // THE SILENT-DEATH CASE. `check_due_at IS NULL` means PARKED, and
    // both cohort indexes are partial on `check_due_at IS NOT NULL`, so
    // a seeder that forgot this column would mint ~56,010 rows that the
    // checker can NEVER see — the entire widened pipeline doing nothing,
    // with no error anywhere. Under the previous arrangement "due" was
    // the ABSENCE of a value (`last_checked IS NULL`), so the seeder had
    // nothing to remember; that is exactly why this needs a test now.
    const h = harness();
    const created = await generateAndStoreLookalikes(h.env, "b1", "acme.example");
    expect(created, "dnstwist produced permutations").toBeGreaterThan(0);

    const parked = await h.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM lookalike_domains WHERE check_due_at IS NULL`,
    ).first<{ n: number }>();
    expect(parked!.n, "no seeded row may be born parked").toBe(0);

    const due = await h.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM lookalike_domains
        WHERE check_due_at IS NOT NULL AND check_due_at <= datetime('now')`,
    ).first<{ n: number }>();
    expect(due!.n).toBe(created);

    // ...and the checker actually picks them up, which is the property
    // the counts above are only evidence for.
    checkDomainSpy.mockResolvedValue(answer());
    const summary = await checkLookalikeBatch(h.env);
    expect(summary.checked).toBeGreaterThan(0);
    expect(summary.selected_first_contact).toBeGreaterThan(0);
  });

  it("re-seeding the same brand does not re-schedule rows it already has", async () => {
    // `INSERT OR IGNORE` means a second pass changes nothing — including
    // the schedule, so a row mid-backoff is not quietly re-admitted by a
    // seeder re-run.
    const h = harness();
    await generateAndStoreLookalikes(h.env, "b1", "acme.example");
    await h.env.DB.prepare(
      `UPDATE lookalike_domains SET check_due_at = '2099-01-01 00:00:00', check_attempts = 4`,
    ).run();

    const second = await generateAndStoreLookalikes(h.env, "b1", "acme.example");
    expect(second, "nothing new to insert").toBe(0);

    const moved = await h.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM lookalike_domains
        WHERE check_due_at != '2099-01-01 00:00:00' OR check_attempts != 4`,
    ).first<{ n: number }>();
    expect(moved!.n).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BLOCKER — the attempt counter must ACCUMULATE and the ladder must END
// ═══════════════════════════════════════════════════════════════════
//
// `applyCheckBackoff` computed `attempts` from the SELECT SNAPSHOT to
// pick the ladder step, while the UPDATE wrote `check_attempts =
// check_attempts + 1` from the LIVE column. Those agree only while
// nothing writes the column in between — and `persistCheckFacts` sets
// `check_attempts = 0` and runs BEFORE the BIMI lane, the compositor,
// Haiku, the page fetch, `createAlert` and `recordTakedownDown`, i.e.
// before every throw the per-row catch exists to absorb.
//
// The result was a FIXED POINT:
//
//   tick 1  snapshot 0 -> step +60m  -> persist resets to 0 -> write 1
//   tick 2  snapshot 1 -> step +240m -> persist resets to 0 -> write 1
//   tick 3  snapshot 1 -> step +240m -> persist resets to 0 -> write 1
//
// `isTerminalAttempt(ladder, 2)` is false, so the row NEVER parked: it
// was re-selected ~6x/day forever at the HEAD of its cohort (+240m beats
// every healthy row's +24h), twenty such rows consumed the entire
// 20-slot re-check floor, and `row_errors` stayed non-zero on every run
// — pinning the agent diagnostic at `severity: "high"` with no
// resolution path.
//
// The two pre-existing error-isolation tests above assert only "cooled
// down" and "not re-selected NEXT tick", both of which the broken
// version satisfied. These assert the two things it did not.

describe.skipIf(!hasSqlite())("checkLookalikeBatch — the backoff ladder terminates", () => {
  /**
   * A row that throws PAST `persistCheckFacts` on every due pass.
   *
   * The BEC lane's guarded claim is the statement to fail: it is the one
   * un-caught `.run()` after the success path, and it runs on every due
   * pass of a registered + MX row whose `bimi_first_seen_at IS NULL`.
   * Every other post-persist collaborator is wrapped in a narrower
   * try/catch, which is exactly why this defect survived.
   */
  function poisoned(h: Harness): string {
    const id = h.seed({
      ...BASELINED,
      registered: 1,
      has_mx: 1,
      has_web: 1,
      resolves_to: "5.6.7.8",
    });
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }),
    );
    checkBIMISpy.mockResolvedValue(true);
    h.failOn("SET bimi_first_seen_at = datetime('now')");
    return id;
  }

  it("ACCUMULATES the attempt counter across consecutive failures", async () => {
    // Mutation-checked: restoring `check_attempts = check_attempts + 1`
    // in `stampCheckFailure` pins every reading below at 1.
    const h = harness();
    const id = poisoned(h);

    const seen: number[] = [];
    for (let tick = 1; tick <= 4; tick += 1) {
      const summary = await checkLookalikeBatch(h.env);
      expect(summary.row_errors, `tick ${tick} threw`).toBe(1);
      seen.push(h.row(id).check_attempts as number);
      await makeDue(h, id);
    }

    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("EVENTUALLY PARKS the row instead of re-admitting it forever", async () => {
    // The consequence that matters. `LOOKALIKE_CHECK_LADDER` parks past
    // 8 consecutive failures, so the 9th stamp writes `check_due_at =
    // NULL` and the row holds no entry in either partial cohort index.
    // Mutation-checked: with the old `check_attempts + 1` the counter
    // sticks at 1 and this loop runs out without ever parking.
    const h = harness();
    const id = poisoned(h);

    let parkedOnTick = 0;
    for (let tick = 1; tick <= 12 && parkedOnTick === 0; tick += 1) {
      const summary = await checkLookalikeBatch(h.env);
      if (summary.rows_parked > 0) {
        parkedOnTick = tick;
        break;
      }
      await makeDue(h, id);
    }

    expect(parkedOnTick, "the ladder must terminate").toBe(9);
    expect(h.row(id).check_due_at).toBeNull();
    expect(h.row(id).check_attempts).toBe(9);

    // ...and a parked row is genuinely out of the queue: the next tick
    // selects nothing at all, rather than serving it again.
    const after = await checkLookalikeBatch(h.env);
    expect(after.checked).toBe(0);
  });

  it("a SUCCESSFUL observation resets the counter, so recovery is real", async () => {
    const h = harness();
    const id = poisoned(h);
    await checkLookalikeBatch(h.env);
    await checkLookalikeBatch(h.env); // not due — no-op, proves the gate
    await makeDue(h, id);
    await checkLookalikeBatch(h.env);
    expect(h.row(id).check_attempts).toBe(2);

    // The resolver comes back AND the claim stops failing.
    const clean = harness();
    const good = clean.seed({ ...BASELINED, registered: 1, has_mx: 1, has_web: 1, check_attempts: 5 });
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }),
    );
    checkBIMISpy.mockResolvedValue(false);
    await checkLookalikeBatch(clean.env);
    expect(clean.row(good).check_attempts).toBe(0);
  });

  it("the unresolved-DNS branch accumulates too — the realistic trigger", async () => {
    // A sustained `cloudflare-dns.com` outage or rate-limit (a non-ok
    // DoH reply lands in the same branch as a timeout) is the way a
    // whole cohort actually parks, and it never reaches
    // `persistCheckFacts` at all. Pinned so the fix cannot regress the
    // path that was already correct.
    const h = harness();
    const id = h.seed(BASELINED);
    checkDomainSpy.mockResolvedValue(NO_ANSWER);

    const seen: number[] = [];
    for (let tick = 1; tick <= 3; tick += 1) {
      const summary = await checkLookalikeBatch(h.env);
      expect(summary.checks_unresolved).toBe(1);
      expect(summary.row_errors, "an unanswered probe is not a defect").toBe(0);
      seen.push(h.row(id).check_attempts as number);
      await makeDue(h, id);
    }
    expect(seen).toEqual([1, 2, 3]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// The swallowed-error counters, and the one permanent-loss path
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("checkLookalikeBatch — swallowed failures are COUNTED", () => {
  it("a missing brand row RELEASES the BIMI claim instead of losing the finding", async () => {
    // The security-lane find. `loadBrandContext` returning falsy took
    // NEITHER branch of the lane's claim-then-act protocol: `if (brand)`
    // was simply skipped, nothing threw, so the `catch`'s release never
    // ran. The row was left permanently marked BIMI-recorded with NO
    // ALERT IN EXISTENCE, and the lane's own eligibility predicate
    // (`bimi_first_seen_at IS NULL`) would never offer it again.
    const h = harness();
    const id = h.seed({ ...BASELINED, registered: 1, has_mx: 1, has_web: 0 });
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: false }),
    );
    checkBIMISpy.mockResolvedValue(true);
    // The brand the row points at no longer exists.
    await h.env.DB.prepare(`DELETE FROM brands WHERE id = 'b1'`).run();

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.bimi_alerts).toBe(0);
    // VISIBLE on `agent_runs`, not only in the log stream (CLAUDE.md §11).
    expect(summary.bimi_alert_errors).toBe(1);
    expect(summary.row_errors, "contained by the lane, not a row error").toBe(0);
    // THE CLAIM IS RELEASED. Mutation-checked: removing the release call
    // leaves this non-null and the finding is gone forever.
    expect(h.row(id).bimi_first_seen_at).toBeNull();

    // ...so once the brand is back, the very next pass files.
    await h.env.DB.prepare(
      `INSERT INTO brands (id, name, canonical_domain, tier)
       VALUES ('b1', 'Acme', 'acme.example', 'monitored')`,
    ).run();
    await makeDue(h, id);
    const retry = await checkLookalikeBatch(h.env);
    expect(retry.bimi_alerts).toBe(1);
    expect(retry.bimi_alert_errors).toBe(0);
  });

  it("a thrown typosquat_bimi alert is counted, not just logged", async () => {
    // The sibling test above this file's error-isolation block already
    // proves the claim is released. What it could not see is that the
    // failure existed at all: `row_errors` is 0 (the lane contains it)
    // and nothing else reached `agent_runs`.
    const h = harness();
    const id = h.seed({ ...BASELINED, registered: 1, has_mx: 1, has_web: 0 });
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: false }),
    );
    checkBIMISpy.mockResolvedValue(true);
    createAlertSpy.mockRejectedValue(new Error("alerts insert failed"));

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.row_errors).toBe(0);
    expect(summary.bimi_alert_errors).toBe(1);
    expect(h.row(id).bimi_first_seen_at).toBeNull();
  });

  it("a FAILED claim release is counted — the last silent-permanent-loss path", async () => {
    // If the release itself fails the row IS left marked BIMI-recorded
    // with no alert anywhere, which the lane will never offer again.
    // Nothing can undo that from here, so the only correct behaviour is
    // to make it visible.
    const h = harness();
    h.seed({ ...BASELINED, registered: 1, has_mx: 1, has_web: 0 });
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: false }),
    );
    checkBIMISpy.mockResolvedValue(true);
    createAlertSpy.mockRejectedValue(new Error("alerts insert failed"));
    h.failOn("SET bimi_first_seen_at = NULL");

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.bimi_alert_errors).toBe(1);
    expect(summary.bimi_claim_release_failures).toBe(1);
    // And it must not escalate into a row error — the lane still has to
    // contain it so the rest of the batch runs.
    expect(summary.row_errors).toBe(0);
  });

  it("a Haiku throw is counted — an AI outage must not raise HIGH alerts invisibly", async () => {
    const h = harness();
    h.seed({ ...BASELINED, registered: 0 });
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }),
    );
    analyzeWithHaikuSpy.mockRejectedValue(new Error("gateway 529"));

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.ai_assessment_errors).toBe(1);
    expect(summary.haiku_calls, "the spend was attempted and must be reported").toBe(1);
    expect(summary.row_errors).toBe(0);
  });

  it("a Haiku throw RELEASES the claim, so the row is deferred and not retired", async () => {
    // The claim's own failure mode, and the reason the claim lives in
    // its OWN column rather than as a sentinel in `ai_assessment`: a
    // claim nobody gives back permanently retires the row from the
    // lane, and `aiAttempted` is then false on every later pass — so the
    // compositor's base falls back to the stored LOW and BOTH
    // infrastructure boosts are MEDIUM-only. A mail+web row would sit at
    // LOW forever and never clear the HIGH alert floor.
    //
    // Mutation-checked: deleting the `releaseHaikuClaim` call makes the
    // retry spend nothing and the row stay at LOW.
    //
    // The retry is driven by a web FLAP rather than a bare re-check,
    // and that is not test convenience — see
    // `webFlap` below for the real limit it works around.
    const h = harness();
    const id = h.seed({ ...BASELINED, registered: 1, has_mx: 1, has_web: 0, resolves_to: "5.6.7.8" });
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }),
    );
    analyzeWithHaikuSpy.mockRejectedValue(new Error("gateway 529"));

    await checkLookalikeBatch(h.env);
    expect(analyzeWithHaikuSpy, "the pass did spend").toHaveBeenCalledTimes(1);
    expect(h.row(id).ai_claimed_at, "the claim was given back").toBeNull();
    expect(h.row(id).ai_assessment).toBeNull();

    // A later pass claims again and succeeds.
    await webFlap(h, id);
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("CRITICAL"));
    const retry = await checkLookalikeBatch(h.env);

    expect(retry.haiku_calls).toBe(1);
    expect(retry.ai_assessment_errors).toBe(0);
    expect(h.row(id).ai_assessment).toBe("assessed CRITICAL");
    expect(h.row(id).threat_level).toBe("CRITICAL");
  });

  it("an assessment that LANDED keeps the claim, so the lifetime bound holds", async () => {
    // The other direction: the release must be conditional on "this pass
    // produced nothing", or the claim buys nothing at all. Driven
    // through a second COMPOSITOR pass (not a bare re-check, which
    // would not reach the gate at all — see `webFlap`), so this tests
    // the gate rather than the dispatch.
    const h = harness();
    const id = h.seed({ ...BASELINED, registered: 1, has_mx: 1, has_web: 0, resolves_to: "5.6.7.8" });
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }),
    );
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("HIGH"));

    await checkLookalikeBatch(h.env);
    expect(h.row(id).ai_claimed_at).not.toBeNull();
    expect(h.row(id).ai_assessment).toBe("assessed HIGH");

    await webFlap(h, id);
    const second = await checkLookalikeBatch(h.env);
    expect(second.haiku_calls, "once per row per LIFETIME").toBe(0);
    expect(analyzeWithHaikuSpy).toHaveBeenCalledTimes(1);
  });

  it("an inline page-analysis throw is counted", async () => {
    const h = harness();
    h.seed({ ...BASELINED, registered: 0 });
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }),
    );
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("HIGH"));
    pageAnalysisSpy.mockRejectedValue(new Error("page write failed"));

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.inline_page_errors).toBe(1);
    expect(summary.row_errors).toBe(0);
  });

  it("a cooldown stamp that fails is counted — the row is NOT backed off", async () => {
    // The consequence is specific: an un-stamped row is re-selected on
    // the very next tick, which is the hot loop per-row isolation exists
    // to prevent.
    const h = harness();
    h.seed(BASELINED);
    checkDomainSpy.mockResolvedValue(NO_ANSWER);
    h.failOn("SET last_check_failed_at = datetime('now')");

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.checks_unresolved).toBe(1);
    expect(summary.cooldown_stamp_failures).toBe(1);
    expect(summary.rows_parked).toBe(0);
  });

  it("lookalikeCheckDefects folds every defect counter, and nothing else", async () => {
    // The agent's severity reads THIS, so an added counter cannot
    // silently miss the decision. The non-members are deliberate: an
    // unanswered DNS probe, a park, a re-admission and a budget cap are
    // all the system working.
    const clean = await emptyLikeSummary();
    expect(lookalikeCheckDefects(clean)).toBe(0);
    for (const k of [
      "row_errors", "bimi_alert_errors", "bimi_claim_release_failures",
      "cooldown_stamp_failures", "ai_assessment_errors", "inline_page_errors",
    ] as const) {
      expect(lookalikeCheckDefects({ ...clean, [k]: 3 }), k).toBe(3);
    }
    for (const k of [
      "checks_unresolved", "rows_parked", "rows_unparked",
      "alerts_withheld_below_floor", "baselines_suppressed",
    ] as const) {
      expect(lookalikeCheckDefects({ ...clean, [k]: 3 }), k).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// A parked row has an AUTOMATIC way back
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("checkLookalikeBatch — the un-park sweep", () => {
  it("re-admits a long-parked row and checks it in the same tick", async () => {
    // Four writers touch `check_due_at` and three of them require the
    // row to have been SELECTED, which a parked row is not — so the only
    // exit was the MANUAL per-brand rescan. A row parked before its
    // first successful observation also still carries the seeder's
    // `registered = 0 / has_web = 0 / resolves_to NULL`, which makes it
    // invisible to BOTH page-analysis cohorts as well.
    const h = harness();
    const id = h.seed({
      check_due_at: null,
      check_attempts: 9,
      last_check_failed_at: "2020-01-01 00:00:00",
    });
    checkDomainSpy.mockResolvedValue(answer());

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.rows_unparked).toBe(1);
    expect(summary.checked, "re-admitted and checked in the same tick").toBe(1);
    expect(h.row(id).check_due_at).not.toBeNull();
  });

  it("leaves a recently-parked row alone, so the cadence is long not instant", async () => {
    const h = harness();
    const id = h.seed({
      check_due_at: null,
      check_attempts: 9,
      last_check_failed_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    });
    checkDomainSpy.mockResolvedValue(answer());

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.rows_unparked).toBe(0);
    expect(summary.checked).toBe(0);
    expect(h.row(id).check_due_at).toBeNull();
  });

  it("a re-admitted row that fails again RE-PARKS on one probe, not a ladder replay", async () => {
    // `check_attempts` is deliberately not reset by the sweep: resetting
    // it would send a still-dead row back through the whole
    // 1h/4h/12h/24h/48h ladder — ~8 further DNS probes over 10 days —
    // every window. Past the terminal count the row is probed ONCE.
    const h = harness();
    const id = h.seed({
      check_due_at: null,
      check_attempts: 9,
      last_check_failed_at: "2020-01-01 00:00:00",
    });
    checkDomainSpy.mockResolvedValue(NO_ANSWER);

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.rows_unparked).toBe(1);
    expect(summary.checks_unresolved).toBe(1);
    expect(summary.rows_parked, "one probe, straight back to parked").toBe(1);
    expect(h.row(id).check_due_at).toBeNull();
    // ...and `last_check_failed_at` moved, which is what defers the next
    // re-admission by another whole window. That self-throttle is the
    // whole reason this needs no cursor, no KV and no counter column.
    expect(h.row(id).last_check_failed_at).not.toBe("2020-01-01 00:00:00");
  });

  it("a re-admitted row that SUCCEEDS rejoins the normal cadence", async () => {
    const h = harness();
    const id = h.seed({
      ...BASELINED,
      check_due_at: null,
      check_attempts: 9,
      last_check_failed_at: "2020-01-01 00:00:00",
    });
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8" }));

    await checkLookalikeBatch(h.env);

    expect(h.row(id).check_attempts).toBe(0);
    expect(h.row(id).last_check_failed_at).toBeNull();
    expect(h.row(id).check_due_at).not.toBeNull();
  });

  it("the sweep is bounded per tick", async () => {
    const h = harness();
    for (let i = 0; i < 40; i += 1) {
      h.seed({
        check_due_at: null,
        check_attempts: 9,
        last_check_failed_at: `2020-01-${String((i % 28) + 1).padStart(2, "0")} 00:00:00`,
      });
    }
    checkDomainSpy.mockResolvedValue(answer());

    const summary = await checkLookalikeBatch(h.env);

    expect(summary.rows_unparked).toBe(LOOKALIKE_UNPARK_PER_RUN);
  });

  it("the brand rescan path does NOT run the global sweep", async () => {
    // Running it from a request path would let one button press
    // re-admit other tenants' rows. The handler's own enqueue already
    // revives the brand being rescanned.
    const h = harness();
    const mine = h.seed({
      check_due_at: null, check_attempts: 9, last_check_failed_at: "2020-01-01 00:00:00",
    });
    checkDomainSpy.mockResolvedValue(answer());

    const summary = await checkLookalikeBatchForBrand(h.env, "b1");

    expect(summary.rows_unparked).toBe(0);
    expect(h.row(mine).check_due_at).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// A re-registration after a lapse IS a new event
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("checkLookalikeBatch — lapse then re-registration", () => {
  it("files a SECOND alert on re-registration, and re-points alert_id", async () => {
    // A judgement call, pinned rather than left to a reading of the
    // code. `registration_gained` passes `allowAlert: true`
    // UNCONDITIONALLY — unlike the mx/web path, which bounds itself on
    // `alert_id IS NULL` — so a domain cycling registered -> lapsed ->
    // re-registered files one alert PER CYCLE.
    //
    // That is intended: a re-registration after a lapse is typically a
    // NEW REGISTRANT, which is the thing this platform exists to
    // notice, and suppressing it would make the second appearance of a
    // squat invisible forever. What it means is that "one alert per row
    // per lifetime" is true of the MX/WEB path, NOT of the row — and no
    // test exercised this cycle at all before now.
    const h = harness();
    const id = h.seed({ ...BASELINED, registered: 1, has_mx: 1, has_web: 1, resolves_to: "5.6.7.8" });
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("HIGH"));
    createAlertSpy.mockResolvedValue("alert_first");

    // ── The lapse. An ANSWERED 1 -> 0.
    checkDomainSpy.mockResolvedValue(answer({ registered: false }));
    const lapse = await checkLookalikeBatch(h.env);
    expect(lapse.registrations_lost).toBe(1);
    expect(h.row(id).registered).toBe(0);
    expect(createAlertSpy, "a lapse never alerts").not.toHaveBeenCalled();

    // ── The re-registration, one cadence later.
    await makeDue(h, id);
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "9.9.9.9", hasMx: true, hasWeb: true }),
    );
    createAlertSpy.mockResolvedValue("alert_second");
    const regained = await checkLookalikeBatch(h.env);

    expect(regained.new_registrations).toBe(1);
    const types = createAlertSpy.mock.calls.map((c) => (c[1] as { alertType: string }).alertType);
    expect(types).toEqual(["lookalike_domain_active"]);
    expect(h.row(id).alert_id).toBe("alert_second");

    // ── And a THIRD cycle alerts again, which is the property the
    // absent `alert_id` guard actually expresses.
    await makeDue(h, id);
    checkDomainSpy.mockResolvedValue(answer({ registered: false }));
    await checkLookalikeBatch(h.env);
    await makeDue(h, id);
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "9.9.9.9", hasMx: true, hasWeb: true }),
    );
    createAlertSpy.mockResolvedValue("alert_third");
    await checkLookalikeBatch(h.env);
    expect(h.row(id).alert_id).toBe("alert_third");
  });

  it("does NOT re-stamp first_seen on the second appearance", async () => {
    // The guard that IS lifetime-scoped: `WHERE id = ? AND first_seen IS
    // NULL`. The alert repeats; the recorded appearance date does not.
    const h = harness();
    const id = h.seed({
      ...BASELINED, registered: 1, has_mx: 1, has_web: 1,
      first_seen: "2026-03-04 05:06:07",
    });
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("HIGH"));

    checkDomainSpy.mockResolvedValue(answer({ registered: false }));
    await checkLookalikeBatch(h.env);
    await makeDue(h, id);
    checkDomainSpy.mockResolvedValue(
      answer({ registered: true, ip: "9.9.9.9", hasMx: true, hasWeb: true }),
    );
    await checkLookalikeBatch(h.env);

    expect(h.row(id).first_seen).toBe("2026-03-04 05:06:07");
  });
});
