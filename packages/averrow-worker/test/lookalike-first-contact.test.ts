/**
 * First contact vs. observed transition, and the HIGH severity floor.
 *
 * `checkLookalikeBatch` used to read `result.registered && row.registered
 * === 0` as a NEW REGISTRATION. `registered = 0` is the seeder's INSERT
 * default, so on a row nobody has ever resolved that test is answering a
 * question it was never asked: it fires for a squat registered in 2019
 * just as readily as for one registered last night. The monitored-brand
 * seeder turns that from a data-quality wart into an alert flood
 * (~10,770 rows arriving at first contact, 10-35% of them resolving).
 *
 * These tests pin the three behaviours that fixes it:
 *   1. `last_checked IS NULL` is the first-contact discriminator, and a
 *      signal-less first contact spends NO Haiku tokens and files NO
 *      alert.
 *   2. `first_seen` stays reserved for transitions we actually observed;
 *      first contact stamps `baseline_established_at` instead.
 *   3. The severity floor withholds sub-HIGH alerts on BOTH paths while
 *      persisting everything else.
 *
 * The D1 mock interprets the statement shapes `checkLookalikeBatch`
 * issues rather than matching SQL strings, so an assertion here fails on
 * a behaviour change and not on a reformatting.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

// ─── Collaborator mocks ───────────────────────────────────────────
// Every one of these is a network call or a token spend in production.
// `analyzeWithHaikuSpy`'s CALL COUNT is itself an assertion target: the
// whole point of the first-contact branch is that it never runs.

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

const { checkLookalikeBatch, checkLookalikeBatchForBrand } = await import("../src/scanners/lookalike-domains");

// ─── D1 mock ──────────────────────────────────────────────────────

interface StoredRow {
  id: string;
  brand_id: string;
  domain: string;
  permutation_type: string;
  registered: number;
  unicode_domain: string | null;
  last_checked: string | null;
  // Written by the statements under test.
  first_seen: string | null;
  /**
   * Migration 0267, AMENDED: this — not `last_checked` — is the
   * first-contact discriminator now. `last_checked` keeps exactly one
   * job ("when did we last successfully observe"), and dueness lives in
   * `check_due_at`.
   */
  baseline_established_at: string | null;
  /** Migration 0268 — the historical record of the last failed attempt. */
  last_check_failed_at: string | null;
  /** Migration 0269 — the schedule. NULL = PARKED by the backoff ladder. */
  check_due_at: string | null;
  check_attempts: number;
  /** Migration 0269 — the recurring BEC lane's presence-only marker. */
  bimi_first_seen_at: string | null;
  /**
   * Migration 0269 — the Haiku lifetime gate's CLAIM TOKEN. The gate was
   * a read of the SELECT snapshot (`row.ai_assessment === null`), which
   * two concurrent runs could both pass on the same row; it is now a
   * guarded `UPDATE ... WHERE id = ? AND ai_assessment IS NULL AND
   * (ai_claimed_at IS NULL OR ai_claimed_at <= <stale>)`.
   */
  ai_claimed_at: string | null;
  threat_level: string | null;
  ai_assessment: string | null;
  alert_id: string | null;
  takedown_id: string | null;
  resolves_to: string | null;
  has_mx: number | null;
  has_web: number | null;
}

const NOW = "MOCK_NOW";
/** What a successful check's `check_due_at` becomes: not due any more. */
const LATER = "MOCK_NOW_PLUS_CADENCE";

function makeRow(over: Partial<StoredRow> = {}): StoredRow {
  return {
    id: "l1",
    brand_id: "b1",
    domain: "acm3.example",
    permutation_type: "replacement",
    registered: 0,
    unicode_domain: null,
    last_checked: null,
    first_seen: null,
    baseline_established_at: null,
    last_check_failed_at: null,
    check_due_at: "2026-01-01 00:00:00",
    check_attempts: 0,
    bimi_first_seen_at: null,
    ai_claimed_at: null,
    threat_level: null,
    ai_assessment: null,
    alert_id: null,
    takedown_id: null,
    resolves_to: null,
    has_mx: null,
    has_web: null,
    ...over,
  };
}

