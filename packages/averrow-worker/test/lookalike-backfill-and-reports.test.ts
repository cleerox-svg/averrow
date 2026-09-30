/**
 * The THIRD `lookalike_domain_active` producer, and the two "newly
 * registered" readings that were measuring our own crawl schedule.
 *
 *   F4 — `lib/alert-backfill.ts` files this alert type on brand claim. It
 *        did so at a hardcoded `medium`, with no `registered` filter, up
 *        to 100 rows, and `bypassTierGate: true` — straight past the
 *        HIGH floor both scanner paths respect. The policy module's
 *        docstring said "ONE definition, imported by BOTH producers";
 *        there are three.
 *   F5 — `observer.ts`'s daily-briefing list and `narrator.ts`'s two
 *        7-day lookalike counts keyed on `created_at`, i.e. when the
 *        SEEDER inserted the row. At ~300 inserts/tick that is a
 *        measure of our crawl cadence wearing the label "newly
 *        registered" — the same conflation migration 0267 exists to
 *        prevent, one layer out. `first_seen` is the honest predicate
 *        and now exists.
 *
 * Both lanes run against real SQLite: F4 through a thin D1 shim so the
 * real query does the filtering, F5 by EXECUTING the agents' extracted
 * SQL against a fixture that contains one row of every shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";

const { createAlertSpy } = vi.hoisted(() => ({ createAlertSpy: vi.fn() }));
vi.mock("../src/lib/alerts", () => ({ createAlert: createAlertSpy }));

const { backfillAlertsForBrand } = await import("../src/lib/alert-backfill");

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

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** Every source table the backfill touches, so no source errors. */
const DDL = `
  CREATE TABLE lookalike_domains (
    id TEXT PRIMARY KEY, brand_id TEXT, domain TEXT, permutation_type TEXT,
    registered INTEGER DEFAULT 0, threat_level TEXT, first_seen TEXT,
    last_checked TEXT, has_content INTEGER, mx_records TEXT, dns_active INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT, canonical_domain TEXT, tier TEXT);
  CREATE TABLE org_brands (org_id TEXT, brand_id TEXT);
  CREATE TABLE org_members (org_id TEXT, user_id TEXT, role TEXT, created_at TEXT);
  CREATE TABLE alerts (
    id TEXT PRIMARY KEY, brand_id TEXT, source_type TEXT, source_id TEXT, alert_type TEXT
  );
  CREATE TABLE threats (
    id TEXT PRIMARY KEY, target_brand_id TEXT, threat_type TEXT, severity TEXT,
    source_feed TEXT, indicator TEXT, status TEXT, created_at TEXT
  );
  CREATE TABLE ct_certificates (
    id TEXT PRIMARY KEY, brand_id TEXT, common_name TEXT, issuer_name TEXT,
    not_before TEXT, suspicious INTEGER, domain TEXT, issuer TEXT, san_count INTEGER
  );
  CREATE TABLE social_profiles (
    id TEXT PRIMARY KEY, brand_id TEXT, platform TEXT, handle TEXT,
    classification TEXT, classification_confidence REAL, classified_at TEXT
  );
  -- brand_id / status / classification / last_checked are the narrator
  -- signal-gate's spelling; matched_brand_id / impersonation_verdict are
  -- the backfill's. Both live on the real table.
  CREATE TABLE app_store_listings (
    id TEXT PRIMARY KEY, matched_brand_id TEXT, brand_id TEXT, store TEXT, app_name TEXT,
    developer_name TEXT, first_seen TEXT, impersonation_verdict TEXT,
    status TEXT, classification TEXT, last_checked TEXT
  );
  CREATE TABLE dark_web_mentions (
    id TEXT PRIMARY KEY, brand_id TEXT, source TEXT, severity TEXT,
    snippet TEXT, observed_at TEXT,
    status TEXT, classification TEXT, first_seen TEXT, last_seen TEXT
  );
  CREATE TABLE spam_trap_captures (
    id TEXT PRIMARY KEY, spoofed_brand_id TEXT, from_address TEXT,
    spoofed_domain TEXT, severity TEXT, captured_at TEXT
  );
`;

