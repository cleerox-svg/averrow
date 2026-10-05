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
 *      signal-less first contact files NO alert.
 *   2. `first_seen` stays reserved for transitions we actually observed;
 *      first contact stamps `baseline_established_at` instead.
 *   3. The severity floor withholds sub-HIGH alerts on BOTH paths while
 *      persisting everything else.
 *
 * Since AI_STRATEGY_2026-10 Phase 1 #18 the level is RULE-composed — no
 * Haiku call, no `ai_assessment` write. `lib/haiku` is deliberately NOT
 * mocked here: `fetch` is stubbed instead, so any model call reintroduced
 * into the lookalike pass shows up as a request to the Anthropic API /
 * AI Gateway and fails the "zero AI calls" assertions below.
 *
 * The D1 mock interprets the statement shapes `checkLookalikeBatch`
 * issues rather than matching SQL strings, so an assertion here fails on
 * a behaviour change and not on a reformatting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";

// ─── Collaborator mocks ───────────────────────────────────────────
// Every one of these is a network call in production.

const { checkDomainSpy, checkBIMISpy, createAlertSpy, pageAnalysisSpy, fetchSpy } =
  vi.hoisted(() => ({
    checkDomainSpy: vi.fn(),
    checkBIMISpy: vi.fn(),
    createAlertSpy: vi.fn(),
    pageAnalysisSpy: vi.fn(),
    fetchSpy: vi.fn(),
  }));

vi.mock("../src/lib/domain-checker", () => ({ checkDomain: checkDomainSpy }));
vi.mock("../src/email-security", () => ({ checkBIMIExists: checkBIMISpy }));
vi.mock("../src/lib/alerts", () => ({ createAlert: createAlertSpy }));
vi.mock("../src/scanners/lookalike-page-analysis", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/scanners/lookalike-page-analysis")>();
  return { ...actual, runPageAnalysisForDomain: pageAnalysisSpy };
});

const { checkLookalikeBatch, checkLookalikeBatchForBrand, composeRuleLevel } =
  await import("../src/scanners/lookalike-domains");

/** Every request to a model provider the stubbed `fetch` saw. */
function aiRequests(): string[] {
  return fetchSpy.mock.calls
    .map((c) => String(c[0] instanceof Request ? c[0].url : c[0]))
    .filter((u) => u.includes("anthropic.com") || u.includes("gateway.ai.cloudflare.com"));
}

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
   * Migration 0269 — the retired Haiku gate's claim token. The column
   * still exists; the scanner no longer reads or writes it.
   */
  ai_claimed_at: string | null;
  threat_level: string | null;
  ai_assessment: string | null;
  alert_id: string | null;
  takedown_id: string | null;
  resolves_to: string | null;
  has_mx: number | null;
  has_web: number | null;
  /** Migration 0282 — 'nrd' | 'observed' | NULL. */
  registration_evidence: string | null;
  /** Migration 0282 — the new-registration alert's claim. */
  registration_alerted_at: string | null;
  status?: string | null;
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
    registration_evidence: null,
    registration_alerted_at: null,
    ...over,
  };
}