function makeEnv(rows: StoredRow[]): { env: Env; store: Map<string, StoredRow> } {
  // The SELECT snapshots the rows, exactly as D1 does — later UPDATEs
  // mutate the store, never the snapshot the loop is iterating.
  const snapshot = rows.map((r) => ({ ...r }));
  const store = new Map(rows.map((r) => [r.id, r]));

  const DB = {
    prepare(sql: string) {
      const exec = (args: unknown[]) => ({
        async all() {
          if (sql.includes("FROM lookalike_domains ld")) return { results: snapshot };
          throw new Error(`unexpected .all() for: ${sql}`);
        },
        async first() {
          if (sql.includes("FROM brands")) {
            return { brand_name: "Acme", domain: "acme.example" };
          }
          throw new Error(`unexpected .first() for: ${sql}`);
        },
        async run(): Promise<{ meta: { changes: number } }> {
          if (sql.includes("SET registered = ?")) {
            // The per-check UPDATE. Bind order:
            // registered, aAnswered, ip, mxAnswered, hasMx,
            // webAnswered, hasWeb, firstContactFlag, cadenceModifier, id.
            //
            // The three `CASE WHEN ? = 1 THEN ? ELSE <column> END` arms
            // are re-stated below, with the same caveat as the baseline
            // CASE: this is a PLAUSIBLE row for the behavioural
            // assertions around it, not a test of the SQL. The
            // don't-overwrite semantics are executed against real SQLite
            // in `test/lookalike-sql-statements.test.ts`.
            const [
              registered, aAnswered, ip, mxAnswered, hasMx,
              webAnswered, hasWeb, firstContact, , id,
            ] = args as [
              number, number, string | null, number, number,
              number, number, number, string, string,
            ];
            const row = store.get(id);
            if (row) {
              row.registered = registered;
              if (aAnswered === 1) row.resolves_to = ip;
              if (mxAnswered === 1) row.has_mx = hasMx;
              if (webAnswered === 1) row.has_web = hasWeb;
              row.last_checked = NOW;
              row.last_check_failed_at = null;
              // Migration 0269: a successful observation resets the
              // ladder and schedules the next check a cadence out. The
              // exact stamp does not matter here — "not due any more" is
              // the only property these assertions rest on.
              row.check_attempts = 0;
              row.check_due_at = LATER;
              // `CASE WHEN ? = 1 AND baseline_established_at IS NULL
              //   THEN datetime('now') ELSE <self> END`.
              //
              // NOTE: this is a RE-STATEMENT of the SQL, not a test of
              // it — inverting the real CASE's arms would leave these
              // assertions green. The statement itself is executed
              // against real SQLite in
              // `test/lookalike-sql-statements.test.ts`, which is what
              // actually pins the single-write invariant; the branch
              // here only exists so the surrounding behavioural
              // assertions see a plausible row.
              if (firstContact === 1 && row.baseline_established_at === null) {
                row.baseline_established_at = NOW;
              }
            }
          } else if (sql.includes("SET last_check_failed_at = datetime('now')")) {
            // The failed-check branch: the historical record, the
            // attempt counter, and the ladder's next due stamp (NULL =
            // PARK). NO registration state, and `last_checked`
            // deliberately untouched.
            //
            // `check_attempts` is BOUND now, not `check_attempts + 1`.
            // The two derivations it replaced (the caller's, from the
            // SELECT snapshot, and the statement's, from the live
            // column) disagreed whenever the success path had already
            // reset the column — which is every throw past
            // `persistCheckFacts` — and pinned the counter at a fixed
            // point the ladder could never terminate on.
            const [attempts, nextDueAt, id] = args as [number, string | null, string];
            const row = store.get(id);
            if (row) {
              row.last_check_failed_at = NOW;
              row.check_attempts = attempts;
              row.check_due_at = nextDueAt;
            }
          } else if (sql.includes("SET ai_claimed_at = datetime('now')")) {
            // The Haiku lifetime gate's guarded claim. Re-stated with
            // the usual caveat (the statement itself runs against real
            // SQLite in the sibling file); what matters here is that it
            // reports ONE changed row for a claimable row and ZERO
            // otherwise, because that boolean is what decides whether a
            // token call happens.
            const [id] = args as [string];
            const row = store.get(id);
            if (row && row.ai_assessment === null && row.ai_claimed_at === null) {
              row.ai_claimed_at = NOW;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          } else if (sql.includes("SET ai_claimed_at = NULL")) {
            // Released when the pass produced no assessment, which is
            // what keeps a throttled or failed call DEFERRED rather
            // than retired.
            const [id] = args as [string];
            const row = store.get(id);
            if (row) row.ai_claimed_at = null;
          } else if (sql.includes("SET check_due_at = datetime('now')")) {
            // The un-park sweep. `WHERE id IN (SELECT ... LIMIT ?)` is
            // not worth re-implementing here: no test in this file seeds
            // a parked row, and the statement is executed against real
            // SQLite in `test/lookalike-sql-statements.test.ts` and
            // driven end-to-end in `test/lookalike-review-fixes.test.ts`.
            return { meta: { changes: 0 } };
          } else if (sql.includes("SET first_seen = datetime('now')")) {
            const [id] = args as [string];
            const row = store.get(id);
            // `WHERE id = ? AND first_seen IS NULL` — same caveat as
            // above; the guard is pinned in the real-SQLite lane.
            if (row && row.first_seen === null) row.first_seen = NOW;
          } else if (sql.includes("SET threat_level = CASE")) {
            // The compositor's MONOTONIC persist. Bind order: newRank,
            // newLevel, hasAssessment, assessment, id. Re-stated with
            // the same caveat; the rank CASE and the assessment guard
            // are executed against real SQLite in the sibling file.
            const [rank, level, hasAssessment, assessment, id] =
              args as [number, string, number, string | null, string];
            const row = store.get(id);
            if (row) {
              const RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
              const stored = row.threat_level === null ? -1 : (RANK[row.threat_level] ?? 0);
              if (rank >= stored) row.threat_level = level;
              if (hasAssessment === 1) row.ai_assessment = assessment;
            }
          } else if (sql.includes("SET bimi_first_seen_at = datetime('now')")) {
            // The BEC lane's guarded claim. Reports 0 changes on an
            // already-claimed row, which is what makes the lane
            // file-once.
            const [id] = args as [string];
            const row = store.get(id);
            if (row && row.bimi_first_seen_at === null) {
              row.bimi_first_seen_at = NOW;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          } else if (sql.includes("SET bimi_first_seen_at = NULL")) {
            const [id] = args as [string];
            const row = store.get(id);
            if (row) row.bimi_first_seen_at = null;
          } else if (sql.includes("SET alert_id = ?")) {
            const [alertId, id] = args as [string, string];
            const row = store.get(id);
            if (row) row.alert_id = alertId;
          } else if (sql.includes("UPDATE takedown_requests")) {
            // The lapse branch's reuse of Sparrow's verification
            // contract. No takedown store here — the statement itself is
            // executed against real SQLite in the sibling file.
            return { meta: { changes: 0 } };
          } else {
            throw new Error(`unexpected .run() for: ${sql}`);
          }
          return { meta: { changes: 1 } };
        },
      });
      return { ...exec([]), bind: (...args: unknown[]) => exec(args) };
    },
  };

  return { env: { DB } as unknown as Env, store };
}

/**
 * A `checkDomain` result with every PER-PROBE answer flag set.
 *
 * The flags are what the per-check UPDATE gates each field's write on
 * (migration-0268-era `resolved` covers `registered` only), so a mock
 * that omitted them would exercise the DON'T-OVERWRITE path while every
 * assertion around it claimed to be testing the normal one. Tests that
 * want an unanswered probe pass the flag explicitly.
 */
function dnsAnswer(over: Record<string, unknown>) {
  return { aAnswered: true, mxAnswered: true, webAnswered: true, ...over };
}

function haikuSays(level: string) {
  return {
    success: true,
    data: { response: "", structured: { threat_level: level, assessment: `assessed ${level}` } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  checkBIMISpy.mockResolvedValue(false);
  createAlertSpy.mockResolvedValue("alert_1");
  analyzeWithHaikuSpy.mockResolvedValue(haikuSays("MEDIUM"));
});

// ─── Part 1 — first contact is baseline establishment ─────────────

describe("checkLookalikeBatch — first contact (baseline_established_at IS NULL)", () => {
  it("resolving with NO signal: no Haiku call, no alert, no first_seen", async () => {
    // The seeder-backlog shape: never looked at, registered years ago,
    // parked. Thousands of rows look exactly like this.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: false, hasWeb: true }));
    const { env, store } = makeEnv([makeRow()]);

    await checkLookalikeBatch(env);

    // THE cost control. Not a nicety: this is the branch that decides
    // whether the seeder backlog costs thousands of Haiku calls or zero.
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    expect(createAlertSpy).not.toHaveBeenCalled();
    // ...and no inline page fetch either — the other budget this path
    // would otherwise starve.
    expect(pageAnalysisSpy).not.toHaveBeenCalled();
    // ...and no BIMI lookup, because BIMI is a MAIL signal and this row
    // has no MX. The lane's gate is `hasMx`, not "any baseline".
    expect(checkBIMISpy).not.toHaveBeenCalled();

    const row = store.get("l1")!;
    // The DNS facts ARE recorded. Withholding the alert is not
    // withholding the data.
    expect(row.registered).toBe(1);
    expect(row.resolves_to).toBe("5.6.7.8");
    expect(row.has_web).toBe(1);
    expect(row.has_mx).toBe(0);
    // Baseline stamped, `first_seen` untouched: we learned that it
    // resolves, not when it appeared.
    expect(row.baseline_established_at).toBe(NOW);
    expect(row.first_seen).toBeNull();
    expect(row.alert_id).toBeNull();
    // And it is scheduled rather than left permanently due.
    expect(row.check_due_at).toBe(LATER);
    expect(row.check_attempts).toBe(0);
  });

  it("mail AND web together IS a signal: full assessment runs and alerts", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    const { env, store } = makeEnv([makeRow()]);

    await checkLookalikeBatch(env);

    expect(analyzeWithHaikuSpy).toHaveBeenCalledTimes(1);
    // MEDIUM from Haiku + the mail-and-web boost = HIGH, which clears
    // the floor.
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy.mock.calls[0]![1]).toMatchObject({
      alertType: "lookalike_domain_active",
      severity: "HIGH",
    });
    const row = store.get("l1")!;
    expect(row.threat_level).toBe("HIGH");
    expect(row.alert_id).toBe("alert_1");
    // Still a baseline, not an appearance — even though it alerted.
    expect(row.baseline_established_at).toBe(NOW);
    expect(row.first_seen).toBeNull();
  });

  it("MX alone and web alone are each NOT a signal", async () => {
    for (const infra of [
      { hasMx: true, hasWeb: false },
      { hasMx: false, hasWeb: false },
    ]) {
      vi.clearAllMocks();
      checkBIMISpy.mockResolvedValue(false);
      createAlertSpy.mockResolvedValue("alert_1");
      analyzeWithHaikuSpy.mockResolvedValue(haikuSays("MEDIUM"));
      checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", ...infra }));
      const { env } = makeEnv([makeRow()]);
      await checkLookalikeBatch(env);
      expect(analyzeWithHaikuSpy, JSON.stringify(infra)).not.toHaveBeenCalled();
      expect(createAlertSpy, JSON.stringify(infra)).not.toHaveBeenCalled();
    }
  });

  it("stamps the baseline even when first contact finds NOTHING registered", async () => {
    // The column records OUR coverage, not the domain's status, so an
    // unregistered first contact is still a baseline. This is why it is
    // stamped in the per-check UPDATE rather than in the branch.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: false, resolved: true, hasMx: false, hasWeb: false }));
    const { env, store } = makeEnv([makeRow()]);

    await checkLookalikeBatch(env);

    const row = store.get("l1")!;
    expect(row.baseline_established_at).toBe(NOW);
    expect(row.registered).toBe(0);
    expect(row.first_seen).toBeNull();
    expect(createAlertSpy).not.toHaveBeenCalled();
  });
});

// ─── The boundary itself ──────────────────────────────────────────

describe("checkLookalikeBatch — the boundary is baseline_established_at", () => {
  /**
   * A row we HAVE observed, and observed to be absent.
   *
   * Carries `baseline_established_at` as well as `last_checked` because
   * the DISCRIMINATOR is now the former (migration 0267, amended). The
   * two used to be the same fact expressed in one column, which is why
   * `last_checked` could be manipulated by a scheduling operation and
   * silently reclassify the row.
   */
  const observedAbsent = {
    last_checked: "2026-09-01 00:00:00",
    baseline_established_at: "2026-09-01 00:00:00",
    registered: 0,
  };

  it("last_checked alone no longer makes a row a re-check", async () => {
    // THE FLIP, stated as a test. A row with a `last_checked` but NO
    // baseline is first contact — which is the state the "Scan now"
    // handler's old `last_checked = NULL` reset used to FORGE in the
    // opposite direction, and the state migration 0267's disambiguation
    // UPDATE exists to prevent on the ~120 legacy rows.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: false, hasWeb: true }));
    const { env, store } = makeEnv([makeRow({ last_checked: "2026-09-01 00:00:00" })]);

    await checkLookalikeBatch(env);

    const row = store.get("l1")!;
    // Baseline establishment, not an appearance: no `first_seen`, no
    // Haiku, no alert.
    expect(row.baseline_established_at).toBe(NOW);
    expect(row.first_seen).toBeNull();
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("a BASELINED row takes the transition path and stamps a real first_seen", async () => {
    // Identical DNS result to the suppressed case above — no MX, web
    // only. The ONLY difference is that the row carries a baseline, and
    // that is enough to make this a transition we witnessed.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: false, hasWeb: true }));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([makeRow(observedAbsent)]);

    await checkLookalikeBatch(env);

    const row = store.get("l1")!;
    // first_seen stamped — this is the transition case...
    expect(row.first_seen).toBe(NOW);
    // ...and the baseline column is NOT re-stamped.
    expect(row.baseline_established_at).toBe("2026-09-01 00:00:00");
  });

  it("a transition with neither mail nor web spends NO Haiku", async () => {
    // A DELIBERATE NARROWING. Haiku used to run on EVERY observed
    // 0 -> 1. It is now gated on mail+web (and on `ai_assessment IS
    // NULL`) on every path. What is given up is a Haiku-only HIGH on a
    // bare registration; what covers it instead is the deterministic
    // page pass, which sees any row with a web server one pass later
    // and can raise the alert itself.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: false, hasWeb: false }));
    const { env, store } = makeEnv([makeRow(observedAbsent)]);

    await checkLookalikeBatch(env);

    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    // The transition is still RECORDED.
    expect(store.get("l1")!.first_seen).toBe(NOW);
  });

  it("does not re-stamp baseline_established_at on a later check", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("HIGH"));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([
      makeRow({ ...observedAbsent, baseline_established_at: "2026-06-01 00:00:00" }),
    ]);

    await checkLookalikeBatch(env);

    expect(store.get("l1")!.baseline_established_at).toBe("2026-06-01 00:00:00");
  });

  it("a baselined row that lapses and re-registers gets a REAL first_seen", async () => {
    // The case migration 0267 calls out: both columns set, legitimately.
    // The squat was already registered when we first looked (baseline),
    // expired (registered flipped back to 0), and has now been
    // re-registered — a 0 -> 1 transition we genuinely observed.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "9.9.9.9", hasMx: true, hasWeb: true }));
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("HIGH"));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([
      makeRow({
        last_checked: "2026-09-20 00:00:00",
        registered: 0,
        baseline_established_at: "2026-06-01 00:00:00",
      }),
    ]);

    await checkLookalikeBatch(env);

    const row = store.get("l1")!;
    expect(row.baseline_established_at).toBe("2026-06-01 00:00:00");
    expect(row.first_seen).toBe(NOW);
  });
});

