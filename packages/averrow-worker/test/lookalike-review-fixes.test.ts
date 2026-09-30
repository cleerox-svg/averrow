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

const { checkLookalikeBatch } = await import("../src/scanners/lookalike-domains");
const { handleScanLookalikes } = await import("../src/handlers/lookalikeDomains");

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
    ai_assessment TEXT,
    alert_id TEXT,
    status TEXT DEFAULT 'monitoring',
    takedown_id TEXT,
    unicode_domain TEXT,
    page_fetched_at TEXT,
    page_http_status INTEGER,
    page_phishing_score INTEGER,
    page_signals TEXT,
    page_content_hash TEXT,
    page_anti_bot_wall TEXT,
    page_ai_signals TEXT,
    page_score_delta INTEGER,
    page_generator TEXT,
    page_exfil_sink TEXT,
    page_exfil_sink_id TEXT,
    page_evidence TEXT,
    page_last_outcome TEXT,
    baseline_established_at TEXT,
    last_check_failed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_lookalike_brand_domain ON lookalike_domains(brand_id, domain);
  CREATE INDEX idx_lookalike_last_checked ON lookalike_domains(last_checked);
  CREATE TABLE brands (
    id TEXT PRIMARY KEY,
    name TEXT,
    canonical_domain TEXT,
    tier TEXT
  );