function shim(db: InstanceType<SqliteCtor>): Env {
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
  return { DB } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  createAlertSpy.mockResolvedValue("alert_1");
});

// ═══════════════════════════════════════════════════════════════════
// F4 — the claim-time backfill goes through the policy
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("backfillAlertsForBrand — lookalike_domain_active", () => {
  function setup(rows: Array<Partial<{ id: string; registered: number; threat_level: string | null }>>) {
    const db = new DatabaseSync!(":memory:");
    db.exec(DDL);
    db.prepare(`INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b1','Acme','acme.example','customer')`).run();
    db.prepare(`INSERT INTO org_brands (org_id, brand_id) VALUES ('o1','b1')`).run();
    db.prepare(`INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('o1','u1','owner','2026-01-01')`).run();
    let n = 0;
    for (const r of rows) {
      n += 1;
      db.prepare(
        `INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type, registered, threat_level, created_at)
         VALUES (?, 'b1', ?, 'replacement', ?, ?, datetime('now', '-1 day'))`,
      ).run(r.id ?? `l${n}`, `acm3-${n}.example`, r.registered ?? 1, (r.threat_level ?? null) as null);
    }
    return { db, env: shim(db) };
  }

  /** The `lookalike_domain_active` calls only. */
  function lookalikeAlerts() {
    return createAlertSpy.mock.calls
      .map((c) => c[1] as { alertType: string; severity: string; details: Record<string, unknown> })
      .filter((p) => p.alertType === "lookalike_domain_active");
  }

  it("does not file for UNREGISTERED domains", async () => {
    // The worst of it: with no `registered` filter, claiming a brand the
    // widened seeder had touched filed up to 100 MEDIUM alerts about
    // permutations that do not exist. A dnstwist candidate row is not a
    // finding.
    const { env } = setup([
      { registered: 0, threat_level: "CRITICAL" },
      { registered: 0, threat_level: "HIGH" },
    ]);
    const summary = await backfillAlertsForBrand(env, "b1", 90);
    expect(lookalikeAlerts()).toHaveLength(0);
    expect(summary.by_source.lookalike_scanner!.scanned).toBe(0);
  });

  it("respects the HIGH severity floor instead of filing everything at medium", async () => {
    const { env } = setup([
      { id: "lo", registered: 1, threat_level: "LOW" },
      { id: "med", registered: 1, threat_level: "MEDIUM" },
      { id: "none", registered: 1, threat_level: null },
      { id: "hi", registered: 1, threat_level: "HIGH" },
      { id: "crit", registered: 1, threat_level: "CRITICAL" },
    ]);
    const summary = await backfillAlertsForBrand(env, "b1", 90);

    const filed = lookalikeAlerts();
    expect(filed).toHaveLength(2);
    // Severity is the row's ALREADY-COMPOSITED threat_level, not a
    // constant and not a fresh judgement — so the backfill files exactly
    // what the live producers would have filed, which is the premise of
    // claim-time backfill in the first place.
    expect(filed.map((p) => p.severity).sort()).toEqual(["critical", "high"]);
    // The three below the floor are withheld, not errored.
    expect(summary.by_source.lookalike_scanner!.scanned).toBe(5);
    expect(summary.by_source.lookalike_scanner!.created).toBe(2);
    expect(summary.by_source.lookalike_scanner!.skipped).toBe(3);
    expect(summary.by_source.lookalike_scanner!.errors).toBe(0);
  });

  it("marks its output as the backfill producer, so the three are separable", async () => {
    const { env } = setup([{ registered: 1, threat_level: "HIGH" }]);
    await backfillAlertsForBrand(env, "b1", 90);
    const filed = lookalikeAlerts();
    expect(filed[0]!.details.discovered_by).toBe("claim_backfill");
    expect(filed[0]!.details.threat_level).toBe("HIGH");
  });

  it("is still idempotent — a second run files nothing", async () => {
    const { db, env } = setup([{ id: "hi", registered: 1, threat_level: "HIGH" }]);
    await backfillAlertsForBrand(env, "b1", 90);
    expect(lookalikeAlerts()).toHaveLength(1);
    // The dedupe key the helper checks.
    db.prepare(
      `INSERT INTO alerts (id, brand_id, source_type, source_id, alert_type)
       VALUES ('a1','b1','lookalike_scanner','hi','lookalike_domain_active')`,
    ).run();
    vi.clearAllMocks();
    createAlertSpy.mockResolvedValue("alert_2");
    const summary = await backfillAlertsForBrand(env, "b1", 90);
    expect(lookalikeAlerts()).toHaveLength(0);
    expect(summary.by_source.lookalike_scanner!.skipped).toBe(1);
  });

  it("the module imports the shared floor rather than restating it", () => {
    // Lane 2 of the shared-constant pattern: a producer that re-derives
    // the comparison passes every behavioural test above and still
    // drifts the day the floor moves to CRITICAL. That is exactly how
    // this producer got here.
    const src = read("../src/lib/alert-backfill.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).toMatch(/import\s*\{[^}]*clearsLookalikeAlertFloor[^}]*\}\s*from\s*['"]\.\/lookalike-alert-policy['"]/);
    expect(src).toContain("clearsLookalikeAlertFloor(level)");
    // And the old hardcoded severity is gone from this alert family.
    expect(src).not.toMatch(/alertType:\s*'lookalike_domain_active',\s*severity:\s*'medium'/);
  });

  it("the policy docstring names all three producers", () => {
    const policy = read("../src/lib/lookalike-alert-policy.ts");
    for (const producer of [
      "scanners/lookalike-domains.ts",
      "scanners/lookalike-page-analysis.ts",
      "lib/alert-backfill.ts",
    ]) {
      expect(policy, producer).toContain(producer);
    }
    // The affirmative claim, asserted because the sentence it replaced
    // ("imported by BOTH producers") is the one a reader would trust.
    expect(policy).toContain("imported by ALL THREE producers");
  });
});

// ═══════════════════════════════════════════════════════════════════
// F5 — "newly registered" means observed to appear
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("the 'newly registered' readings key on first_seen", () => {
  const observerSrc = read("../src/agents/observer.ts");
  const narratorSrc = read("../src/agents/narrator.ts");

  /** The single template literal containing every marker. */
  function sqlContaining(src: string, markers: string[]): string {
    const literals = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);
    const hits = literals.filter((t) => markers.every((mk) => t.includes(mk)));
    expect(hits.length, `expected exactly 1 literal matching ${markers.join(" + ")}`).toBe(1);
    expect(hits[0]!, "unsubstituted interpolation").not.toMatch(/\$\{/);
    return hits[0]!;
  }

  const OBSERVER_LIST = () => sqlContaining(observerSrc, ["FROM lookalike_domains ld", "JOIN brands b"]);
  const OBSERVER_SUMMARY = () => sqlContaining(observerSrc, ["FROM lookalike_domains", "COUNT(DISTINCT brand_id)"]);
  const NARRATOR_BRAND = () => sqlContaining(narratorSrc, ["FROM lookalike_domains", "dns_active"]);
  const NARRATOR_SIGNALS = () => sqlContaining(narratorSrc, ["lookalike_count", "appstore_count"]);

  /**
   * One row of every shape the widened pipeline produces.
   *
   * `seeded_*` are the rows that made these reports dishonest: inserted
   * minutes ago by the seeder, flipped `registered` by a BASELINE check,
   * and registered years before we ever looked. `appeared` is the only
   * genuine transition.
   */
  function fixture() {
    const db = new DatabaseSync!(":memory:");
    db.exec(DDL);
    db.prepare(`INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b1','Acme','acme.example','monitored')`).run();
    const ins = db.prepare(
      `INSERT INTO lookalike_domains
         (id, brand_id, domain, registered, first_seen, last_checked, created_at, has_content, mx_records, dns_active)
       VALUES (?, 'b1', ?, ?, ?, ?, ?, 0, NULL, 1)`,
    );
    // Baselined today: created now, checked now, NO observed appearance.
    ins.run("seeded_baseline", "s1.example", 1, null, "now-ish", null);
    db.prepare(`UPDATE lookalike_domains SET created_at = datetime('now','-1 hour'), last_checked = datetime('now','-1 hour') WHERE id='seeded_baseline'`).run();
    // Same, but not yet checked at all.
    ins.run("seeded_unchecked", "s2.example", 0, null, null, null);
    db.prepare(`UPDATE lookalike_domains SET created_at = datetime('now','-1 hour') WHERE id='seeded_unchecked'`).run();
    // A REAL transition observed an hour ago on a long-standing row.
    ins.run("appeared", "s3.example", 1, null, null, null);
    db.prepare(`UPDATE lookalike_domains SET created_at = datetime('now','-200 days'), first_seen = datetime('now','-1 hour'), last_checked = datetime('now','-1 hour') WHERE id='appeared'`).run();
    // A transition observed four months ago — outside every window here.
    ins.run("old", "s4.example", 1, null, null, null);
    db.prepare(`UPDATE lookalike_domains SET created_at = datetime('now','-200 days'), first_seen = datetime('now','-120 days'), last_checked = datetime('now','-120 days') WHERE id='old'`).run();
    return db;
  }

  it("observer's 'Newly registered' list contains ONLY the observed transition", () => {
    const db = fixture();
    const rows = db.prepare(OBSERVER_LIST()).all() as Array<{ domain: string }>;
    expect(rows.map((r) => r.domain)).toEqual(["s3.example"]);
  });

  it("observer's summary counts rows we CHECKED, not rows the seeder inserted", () => {
    const db = fixture();
    const row = db.prepare(OBSERVER_SUMMARY()).get() as { total: number; registered: number };
    // seeded_baseline + appeared were checked in the window; the
    // never-checked seeder row and the four-month-old one were not.
    expect(row.total).toBe(2);
    expect(row.registered).toBe(2);
    // The block is gated on `total > 0`, so the briefing line still
    // renders — the fix narrows the numbers, it does not zero the report.
    expect(row.total).toBeGreaterThan(0);
  });

  it("narrator's per-brand 7-day list contains ONLY the observed transition", () => {
    const db = fixture();
    const rows = db.prepare(NARRATOR_BRAND()).all("b1") as Array<{ domain: string }>;
    expect(rows.map((r) => r.domain)).toEqual(["s3.example"]);
  });

  it("narrator's signal-gate count does not fire on seeder output", () => {
    const db = fixture();
    // The gate query needs the brand to have threats to be selected at
    // all; the column under test is `lookalike_count`.
    db.prepare(
      `INSERT INTO threats (id, target_brand_id, threat_type, severity, source_feed, indicator, status, created_at)
       VALUES ('t1','b1','phishing','high','feed','x','active', datetime('now','-1 day'))`,
    ).run();
    db.prepare(`UPDATE brands SET tier = 'monitored' WHERE id = 'b1'`).run();
    // `brands` needs the columns the gate selects.
    db.exec(`ALTER TABLE brands ADD COLUMN email_security_grade TEXT`);
    db.exec(`ALTER TABLE brands ADD COLUMN threat_count INTEGER DEFAULT 0`);
    db.prepare(`UPDATE brands SET threat_count = 5 WHERE id = 'b1'`).run();
    db.exec(`CREATE TABLE social_monitor_results (id TEXT, brand_id TEXT, created_at TEXT)`);

    const rows = db.prepare(NARRATOR_SIGNALS()).all() as Array<{ lookalike_count: number }>;
    expect(rows).toHaveLength(1);
    // One genuine appearance in the 7-day window — NOT the four rows
    // `created_at` would have counted.
    expect(rows[0]!.lookalike_count).toBe(1);
  });

  it("no lookalike reading keys on created_at any more", () => {
    // The structural half. A reading restored to `created_at` passes
    // every count above the moment the fixture is "updated to match".
    for (const [label, sql] of [
      ["observer:list", OBSERVER_LIST()],
      ["observer:summary", OBSERVER_SUMMARY()],
      ["narrator:brand", NARRATOR_BRAND()],
      ["narrator:signals", NARRATOR_SIGNALS()],
    ] as const) {
      expect(sql, label).not.toMatch(/ld\.created_at|lookalike_domains\s+WHERE\s+created_at/);
    }
    expect(NARRATOR_SIGNALS()).toMatch(/FROM lookalike_domains ld WHERE ld\.brand_id = b\.id AND ld\.registered = 1 AND ld\.first_seen >=/);
  });
});