// ─── Part 2 — the transitions the widened SELECT made visible ─────

describe("checkLookalikeBatch — transition detection", () => {
  /** A registered, resolving, web-only row we have observed before. */
  const webOnly = {
    last_checked: "2026-09-01 00:00:00",
    baseline_established_at: "2026-09-01 00:00:00",
    registered: 1,
    resolves_to: "5.6.7.8",
    has_mx: 0,
    has_web: 1,
    threat_level: "LOW",
  };

  it("an MX appearance that COMPLETES mail+web assesses and alerts, once", async () => {
    // THE DETECTION HOLE THIS CLOSES. Before the widened SELECT the
    // checker could only see `registered 0 -> 1`, so a row first
    // observed as web-only could later acquire MX — becoming exactly the
    // operational shape first contact alerts on — and the checker could
    // never reach it again. The row would sit at LOW forever with no
    // notification.
    //
    // A DELIBERATE DEPARTURE from a strict reading of "MX-alone and
    // web-alone file no alert of their own": the stated reason for that
    // rule is that MX alone is a registrar default and web alone a
    // parking lander. A gain that COMPLETES the pair is neither. Bounded
    // three ways — the pair must be complete, the row must carry no
    // alert yet, and the composed level must clear the HIGH floor.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([makeRow(webOnly)]);

    await checkLookalikeBatch(env);

    const row = store.get("l1")!;
    expect(row.has_mx).toBe(1);
    // MEDIUM from Haiku + the mail-and-web boost = HIGH.
    expect(analyzeWithHaikuSpy).toHaveBeenCalledTimes(1);
    expect(row.threat_level).toBe("HIGH");
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(row.alert_id).toBe("alert_1");
    // NOT a registration event — the domain did not appear, it gained a
    // capability.
    expect(row.first_seen).toBeNull();
  });

  it("an MX appearance that does NOT complete the pair files no alert", async () => {
    // The case the "no alert of its own" rule is actually about: MX
    // arriving on a row with no web server. Still re-opens the
    // compositor and the BIMI lane; still files nothing.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: false }));
    const { env, store } = makeEnv([makeRow({
      ...webOnly, has_web: 0,
    })]);

    await checkLookalikeBatch(env);

    const row = store.get("l1")!;
    expect(row.has_mx).toBe(1);
    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    // The BIMI lane DID run — that is the value of re-opening on an MX
    // appearance.
    expect(checkBIMISpy).toHaveBeenCalledWith("acm3.example");
  });

  it("an MX appearance does not re-alert a row that already has an alert", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env } = makeEnv([makeRow({ ...webOnly, alert_id: "alert_old" })]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("an answered lapse persists, does NOT downgrade threat_level, and files nothing", async () => {
    // `agents/sparrow.ts` reads `threat_level` for takedown eligibility
    // and priority, so downgrading a lapsed squat would silently
    // de-queue it. A squat that lapsed is still evidence of who targeted
    // this brand.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: false, resolved: true, hasMx: false, hasWeb: false }));
    const { env, store } = makeEnv([makeRow({
      ...webOnly, threat_level: "CRITICAL", has_mx: 1,
    })]);

    const summary = await checkLookalikeBatch(env);

    const row = store.get("l1")!;
    expect(row.registered).toBe(0);
    expect(row.threat_level).toBe("CRITICAL");
    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(summary.registrations_lost).toBe(1);
  });

  it("an answered mail/web loss persists only", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: false, hasWeb: false }));
    const { env, store } = makeEnv([makeRow({ ...webOnly, has_mx: 1 })]);

    const summary = await checkLookalikeBatch(env);

    const row = store.get("l1")!;
    expect(row.has_mx).toBe(0);
    expect(row.has_web).toBe(0);
    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(summary.mail_or_web_lost).toBe(1);
  });

  it("a resolves_to change is recorded, never a trigger", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "9.9.9.9", hasMx: false, hasWeb: true }));
    const { env, store } = makeEnv([makeRow(webOnly)]);

    const summary = await checkLookalikeBatch(env);

    expect(store.get("l1")!.resolves_to).toBe("9.9.9.9");
    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    expect(summary.mx_gained + summary.web_gained + summary.new_registrations).toBe(0);
  });

  it("an UNANSWERED probe cannot mint a transition", async () => {
    // The precondition `classifyLookalikeTransitions` documents. A
    // three-second MX timeout reports `hasMx: false`, and reading that
    // as a loss is migration 0268's defect generalised from `registered`
    // to every column.
    checkDomainSpy.mockResolvedValue(dnsAnswer({
      registered: true, resolved: true, ip: "5.6.7.8",
      hasMx: false, mxAnswered: false, hasWeb: false, webAnswered: false,
    }));
    const { env, store } = makeEnv([makeRow({ ...webOnly, has_mx: 1 })]);

    const summary = await checkLookalikeBatch(env);

    // Stored values preserved...
    expect(store.get("l1")!.has_mx).toBe(1);
    expect(store.get("l1")!.has_web).toBe(1);
    // ...and no loss reported.
    expect(summary.mail_or_web_lost).toBe(0);
    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("measures the mail+web share of the registered rows it observed", async () => {
    // `HAIKU_CALLS_PER_RUN` is sized against this ratio and nothing used
    // to record it — the only number available was a one-off manual
    // query (26 of 42 registered rows, 62%).
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env } = makeEnv([makeRow({ ...webOnly, ai_assessment: "already assessed" })]);

    const summary = await checkLookalikeBatch(env);

    expect(summary.observed_registered).toBe(1);
    expect(summary.observed_mail_and_web).toBe(1);
    expect(summary.observed_mx_only).toBe(0);
    expect(summary.observed_web_only).toBe(0);
  });
});