`;

interface Harness {
  env: Env;
  /** Insert a candidate row; returns its id. */
  seed(over?: Record<string, unknown>): string;
  row(id: string): Record<string, unknown>;
  /** Domains handed to `checkDomain` this run, in call order. */
  checked(): string[];
}

function harness(): Harness {
  const db = new DatabaseSync!(":memory:");
  db.exec(DDL);
  db.prepare(
    `INSERT INTO brands (id, name, canonical_domain, tier)
     VALUES ('b1', 'Acme', 'acme.example', 'monitored')`,
  ).run();

  const DB = {
    prepare(sql: string) {
      const wrap = (params: unknown[]) => ({
        async all<T>() {
          return { results: db.prepare(sql).all(...params) as T[], meta: {} };
        },
        async first<T>() {
          return (db.prepare(sql).get(...params) ?? null) as T | null;
        },
        async run() {
          return { meta: { changes: db.prepare(sql).run(...params).changes } };
        },
      });
      return { ...wrap([]), bind: (...p: unknown[]) => wrap(p) };
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
  };
}

/** A resolved DNS answer. `resolved: true` means "this IS an observation". */
function answer(over: Partial<{ registered: boolean; ip: string; hasMx: boolean; hasWeb: boolean }> = {}) {
  return { registered: false, resolved: true, hasMx: false, hasWeb: false, ...over };
}

/** A FAILED check — a timeout or non-ok DoH response. Not an observation. */
const NO_ANSWER = { registered: false, resolved: false, hasMx: false, hasWeb: false };

function haikuSays(level: string) {
  return {
    success: true,
    data: { response: "", structured: { threat_level: level, assessment: `assessed ${level}` } },
  };
}

const STALE = "2026-09-01 00:00:00";

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
    const recheckIds = Array.from({ length: 40 }, () => h.seed({ last_checked: STALE }));

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
    const recheckIds = Array.from({ length: 5 }, () => h.seed({ last_checked: STALE }));

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
    const recheckIds = Array.from({ length: 80 }, () => h.seed({ last_checked: STALE }));

    await checkLookalikeBatch(h.env);

    const c = cohorts(h, [], recheckIds);
    expect(c.total).toBe(50);
    expect(c.recheck).toBe(50);
  });

  it("never exceeds the per-run total even when BOTH cohorts are oversupplied", async () => {
    const h = harness();
    checkDomainSpy.mockResolvedValue(answer());
    const firstIds = Array.from({ length: 200 }, () => h.seed());
    const recheckIds = Array.from({ length: 200 }, () => h.seed({ last_checked: STALE }));

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
      h.seed({ last_checked: `2026-08-${String(i + 1).padStart(2, "0")} 00:00:00` }),
    );
    Array.from({ length: 60 }, () => h.seed());

    await checkLookalikeBatch(h.env);

    const checkedDomains = new Set(h.checked());
    const staleTwenty = recheckIds.slice(0, 20).map((id) => h.row(id).domain as string);
    for (const d of staleTwenty) expect(checkedDomains, d).toContain(d);
  });
});

// ═══════════════════════════════════════════════════════════════════
// B2 — "Scan now" must not forge first contact
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("handleScanLookalikes — the rescan reset path", () => {
  const ctx = { userId: "u1", orgId: null, role: "super_admin" } as unknown as AuthContext;
  const req = () => new Request("https://averrow.test/api/lookalikes/b1/scan", { method: "POST" });

  it("a genuine registration on a RESCANNED brand is still a registration, not a baseline", async () => {
    // Before the fix the handler wrote `last_checked = NULL`, so
    // `firstContact` came back true for a row we had observed as
    // unregistered the day before. The 0 -> 1 that followed was
    // reclassified as BASELINE: no `first_seen`, no Haiku, no alert
    // unless MX and web happened to coincide — and
    // `baseline_established_at` was re-stamped, contradicting both the
    // scanner's own comment and migration 0267.
    const h = harness();
    const id = h.seed({
      registered: 0,
      last_checked: "2026-09-29 12:00:00",
      baseline_established_at: "2026-06-01 00:00:00",
    });
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "5.6.7.8" }));
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
    expect(row.last_checked).not.toBeNull();
  });

  it("leaves a never-checked row at first contact — the mirror-image bug", async () => {
    // The stale stamp must NOT be written over a NULL. Doing so would
    // demote a real first contact to a fake re-check, which is the one
    // state that CAN mint a false `first_seen` for a years-old squat.
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

  it("reports the brand's rows as queued and clears their failure cooldown", async () => {
    const h = harness();
    h.seed({ last_checked: "2026-09-29 12:00:00", last_check_failed_at: "2026-09-30 11:00:00" });
    h.seed({ last_check_failed_at: "2026-09-30 11:00:00" });
    checkDomainSpy.mockResolvedValue(answer());

    const res = await handleScanLookalikes(req(), h.env, "b1", ctx);
    const body = await res.json() as { data: { domains_queued: number } };
    expect(body.data.domains_queued).toBe(2);
    // Both were checked in the same call — an operator asking for a scan
    // should not wait out a DNS-failure cooldown.
    expect(h.checked().length).toBe(2);
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

    // ── Tick 2: the resolver recovers. Expire the failure cooldown so
    // the row is due (the cooldown is what stops a dead resolver from
    // head-of-line blocking the batch every tick).
    await h.env.DB.prepare(
      `UPDATE lookalike_domains SET last_check_failed_at = datetime('now', '-25 hours') WHERE id = ?`,
    ).bind(id).run();
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

    await h.env.DB.prepare(
      `UPDATE lookalike_domains SET last_check_failed_at = datetime('now', '-25 hours') WHERE id = ?`,
    ).bind(id).run();
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

  it("a cooling-down row is not re-selected, so a dead resolver cannot block the batch", async () => {
    const h = harness();
    const dead = h.seed({ last_checked: STALE });
    const live = h.seed({ last_checked: STALE });

    checkDomainSpy.mockResolvedValue(NO_ANSWER);
    await checkLookalikeBatch(h.env);
    expect(h.checked().length).toBe(2);

    vi.clearAllMocks();
    checkDomainSpy.mockResolvedValue(answer());
    await checkLookalikeBatch(h.env);
    // Both are inside the 24h failure cooldown now.
    expect(h.checked()).not.toContain(h.row(dead).domain);
    expect(h.checked()).not.toContain(h.row(live).domain);
    expect(h.checked().length).toBe(0);
  });
});
