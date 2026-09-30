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

const { checkLookalikeBatch } = await import("../src/scanners/lookalike-domains");

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
  baseline_established_at: string | null;
  threat_level: string | null;
  ai_assessment: string | null;
  alert_id: string | null;
  resolves_to: string | null;
  has_mx: number | null;
  has_web: number | null;
}

const NOW = "MOCK_NOW";

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
    threat_level: null,
    ai_assessment: null,
    alert_id: null,
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
        async run() {
          if (sql.includes("SET registered = ?")) {
            // The per-check UPDATE. Bind order:
            // registered, ip, hasMx, hasWeb, firstContactFlag, id.
            const [registered, ip, hasMx, hasWeb, firstContact, id] = args as [
              number, string | null, number, number, number, string,
            ];
            const row = store.get(id);
            if (row) {
              row.registered = registered;
              row.resolves_to = ip;
              row.has_mx = hasMx;
              row.has_web = hasWeb;
              row.last_checked = NOW;
              // `CASE WHEN ? = 1 THEN datetime('now') ELSE <self> END` —
              // never re-stamped on a later check.
              if (firstContact === 1) row.baseline_established_at = NOW;
            }
          } else if (sql.includes("SET first_seen = datetime('now')")) {
            const [id] = args as [string];
            const row = store.get(id);
            // `WHERE id = ? AND first_seen IS NULL`
            if (row && row.first_seen === null) row.first_seen = NOW;
          } else if (sql.includes("SET threat_level = ?")) {
            const [level, assessment, id] = args as [string, string, string];
            const row = store.get(id);
            if (row) {
              row.threat_level = level;
              row.ai_assessment = assessment;
            }
          } else if (sql.includes("SET alert_id = ?")) {
            const [alertId, id] = args as [string, string];
            const row = store.get(id);
            if (row) row.alert_id = alertId;
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

describe("checkLookalikeBatch — first contact (last_checked IS NULL)", () => {
  it("resolving with NO signal: no Haiku call, no alert, no first_seen", async () => {
    // The seeder-backlog shape: never checked, registered years ago,
    // parked. 1,080-3,770 rows look exactly like this.
    checkDomainSpy.mockResolvedValue({ registered: true, ip: "5.6.7.8", hasMx: false, hasWeb: true });
    const { env, store } = makeEnv([makeRow()]);

    await checkLookalikeBatch(env);

    // THE cost control. Not a nicety: this is the branch that decides
    // whether the seeder backlog costs ~3,700 Haiku calls or zero.
    expect(analyzeWithHaikuSpy).not.toHaveBeenCalled();
    expect(createAlertSpy).not.toHaveBeenCalled();
    // ...and no inline page fetch either — the other budget this path
    // would otherwise starve.
    expect(pageAnalysisSpy).not.toHaveBeenCalled();

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
  });

  it("mail AND web together IS a signal: full assessment runs and alerts", async () => {
    checkDomainSpy.mockResolvedValue({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true });
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
      checkDomainSpy.mockResolvedValue({ registered: true, ip: "5.6.7.8", ...infra });
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
    checkDomainSpy.mockResolvedValue({ registered: false, hasMx: false, hasWeb: false });
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

describe("checkLookalikeBatch — the first-contact boundary is last_checked, not registered", () => {
  const observedAbsent = { last_checked: "2026-09-01 00:00:00", registered: 0 };

  it("a row we HAVE checked before takes the transition path, signal or not", async () => {
    // Identical DNS result to the suppressed case above — no MX, web
    // only. The ONLY difference is that `last_checked` is non-NULL, and
    // that is enough to make this a transition we witnessed.
    checkDomainSpy.mockResolvedValue({ registered: true, ip: "5.6.7.8", hasMx: false, hasWeb: true });
    pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("HIGH"));
    const { env, store } = makeEnv([makeRow(observedAbsent)]);

    await checkLookalikeBatch(env);

    // Haiku runs: a domain that appeared while we were watching is a
    // real event and worth a token.
    expect(analyzeWithHaikuSpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    const row = store.get("l1")!;
    // first_seen stamped — this is the transition case...
    expect(row.first_seen).toBe(NOW);
    // ...and the baseline column stays NULL: it is not first contact,
    // and the CASE in the per-check UPDATE must not re-stamp it.
    expect(row.baseline_established_at).toBeNull();
  });

  it("does not re-stamp baseline_established_at on a later check", async () => {
    checkDomainSpy.mockResolvedValue({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true });
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
    checkDomainSpy.mockResolvedValue({ registered: true, ip: "9.9.9.9", hasMx: true, hasWeb: true });
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

// ─── Part 3 — the severity floor, in the checker ──────────────────

describe("checkLookalikeBatch — HIGH/CRITICAL severity floor", () => {
  it("withholds a MEDIUM alert on a genuine transition, but persists everything else", async () => {
    // THE BEHAVIOUR CHANGE. Before the floor this produced a MEDIUM
    // `lookalike_domain_active` alert that no triage rule could ever
    // clear. It now produces a fully-populated row and no alert.
    checkDomainSpy.mockResolvedValue({ registered: true, ip: "5.6.7.8", hasMx: false, hasWeb: false });
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("MEDIUM"));
    const { env, store } = makeEnv([makeRow({ last_checked: "2026-09-01 00:00:00" })]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).not.toHaveBeenCalled();
    const row = store.get("l1")!;
    // The data is the deliverable; the alert is the notification.
    expect(row.threat_level).toBe("MEDIUM");
    expect(row.ai_assessment).toBe("assessed MEDIUM");
    expect(row.first_seen).toBe(NOW);
    // And critically: alert_id stays NULL, which is exactly the state
    // `analyzeLookalikePages`' own alert path keys on. A withheld row is
    // still reachable if its page later turns out to be phishing.
    expect(row.alert_id).toBeNull();
  });

  it("withholds LOW too", async () => {
    checkDomainSpy.mockResolvedValue({ registered: true, ip: "5.6.7.8", hasMx: false, hasWeb: false });
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("LOW"));
    const { env, store } = makeEnv([makeRow({ last_checked: "2026-09-01 00:00:00" })]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(store.get("l1")!.threat_level).toBe("LOW");
  });

  it("lets CRITICAL through", async () => {
    checkDomainSpy.mockResolvedValue({ registered: true, ip: "5.6.7.8", hasMx: false, hasWeb: false });
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("CRITICAL"));
    const { env, store } = makeEnv([makeRow({ last_checked: "2026-09-01 00:00:00" })]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(store.get("l1")!.alert_id).toBe("alert_1");
  });

  it("still files the typosquat_bimi alert when the floor withholds the main one", async () => {
    // The floor is scoped to `lookalike_domain_active`. A LOW-assessed
    // row does NOT get the BIMI boost (that boost is MEDIUM-only), so an
    // early return on the floor would have swallowed a fixed-HIGH alert
    // about the single most damning email signal this scanner finds.
    checkDomainSpy.mockResolvedValue({ registered: true, ip: "5.6.7.8", hasMx: false, hasWeb: false });
    analyzeWithHaikuSpy.mockResolvedValue(haikuSays("LOW"));
    checkBIMISpy.mockResolvedValue(true);
    const { env, store } = makeEnv([makeRow({ last_checked: "2026-09-01 00:00:00" })]);

    await checkLookalikeBatch(env);

    const types = createAlertSpy.mock.calls.map((c) => (c[1] as { alertType: string }).alertType);
    expect(types).toEqual(["typosquat_bimi"]);
    // The BIMI alert is NOT linked as the row's alert_id (it never was),
    // so the page path can still raise the primary alert later.
    expect(store.get("l1")!.alert_id).toBeNull();
  });

  it("does not write alert_id when createAlert declines (NX2 tier gate)", async () => {
    // `createAlert` returns null for tier='tracked'. The link UPDATE is
    // now guarded on a non-null id, so the column stays NULL rather than
    // being overwritten with one — which is what makes "alert_id IS NULL"
    // a trustworthy precondition for the page-analysis producer.
    checkDomainSpy.mockResolvedValue({ registered: true, ip: "5.6.7.8", hasMx: true, hasWeb: true });
    createAlertSpy.mockResolvedValue(null);
    const { env, store } = makeEnv([makeRow({ last_checked: "2026-09-01 00:00:00" })]);

    await checkLookalikeBatch(env);

    expect(createAlertSpy).toHaveBeenCalled();
    expect(store.get("l1")!.alert_id).toBeNull();
  });
});