// ─── Part 2b — re-entrancy must not undo the Haiku veto ───────────

describe("checkLookalikeBatch — the Haiku veto survives re-entrancy", () => {
  /**
   * A row the model deliberately rated LOW, with mail AND web present.
   *
   * The user was asked whether a Haiku LOW may veto the deterministic
   * mail+web signal and chose to leave it as-is, so there is NO
   * `max(deterministic, ai)`. Under the old one-shot code that choice
   * was safe by accident — the compositor could not run twice. Making it
   * re-entrant is what puts it at risk.
   */
  const vetoedLow = {
    last_checked: "2026-09-01 00:00:00",
    baseline_established_at: "2026-09-01 00:00:00",
    registered: 1,
    resolves_to: "5.6.7.8",
    has_mx: 1,
    has_web: 1,
    threat_level: "LOW",
    ai_assessment: "benign fan site",
  };

  it("a re-entrant pass on a vetoed LOW row does not drift upward", async () => {
    // Exactly what the pass computes: no new Haiku call (the gate is
    // `ai_assessment IS NULL`, and the claim is already spent), so the
    // compositor's base is the STORED level — LOW — rather than a fresh
    // `'MEDIUM'`. The mail+web boost is MEDIUM-only, so it does not
    // fire. The monotonic persist writes nothing lower and nothing
    // higher.
    //
    // Had the base been re-seeded at MEDIUM (which is what a naive
    // extraction of the old straight-line code would do), the mail+web
    // boost WOULD fire and the row would silently reach HIGH on a pass
    // that learned nothing new about it.
    //
    // NO BIMI HERE, deliberately: the BIMI boost is no longer
    // MEDIUM-only (see the test below), so leaving it on would conflate
    // "the mail+web veto holds" with "the BIMI boost fires" and this
    // test would pass for the wrong reason.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    checkBIMISpy.mockResolvedValue(false);
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    // A fresh capability appearance, so the compositor definitely runs.
    const { env, store } = makeEnv([makeRow({ ...vetoedLow, has_mx: 0 })]);

    await checkLookalikeBatch(env);

    const row = store.get("l1")!;
    expect(analyzeWithHaikuSpy, "once per row per LIFETIME").not.toHaveBeenCalled();
    expect(row.threat_level).toBe("LOW");
    expect(row.ai_assessment).toBe("benign fan site");
    // ...and therefore no alert at all: LOW is below the floor.
    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("a BIMI record DOES raise a vetoed LOW row — we assert HIGH by alerting", async () => {
    // The counterpart to the test above, and a deliberate behaviour
    // change. The BIMI boost used to be MEDIUM-only like the mail+web
    // one, which produced an incoherent row: a Haiku-vetoed LOW row that
    // publishes a BIMI record kept `threat_level = 'LOW'` while this
    // file filed a FIXED-HIGH `typosquat_bimi` alert about it — and
    // `agents/sparrow.ts` gates takedown eligibility on `threat_level IN
    // ('HIGH','CRITICAL')`, so the most damning email signal the scanner
    // can find could never reach the takedown queue.
    //
    // Filing a HIGH alert IS the assertion that the row is HIGH, so the
    // level follows the alert. This does NOT reopen the Haiku veto for
    // the mail+web case — that is the test above, and it still holds.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    checkBIMISpy.mockResolvedValue(true);
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([makeRow({ ...vetoedLow, has_mx: 0 })]);

    await checkLookalikeBatch(env);

    const row = store.get("l1")!;
    expect(analyzeWithHaikuSpy, "still no new AI call").not.toHaveBeenCalled();
    expect(row.threat_level).toBe("HIGH");
    // The AI's own text is untouched — the level is raised, the
    // assessment is not rewritten.
    expect(row.ai_assessment).toBe("benign fan site");
    // And at HIGH the row now clears the floor, so the primary alert
    // lands alongside the BIMI one instead of the row sitting at LOW
    // with a HIGH alert about it.
    expect(createAlertSpy.mock.calls.map((c) => (c[1] as { alertType: string }).alertType))
      .toEqual(["typosquat_bimi", "lookalike_domain_active"]);
  });

  it("the BIMI boost NEVER lowers a CRITICAL a page verdict established", async () => {
    // Monotonic, like every other write in the compositor: raising to
    // HIGH must not be expressible as `level = 'HIGH'` unconditionally.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    checkBIMISpy.mockResolvedValue(true);
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([
      makeRow({ ...vetoedLow, has_mx: 0, threat_level: "CRITICAL" }),
    ]);

    await checkLookalikeBatch(env);

    expect(store.get("l1")!.threat_level).toBe("CRITICAL");
  });

  it("a page escalation CAN still raise a vetoed row — it is deterministic, not AI", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    pageAnalysisSpy.mockResolvedValue({
      result: { ok: true },
      phishing: { score: 95, credentialHarvest: true, signals: ["credential_form_off_domain"] },
    });
    const { env, store } = makeEnv([makeRow({ ...vetoedLow, has_mx: 0 })]);

    await checkLookalikeBatch(env);

    expect(store.get("l1")!.threat_level).toBe("CRITICAL");
  });

  it("a throttled or failed Haiku call does NOT blank a stored assessment", async () => {
    // The second live bug re-entrancy created. `ai_assessment` was
    // written unconditionally from a variable initialised `''`, and
    // `agents/sparrow.ts` embeds that text in the takedown evidence
    // packet.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    analyzeWithHaikuSpy.mockRejectedValue(new Error("gateway 529"));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    // `ai_assessment` NULL so the call is attempted, but a stored level
    // the failed call must not undercut.
    const { env, store } = makeEnv([makeRow({
      ...vetoedLow, has_mx: 0, ai_assessment: null, threat_level: "CRITICAL",
    })]);

    await checkLookalikeBatch(env);

    expect(analyzeWithHaikuSpy).toHaveBeenCalledTimes(1);
    const row = store.get("l1")!;
    // The failed call produced no text, so nothing was written...
    expect(row.ai_assessment).toBeNull();
    // ...and the MEDIUM fallback did not drag CRITICAL down.
    expect(row.threat_level).toBe("CRITICAL");
  });

  it("the per-run Haiku cap defers rather than drops", async () => {
    // With AI metering dead this cap is the only real cost bound, so a
    // capped row must stay eligible: `ai_assessment` is left NULL, which
    // is the gate's own predicate.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({
      id: `l${i}`,
      domain: `acm3-${i}.example`,
      last_checked: "2026-09-01 00:00:00",
      baseline_established_at: "2026-09-01 00:00:00",
      registered: 1, resolves_to: "5.6.7.8", has_mx: 0, has_web: 1,
    }));
    const { env, store } = makeEnv(rows);

    // `SCAN_NOW_CHECK_LIMITS.haikuCalls` is 3 — the smallest cap in the
    // codebase, and the cheapest way to drive this.
    const summary = await checkLookalikeBatchForBrand(env, "b1");

    expect(summary.haiku_calls).toBe(3);
    expect(summary.haiku_cap_hit).toBe(true);
    const unassessed = rows.filter((r) => store.get(r.id)!.ai_assessment === null);
    expect(unassessed).toHaveLength(2);
  });
});