function makeEnv(rows: StoredRow[]): { env: Env; store: Map<string, StoredRow>; writes: string[] } {
  // The SELECT snapshots the rows, exactly as D1 does — later UPDATEs
  // mutate the store, never the snapshot the loop is iterating.
  const snapshot = rows.map((r) => ({ ...r }));
  const store = new Map(rows.map((r) => [r.id, r]));
  // Every statement `.run()` executed, verbatim — the "no ai_assessment
  // write" assertions read this rather than trusting the branches below.
  const writes: string[] = [];

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
          writes.push(sql);
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
            if (row && row.first_seen === null) {
              row.first_seen = NOW;
              row.registration_evidence = "observed";
            }
          } else if (sql.includes("SET registration_alerted_at = datetime('now')")) {
            // The new-registration alert's guarded claim (migration 0282):
            // 0 changes on an already-claimed row. Executed against real
            // SQLite in test/lookalike-nrd-matcher.test.ts.
            const [id] = args as [string];
            const row = store.get(id);
            if (row && row.registration_alerted_at === null) {
              row.registration_alerted_at = NOW;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          } else if (sql.includes("SET registration_alerted_at = NULL")) {
            const [id] = args as [string];
            const row = store.get(id);
            if (row) row.registration_alerted_at = null;
          } else if (sql.includes("SET threat_level = CASE")) {
            // The compositor's MONOTONIC persist. Bind order: newRank,
            // newLevel, id. Re-stated with the same caveat; the rank CASE
            // is executed against real SQLite in the sibling file.
            const [rank, level, id] = args as [number, string, string];
            const row = store.get(id);
            if (row) {
              const RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
              const stored = row.threat_level === null ? -1 : (RANK[row.threat_level] ?? 0);
              if (rank >= stored) row.threat_level = level;
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

  return { env: { DB } as unknown as Env, store, writes };
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

beforeEach(() => {
  vi.clearAllMocks();
  checkBIMISpy.mockResolvedValue(false);
  createAlertSpy.mockResolvedValue("alert_1");
  fetchSpy.mockResolvedValue(new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Part 1 — first contact is baseline establishment ─────────────

describe("checkLookalikeBatch — first contact (baseline_established_at IS NULL)", () => {
  it("resolving with NO signal: no alert, no first_seen", async () => {
    // The seeder-backlog shape: never looked at, registered years ago,
    // parked. Thousands of rows look exactly like this.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: false, hasWeb: true }));
    const { env, store } = makeEnv([makeRow()]);

    await checkLookalikeBatch(env);

    // THE queue control. Not a nicety: this is the branch that decides
    // whether the seeder backlog files thousands of alerts or zero.
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

  it("mail AND web together IS a signal: the rule lifts LOW to HIGH and alerts", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    const { env, store } = makeEnv([makeRow()]);

    await checkLookalikeBatch(env);

    // A fresh row's stored level is LOW (NULL -> LOW). The mail+web rule
    // lifts it straight to HIGH — NOT only from MEDIUM, which is the
    // silent-miss trap the old Haiku-era boost would be without the
    // model's MEDIUM seed. HIGH clears the floor.
    expect(aiRequests(), "the lookalike pass makes no model call").toEqual([]);
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
      checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", ...infra }));
      const { env } = makeEnv([makeRow()]);
      await checkLookalikeBatch(env);
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
    // alert.
    expect(row.baseline_established_at).toBe(NOW);
    expect(row.first_seen).toBeNull();
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

  it("a transition with neither mail nor web keeps the stored level and files ONE MEDIUM new-registration alert", async () => {
    // No rule fires (no mail+web, no BIMI, no web server to fetch), so
    // the level is the STORED one and stays below the HIGH floor. Before
    // 2026-10-05 that meant NO alert — the platform had no "newly
    // registered lookalike" notification at all. A confirmed (observed)
    // registration is now the second documented floor exemption: it files
    // at MEDIUM, and the row's level is NOT raised by it.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: false, hasWeb: false }));
    const { env, store } = makeEnv([makeRow({ ...observedAbsent, threat_level: "LOW" })]);

    const summary = await checkLookalikeBatch(env);

    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy.mock.calls[0]![1]).toMatchObject({
      alertType: "lookalike_domain_active",
      severity: "MEDIUM",
      title: "New lookalike domain registered: acm3.example",
      details: { new_registration: true, registration_evidence: "observed" },
    });
    expect(summary.registration_alerts).toBe(1);
    expect(store.get("l1")!.threat_level).toBe("LOW");
    // The transition is still RECORDED, with its evidence.
    expect(store.get("l1")!.first_seen).toBe(NOW);
    expect(store.get("l1")!.registration_evidence).toBe("observed");
    expect(store.get("l1")!.registration_alerted_at).toBe(NOW);
    // A below-floor registration alert is NOT linked: alert_id keeps
    // meaning "this row has its operational alert", so the page pass and
    // the mail+web pair path can still raise the HIGH one later.
    expect(store.get("l1")!.alert_id).toBeNull();
  });

  it("does not re-stamp baseline_established_at on a later check", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
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

  it("an MX appearance that COMPLETES mail+web lifts LOW to HIGH and alerts, once", async () => {
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
    // Stored LOW + the mail-and-web rule = HIGH. No model involved.
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
    // No web -> the mail+web rule does not fire; the stored level holds.
    expect(row.threat_level).toBe("LOW");
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
    // Stored at HIGH so the one-time mail+web catch-up (which reads the
    // same EFFECTIVE state) has nothing to do — this test is about the
    // transition classifier only; the catch-up has its own tests below.
    const { env, store } = makeEnv([makeRow({ ...webOnly, has_mx: 1, threat_level: "HIGH" })]);

    const summary = await checkLookalikeBatch(env);

    // Stored values preserved...
    expect(store.get("l1")!.has_mx).toBe(1);
    expect(store.get("l1")!.has_web).toBe(1);
    // ...and no loss reported.
    expect(summary.mail_or_web_lost).toBe(0);
    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("measures the mail+web share of the registered rows it observed", async () => {
    // Nothing used to record this ratio — the only number available was
    // a one-off manual query (26 of 42 registered rows, 62%).
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

// ─── Part 2b — the rule table (AI_STRATEGY_2026-10 Phase 1 #18) ────

describe("composeRuleLevel — the pure rule table", () => {
  const none = { hasMx: false, hasWeb: false, bimiKnown: false };

  it("rule 1: mail+web lifts LOW to HIGH — not only MEDIUM", () => {
    // The silent-miss trap: the Haiku-era boost was MEDIUM-only, and a
    // fresh row's stored level is LOW.
    expect(composeRuleLevel("LOW", { ...none, hasMx: true, hasWeb: true })).toBe("HIGH");
    expect(composeRuleLevel("MEDIUM", { ...none, hasMx: true, hasWeb: true })).toBe("HIGH");
  });

  it("mail alone or web alone keeps the stored level", () => {
    expect(composeRuleLevel("LOW", { ...none, hasMx: true })).toBe("LOW");
    expect(composeRuleLevel("LOW", { ...none, hasWeb: true })).toBe("LOW");
    expect(composeRuleLevel("MEDIUM", { ...none, hasWeb: true })).toBe("MEDIUM");
  });

  it("rule 2: a known BIMI record lifts to HIGH", () => {
    expect(composeRuleLevel("LOW", { ...none, bimiKnown: true })).toBe("HIGH");
  });

  it("only RAISES — a CRITICAL is never lowered by either rule", () => {
    expect(composeRuleLevel("CRITICAL", { hasMx: true, hasWeb: true, bimiKnown: true })).toBe("CRITICAL");
    expect(composeRuleLevel("HIGH", none)).toBe("HIGH");
  });
});

describe("checkLookalikeBatch — rule-composed level, no AI", () => {
  /**
   * A row a retired Haiku verdict held at LOW, with mail AND web present.
   * Under the Haiku veto this stayed LOW forever; under the rule table it
   * is an operational squat and composes to HIGH.
   */
  const formerlyVetoed = {
    last_checked: "2026-09-01 00:00:00",
    baseline_established_at: "2026-09-01 00:00:00",
    registered: 1,
    resolves_to: "5.6.7.8",
    has_mx: 1,
    has_web: 1,
    threat_level: "LOW",
    ai_assessment: "benign fan site",
  };

  it("mail+web lifts a stored LOW to HIGH on a transition, and alerts", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    // A fresh MX appearance completes the pair.
    const { env, store } = makeEnv([makeRow({ ...formerlyVetoed, has_mx: 0 })]);

    await checkLookalikeBatch(env);

    const row = store.get("l1")!;
    expect(row.threat_level).toBe("HIGH");
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy.mock.calls[0]![1]).toMatchObject({
      alertType: "lookalike_domain_active",
      severity: "HIGH",
      // The historical note is carried onto the alert, never rewritten.
      aiAssessment: "benign fan site",
    });
    expect(row.ai_assessment).toBe("benign fan site");
  });

  it("no web keeps the stored level (MX gained alone)", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: false }));
    const { env, store } = makeEnv([makeRow({ ...formerlyVetoed, has_mx: 0, has_web: 0, threat_level: "MEDIUM" })]);

    await checkLookalikeBatch(env);

    expect(store.get("l1")!.threat_level).toBe("MEDIUM");
    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("the BIMI boost NEVER lowers a CRITICAL a page verdict established", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    checkBIMISpy.mockResolvedValue(true);
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([
      makeRow({ ...formerlyVetoed, has_mx: 0, threat_level: "CRITICAL" }),
    ]);

    await checkLookalikeBatch(env);

    expect(store.get("l1")!.threat_level).toBe("CRITICAL");
  });

  describe("rule 3 — the page verdict still applies on top", () => {
    /** Web-only (no MX) so rule 1 cannot be what set the level. */
    const webOnlyGain = {
      last_checked: "2026-09-01 00:00:00",
      baseline_established_at: "2026-09-01 00:00:00",
      registered: 0,
      threat_level: "LOW",
    };
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["credential harvest -> CRITICAL", { score: 95, credentialHarvest: true, signals: ["credential_form_off_domain"] }, "CRITICAL"],
      ["score >= 60 -> HIGH", { score: 65, credentialHarvest: false, signals: [] }, "HIGH"],
      ["score >= 30 -> MEDIUM", { score: 35, credentialHarvest: false, signals: [] }, "MEDIUM"],
      ["bare anti-bot wall -> MEDIUM", { score: 0, credentialHarvest: false, signals: ["anti_bot_wall"] }, "MEDIUM"],
      // Lane 3 shadow output must NOT feed the level: a large shadow
      // delta and fired AI-build keys on a low-score page stay LOW.
      ["Lane 3 shadow signals do not move it", {
        score: 10, credentialHarvest: false, signals: [],
        aiSignals: ["ai_build_lovable_badge", "exfil_telegram_bot"], scoreDelta: 40,
      }, "LOW"],
    ];
    for (const [name, phishing, expected] of cases) {
      it(name, async () => {
        checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: false, hasWeb: true }));
        pageAnalysisSpy.mockResolvedValue({ result: { ok: true }, phishing });
        const { env, store } = makeEnv([makeRow(webOnlyGain)]);

        await checkLookalikeBatch(env);

        expect(store.get("l1")!.threat_level).toBe(expected);
      });
    }

    it("a page verdict lifts a mail+web HIGH further to CRITICAL", async () => {
      checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
      pageAnalysisSpy.mockResolvedValue({
        result: { ok: true },
        phishing: { score: 95, credentialHarvest: true, signals: ["credential_form_off_domain"] },
      });
      const { env, store } = makeEnv([makeRow({ ...formerlyVetoed, has_mx: 0 })]);

      await checkLookalikeBatch(env);

      expect(store.get("l1")!.threat_level).toBe("CRITICAL");
    });
  });

  it("writes NO ai_assessment and touches NO ai_claimed_at, on any path", async () => {
    // One row per compositor entry point: first contact, registration
    // gained, an mx gain completing the pair, and the none-path catch-up.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    checkBIMISpy.mockResolvedValue(true);
    pageAnalysisSpy.mockResolvedValue({
      result: { ok: true },
      phishing: { score: 95, credentialHarvest: true, signals: ["credential_form_off_domain"] },
    });
    const { env, store, writes } = makeEnv([
      makeRow({ id: "fc", domain: "fc.example" }),
      makeRow({ id: "rg", domain: "rg.example", baseline_established_at: "2026-09-01 00:00:00" }),
      makeRow({ id: "mx", domain: "mx.example", ...formerlyVetoed, has_mx: 0, ai_assessment: null }),
      makeRow({ id: "cu", domain: "cu.example", ...formerlyVetoed, ai_assessment: null }),
    ]);

    const summary = await checkLookalikeBatch(env);

    expect(summary.row_errors).toBe(0);
    expect(writes.filter((w) => w.includes("ai_assessment"))).toEqual([]);
    expect(writes.filter((w) => w.includes("ai_claimed_at"))).toEqual([]);
    for (const id of ["fc", "rg", "mx", "cu"]) {
      expect(store.get(id)!.ai_assessment, id).toBeNull();
      expect(store.get(id)!.ai_claimed_at, id).toBeNull();
    }
  });

  it("makes ZERO calls to the Anthropic API from the lookalike pass", async () => {
    // `lib/haiku` is NOT mocked in this file and `fetch` is stubbed, so a
    // model call reintroduced anywhere on this path would surface here.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const rows = Array.from({ length: 12 }, (_, i) => makeRow({
      id: `l${i}`,
      domain: `acm3-${i}.example`,
      // Alternate first contact and re-check so both cohorts are driven.
      ...(i % 2 === 0 ? {} : { ...formerlyVetoed, has_mx: 0, ai_assessment: null }),
    }));
    const { env, store } = makeEnv(rows);

    await checkLookalikeBatch(env);

    expect(aiRequests()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The runtime check above cannot see a call that dies before `fetch`
    // (this mock env carries no API key and no ledger tables), so pin the
    // import graph too: the scanner must not reach the model wrappers.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/scanners/lookalike-domains.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from ['"]\.\.\/lib\/(haiku|anthropic)['"]/);
    expect(src).not.toMatch(/analyzeWithHaiku|callAnthropic/);
    // ...and with no per-run AI cap, EVERY operational row is levelled —
    // the old Haiku cap used to defer all but the first few.
    for (const r of rows) expect(store.get(r.id)!.threat_level, r.id).toBe("HIGH");
  });

  describe("the one-time none-path catch-up", () => {
    it("lifts a stable mail+web row stored below HIGH and alerts ONCE", async () => {
      // No transition at all — the effective state matches the stored
      // one. This is the 90-row prod population the Haiku veto held down.
      checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
      pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
      const { env, store } = makeEnv([makeRow(formerlyVetoed)]);

      const first = await checkLookalikeBatch(env);

      expect(first.mail_web_level_lifts).toBe(1);
      expect(store.get("l1")!.threat_level).toBe("HIGH");
      expect(createAlertSpy).toHaveBeenCalledTimes(1);
      expect(store.get("l1")!.alert_id).toBe("alert_1");
      // Not a registration event.
      expect(store.get("l1")!.first_seen).toBeNull();

      // The NEXT reassessment of the now-HIGH row: no re-composite, no
      // second alert, no page fetch spent on it.
      vi.clearAllMocks();
      createAlertSpy.mockResolvedValue("alert_2");
      checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
      const again = makeEnv([{ ...store.get("l1")! }]);

      const second = await checkLookalikeBatch(again.env);

      expect(second.mail_web_level_lifts).toBe(0);
      expect(createAlertSpy).not.toHaveBeenCalled();
      expect(pageAnalysisSpy).not.toHaveBeenCalled();
      expect(again.store.get("l1")!.alert_id).toBe("alert_1");
    });

    it("lifts but does NOT alert a row that already carries an alert", async () => {
      checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
      pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
      const { env, store } = makeEnv([makeRow({ ...formerlyVetoed, alert_id: "alert_old" })]);

      await checkLookalikeBatch(env);

      expect(store.get("l1")!.threat_level).toBe("HIGH");
      expect(createAlertSpy).not.toHaveBeenCalled();
      expect(store.get("l1")!.alert_id).toBe("alert_old");
    });

    it("uses the EFFECTIVE state: unanswered probes carry the stored mail+web", async () => {
      checkDomainSpy.mockResolvedValue(dnsAnswer({
        registered: true, resolved: true, ip: "5.6.7.8",
        hasMx: false, mxAnswered: false, hasWeb: false, webAnswered: false,
      }));
      pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
      const { env, store } = makeEnv([makeRow(formerlyVetoed)]);

      await checkLookalikeBatch(env);

      expect(store.get("l1")!.threat_level).toBe("HIGH");
    });

    it("does nothing for a stable row without both mail and web", async () => {
      checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: false, hasWeb: true }));
      const { env, store } = makeEnv([makeRow({ ...formerlyVetoed, has_mx: 0 })]);

      const summary = await checkLookalikeBatch(env);

      expect(summary.mail_web_level_lifts).toBe(0);
      expect(store.get("l1")!.threat_level).toBe("LOW");
      expect(createAlertSpy).not.toHaveBeenCalled();
      expect(pageAnalysisSpy).not.toHaveBeenCalled();
    });
  });
});

// ─── Part 3 — the severity floor, in the checker ──────────────────

describe("checkLookalikeBatch — HIGH/CRITICAL severity floor", () => {
  const observed = {
    last_checked: "2026-09-01 00:00:00",
    baseline_established_at: "2026-09-01 00:00:00",
  };

  it("a genuine transition below the floor files MEDIUM (the new-registration exemption), and persists everything else", async () => {
    // TWO BEHAVIOUR CHANGES, in order. The floor (2026-09) stopped this
    // producing a LOW alert no triage rule could clear. The
    // new-registration exemption (2026-10-05, owner decision) brings back
    // ONE alert for a CONFIRMED registration, at MEDIUM, bounded per
    // registration event — the floor still governs every other path.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: false, hasWeb: true }));
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    const { env, store } = makeEnv([makeRow(observed)]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy.mock.calls[0]![1]).toMatchObject({ severity: "MEDIUM" });
    const row = store.get("l1")!;
    // The data is the deliverable; the alert is the notification.
    expect(row.threat_level).toBe("LOW");
    expect(row.ai_assessment).toBeNull();
    expect(row.first_seen).toBe(NOW);
    // And critically: alert_id stays NULL, which is exactly the state
    // `analyzeLookalikePages`' own alert path keys on. A withheld row is
    // still reachable if its page later turns out to be phishing.
    expect(row.alert_id).toBeNull();
  });

  it("a stored MEDIUM carried into a re-entrant transition files at MEDIUM, not above", async () => {
    // The compositor's base is the STORED level, and a mail-only
    // transition cannot lift it (the mail+web rule needs both). The
    // registration alert carries that level — MEDIUM is a floor for the
    // finding, never a raise of the row.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: false }));
    const { env, store } = makeEnv([makeRow({
      ...observed, threat_level: "MEDIUM", ai_assessment: "assessed MEDIUM",
    })]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy.mock.calls[0]![1]).toMatchObject({ severity: "MEDIUM" });
    expect(store.get("l1")!.threat_level).toBe("MEDIUM");
    expect(store.get("l1")!.alert_id).toBeNull();
  });

  it("lets CRITICAL through", async () => {
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: true }));
    pageAnalysisSpy.mockResolvedValue({
      result: { ok: true },
      phishing: { score: 95, credentialHarvest: true, signals: ["credential_form_off_domain"] },
    });
    const { env, store } = makeEnv([makeRow(observed)]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy.mock.calls[0]![1]).toMatchObject({ severity: "CRITICAL" });
    expect(store.get("l1")!.alert_id).toBe("alert_1");
  });

  it("files the typosquat_bimi alert independently of the floor — and the BIMI boost clears it", async () => {
    // The floor is scoped to `lookalike_domain_active`, and an early
    // return on it would have swallowed a fixed-HIGH alert about the
    // single most damning email signal this scanner finds. That is the
    // property being pinned, and it still holds: `typosquat_bimi` is
    // filed BEFORE the floor is consulted.
    //
    // A BIMI-publishing row is raised to HIGH (see `composeRuleLevel`),
    // so it clears the floor and the primary alert lands too. MX ONLY,
    // no web, so the mail+web rule cannot be what lifted it. The ORDER is
    // the assertion that matters: BIMI first, from the lane that runs
    // ahead of the compositor.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: false }));
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

  it("BIMI absent, MX only: the registration files at MEDIUM and the level stays LOW", async () => {
    // Isolated from the BIMI boost: mail with no web and no BIMI record
    // composes to the stored LOW. The confirmed registration still files
    // its one MEDIUM alert; the row's level and alert_id are untouched.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: false }));
    checkBIMISpy.mockResolvedValue(false);
    const { env, store } = makeEnv([makeRow(observed)]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy.mock.calls[0]![1]).toMatchObject({ severity: "MEDIUM" });
    expect(store.get("l1")!.threat_level).toBe("LOW");
    expect(store.get("l1")!.alert_id).toBeNull();
  });

  it("the floor still withholds every NON-registration path below HIGH", async () => {
    // An mx gain on an already-registered, baselined row is not a
    // registration. With no web it cannot complete the mail+web pair, so
    // nothing alerts — the exemption is scoped to confirmed registrations.
    checkDomainSpy.mockResolvedValue(dnsAnswer({ registered: true, resolved: true, ip: "5.6.7.8", hasMx: true, hasWeb: false }));
    const { env } = makeEnv([makeRow({ ...observed, registered: 1, has_mx: 0, has_web: 0 })]);

    const summary = await checkLookalikeBatch(env);

    expect(summary.mx_gained).toBe(1);
    expect(createAlertSpy).not.toHaveBeenCalled();
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