// ─── Part 3 — the severity floor, in the checker ──────────────────

describe("checkLookalikeBatch — HIGH/CRITICAL severity floor", () => {
  const observed = {
    last_checked: "2026-09-01 00:00:00",
    baseline_established_at: "2026-09-01 00:00:00",
  };

  it("withholds a LOW alert on a genuine transition, but persists everything else", async () => {
    // THE BEHAVIOUR CHANGE. Before the floor this produced an alert that
    // no triage rule could ever clear. It now produces a fully-populated
    // row and no alert.
    //
    // LOW here is the Haiku veto standing against the mail+web signal,
    // which is also the only way the checker reaches a sub-HIGH level on
    // a fresh assessment at all: AI now runs ONLY when mail+web is
    // present, and mail+web lifts a MEDIUM to HIGH.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("LOW"));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([makeRow(observed)]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).not.toHaveBeenCalled();
    const row = store.get("l1")!;
    // The data is the deliverable; the alert is the notification.
    expect(row.threat_level).toBe("LOW");
    expect(row.ai_assessment).toBe("assessed LOW");
    expect(row.first_seen).toBe(NOW);
    // And critically: alert_id stays NULL, which is exactly the state
    // `analyzeLookalikePages`' own alert path keys on. A withheld row is
    // still reachable if its page later turns out to be phishing.
    expect(row.alert_id).toBeNull();
  });

  it("withholds a stored MEDIUM carried into a re-entrant pass", async () => {
    // The other way a sub-HIGH level reaches the floor now: no new AI
    // call (the row is already assessed), so the compositor's base is
    // the STORED level, and a mail-only transition cannot lift it.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: false }));
    const { env, store } = makeEnv([makeRow({
      ...observed, threat_level: "MEDIUM", ai_assessment: "assessed MEDIUM",
    })]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(store.get("l1")!.threat_level).toBe("MEDIUM");
  });

  it("lets CRITICAL through", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("CRITICAL"));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([makeRow(observed)]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(store.get("l1")!.alert_id).toBe("alert_1");
  });

  it("files the typosquat_bimi alert independently of the floor — and the BIMI boost clears it", async () => {
    // The floor is scoped to `lookalike_domain_active`, and an early
    // return on it would have swallowed a fixed-HIGH alert about the
    // single most damning email signal this scanner finds. That is the
    // property being pinned, and it still holds: `typosquat_bimi` is
    // filed BEFORE the floor is consulted.
    //
    // What changed is the second alert. A BIMI-publishing row is now
    // raised to HIGH (it used to stay at the Haiku LOW while a HIGH
    // alert was filed about it — see the compositor's boost comment), so
    // it clears the floor and the primary alert lands too. The ORDER is
    // the assertion that matters: BIMI first, from the lane that runs
    // ahead of the compositor.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("LOW"));
    checkBIMISpy.mockResolvedValue(true);
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([makeRow(observed)]);

    await checkLookalikeBatch(env);

    const types = createAlertSpy.mock.calls.map((c) => (c[1] as { alertType: string }).alertType);
    expect(types).toEqual(["typosquat_bimi", "lookalike_domain_active"]);
    expect(store.get("l1")!.threat_level).toBe("HIGH");
    // The BIMI alert is never what lands in `alert_id` — that would
    // permanently suppress `raiseUnalertedPhishingPageAlert`, which keys
    // on `alert_id IS NULL`. The id here is the primary alert's.
    expect(store.get("l1")!.alert_id).toBe("alert_1");
  });

  it("withholds the primary alert when BIMI is absent and the AI says LOW", async () => {
    // The floor's own behaviour, isolated from the BIMI boost — which is
    // what the test above used to be testing before the boost became
    // unconditional. Without this, nothing pins "a Haiku LOW with no
    // BIMI record files NOTHING".
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("LOW"));
    checkBIMISpy.mockResolvedValue(false);
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([makeRow(observed)]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(store.get("l1")!.threat_level).toBe("LOW");
    expect(store.get("l1")!.alert_id).toBeNull();
  });

  it("does not write alert_id when createAlert declines (NX2 tier gate)", async () => {
    // `createAlert` returns null for tier='tracked'. The link UPDATE is
    // guarded on a non-null id, so the column stays NULL rather than
    // being overwritten with one — which is what makes "alert_id IS
    // NULL" a trustworthy precondition for the page-analysis producer.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    createAlertSpy.mockResolvedValue(null);
    const { env, store } = makeEnv([makeRow(observed)]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).toHaveBeenCalled();
    expect(store.get("l1")!.alert_id).toBeNull();
  });
});
