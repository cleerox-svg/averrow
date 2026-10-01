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
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";
import { applyLookalikeSchema, lookalikeColumns } from "./lookalike-schema";

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

/**
 * Every source table the backfill touches, so no source errors.
 *
 * `lookalike_domains` is DELIBERATELY ABSENT from this literal: it is
 * built from the migration files by `applyLookalikeSchema` below. The
 * previous version of this file declared it here by hand — with
 * `has_content INTEGER, mx_records TEXT, dns_active INTEGER`, three
 * columns that exist in NO migration — which is how the queries this
 * lane was written to prove came to be tested against a schema shaped to
 * fit them. See `test/lookalike-schema.ts`.
 */
const DDL = `
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

/**
 * A fresh in-memory DB with the hand-written source tables AND the
 * migration-derived `lookalike_domains`. Every test goes through here,
 * so no test can quietly reintroduce a hand-written column set.
 */
function freshDb(): InstanceType<SqliteCtor> {
  const db = new DatabaseSync!(":memory:");
  db.exec(DDL);
  applyLookalikeSchema(db);
  return db;
}

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
    const db = freshDb();
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

  it("the policy docstring names every producer the repo actually has", () => {
    // The count in this docstring has now been wrong TWICE — first
    // "BOTH producers" while there were three, then "a FOURTH producer
    // is a contradiction in terms" while `lib/phantom-matcher.ts` was
    // already filing the type. So the list is not asserted against a
    // hardcoded expectation; it is DERIVED from the source tree, and
    // every file found must be named in the policy module.
    const policy = read("../src/lib/lookalike-alert-policy.ts");
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const producers = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const code = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        // `alertType:` naming this family, either as a literal or via a
        // config field whose value is this literal.
        if (/alertType:\s*["']lookalike_domain_active["']/.test(code) ||
            (/alertType/.test(code) && /["']lookalike_domain_active["']/.test(code))) {
          producers.add(full.slice(srcDir.length).replace(/\\/g, "/"));
        }
      }
    };
    walk(srcDir);

    // Sanity: the walk found the ones we know about, so a path or regex
    // failure cannot make this vacuous.
    expect(producers.size, [...producers].join(", ")).toBeGreaterThanOrEqual(4);
    for (const rel of producers) {
      if (rel === "lib/lookalike-alert-policy.ts") continue; // the module itself
      expect(policy, `${rel} files lookalike_domain_active but the policy docstring does not name it`)
        .toContain(rel);
    }

    // And the specific false claim is gone.
    expect(policy).not.toContain("A FOURTH producer is a contradiction in terms");
    expect(policy).not.toContain("imported by ALL THREE producers");
  });

  it("phantom-matcher takes its severity FROM the policy module, exemption and all", () => {
    // Producer 4. It legitimately files below the HIGH floor (a phantom
    // hit is a monitoring signal, and it is bounded to one alert per
    // phantom ever by the guarded claim), but it must not do so by
    // hardcoding a severity in ignorance of the floor — which is what
    // it did, and why the floor's docstring could deny it existed.
    const matcher = read("../src/lib/phantom-matcher.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(matcher).toMatch(
      /import\s*\{[^}]*PHANTOM_MATCH_ALERT_SEVERITY[^}]*\}\s*from\s*["']\.\/lookalike-alert-policy["']/,
    );
    expect(matcher).toContain("severity: PHANTOM_MATCH_ALERT_SEVERITY");
    // The bare literal it replaced must be gone from the alert call.
    expect(matcher).not.toMatch(/severity:\s*["']low["']/);

    // The exemption's BOUND has to be stated where the floor lives, not
    // just asserted to exist.
    const policy = read("../src/lib/lookalike-alert-policy.ts");
    expect(policy).toContain("PHANTOM_MATCH_ALERT_SEVERITY");
    expect(policy).toContain("AT MOST ONE alert per `phantom_domains` row");
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
  // RE-KEYED off `dns_active`, a column that does not exist. Keying an
  // extractor on a phantom name is how the whole phantom-column family
  // survived a "fixed by test" round: the marker pinned the defect in
  // place, so correcting the query would have failed extraction rather
  // than the assertion. The markers below are structural and real — the
  // table name and the statement's own ORDER BY / LIMIT.
  const NARRATOR_BRAND = () =>
    sqlContaining(narratorSrc, ["FROM lookalike_domains", "ORDER BY first_seen DESC LIMIT 30"]);
  const NARRATOR_SIGNALS = () => sqlContaining(narratorSrc, ["lookalike_count", "appstore_count"]);

  const ALL_FOUR = () =>
    [
      ["observer:list", OBSERVER_LIST()],
      ["observer:summary", OBSERVER_SUMMARY()],
      ["narrator:brand", NARRATOR_BRAND()],
      ["narrator:signals", NARRATOR_SIGNALS()],
    ] as const;

  /**
   * One row of every shape the widened pipeline produces.
   *
   * `seeded_*` are the rows that made these reports dishonest: inserted
   * minutes ago by the seeder, flipped `registered` by a BASELINE check,
   * and registered years before we ever looked. `appeared` is the only
   * genuine transition.
   */
  function fixture() {
    const db = freshDb();
    db.prepare(`INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b1','Acme','acme.example','monitored')`).run();
    // REAL columns (migration 0031): `has_web` / `has_mx` / `resolves_to`.
    // `has_web = 1, has_mx = 0` on every row, so the observer summary's
    // two corrected SUM(CASE ...) arms return DIFFERENT numbers and the
    // assertions below can tell them apart — with both at 0 the test
    // could not distinguish a working arm from a mis-named one.
    //
    // `permutation_type` is supplied because the REAL schema declares it
    // `NOT NULL` — the hand-written DDL this replaced had it nullable,
    // which is a second, quieter way a fixture-shaped schema diverges
    // from the table the code actually writes to.
    const ins = db.prepare(
      `INSERT INTO lookalike_domains
         (id, brand_id, domain, permutation_type, registered, first_seen, last_checked, created_at,
          has_web, has_mx, resolves_to)
       VALUES (?, 'b1', ?, 'replacement', ?, ?, ?, ?, 1, 0, '5.6.7.8')`,
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
    const row = db.prepare(OBSERVER_SUMMARY()).get() as {
      total: number; registered: number; with_web: number; with_mx: number; brands: number;
    };
    // seeded_baseline + appeared were checked in the window; the
    // never-checked seeder row and the four-month-old one were not.
    expect(row.total).toBe(2);
    expect(row.registered).toBe(2);
    // The block is gated on `total > 0`, so the briefing line still
    // renders — the fix narrows the numbers, it does not zero the report.
    expect(row.total).toBeGreaterThan(0);
    // The two infrastructure arms, which used to name `has_content` and
    // `mx_records` — columns that do not exist, so this statement threw
    // SQLITE_ERROR and (because the agent wraps BOTH queries in one
    // `try`) took the observer's whole lookalike section with it. The
    // fixture sets has_web = 1 / has_mx = 0 on every row, so a swapped
    // or mis-named arm changes these numbers.
    expect(row.with_web).toBe(2);
    expect(row.with_mx).toBe(0);
    expect(row.brands).toBe(1);
  });

  it("narrator's per-brand 7-day list contains ONLY the observed transition", () => {
    const db = fixture();
    const rows = db.prepare(NARRATOR_BRAND()).all("b1") as Array<{
      domain: string; has_web: number; has_mx: number; resolves_to: string | null;
    }>;
    expect(rows.map((r) => r.domain)).toEqual(["s3.example"]);
    // The narrator's RENDERER filters on these three by name
    // (`d.has_web` / `d.has_mx`), so the SELECT must actually deliver
    // them — it used to ask for `dns_active` / `has_content` /
    // `mx_records` and deliver nothing at all, the `.catch` turning the
    // SQLITE_ERROR into a permanently empty array.
    expect(rows[0]!.has_web).toBe(1);
    expect(rows[0]!.has_mx).toBe(0);
    expect(rows[0]!.resolves_to).toBe("5.6.7.8");
  });

  it("the renderer's field names are the ones the SELECT delivers", () => {
    // The other half of the same defect: the SELECT and the `filter()`
    // over its results are 330 lines apart, and both named phantom
    // columns, so they agreed with each other and with nothing else.
    // Executing the query proves the SELECT; this proves the consumer
    // reads the same names.
    //
    // Comments are stripped first: the corrected source documents the
    // three phantom names on purpose (that record is the point), and
    // matching raw text would fail on the very comment that explains the
    // fix — "repairing" which would be exactly backwards.
    const code = narratorSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/d\.has_web\b/);
    expect(code).toMatch(/d\.has_mx\b/);
    for (const phantom of ["has_content", "mx_records", "dns_active"]) {
      expect(code, `narrator code still references ${phantom}`).not.toContain(phantom);
    }
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
    for (const [label, sql] of ALL_FOUR()) {
      expect(sql, label).not.toMatch(/ld\.created_at|lookalike_domains\s+WHERE\s+created_at/);
    }
    expect(NARRATOR_SIGNALS()).toMatch(/FROM lookalike_domains ld WHERE ld\.brand_id = b\.id AND ld\.registered = 1 AND ld\.first_seen >=/);
  });

  // ─────────────────────────────────────────────────────────────────
  // The phantom-column guard itself
  // ─────────────────────────────────────────────────────────────────

  it("all four statements EXECUTE against the migration-built schema", () => {
    // The load-bearing test of this lane. `lookalike_domains` here is
    // derived from the migration files, so a column that no migration
    // declares raises `no such column` and fails HERE, rather than being
    // accommodated by a hand-written CREATE TABLE and then throwing in
    // production. Both agents' previous statements named three such
    // columns; the observer's threw away its own daily-briefing section.
    const db = fixture();
    db.prepare(
      `INSERT INTO threats (id, target_brand_id, threat_type, severity, source_feed, indicator, status, created_at)
       VALUES ('t1','b1','phishing','high','feed','x','active', datetime('now','-1 day'))`,
    ).run();
    db.exec(`ALTER TABLE brands ADD COLUMN email_security_grade TEXT`);
    db.exec(`ALTER TABLE brands ADD COLUMN threat_count INTEGER DEFAULT 0`);
    db.prepare(`UPDATE brands SET threat_count = 5 WHERE id = 'b1'`).run();
    db.exec(`CREATE TABLE social_monitor_results (id TEXT, brand_id TEXT, created_at TEXT)`);

    const params: Record<string, unknown[]> = {
      "observer:list": [],
      "observer:summary": [],
      "narrator:brand": ["b1"],
      "narrator:signals": [],
    };
    for (const [label, sql] of ALL_FOUR()) {
      expect(() => db.prepare(sql).all(...(params[label] as never[])), label).not.toThrow();
    }
  });

  it("names no column the table does not have", () => {
    // Belt to the execution test's braces, and the one that names the
    // three offenders explicitly so a regression reads as itself rather
    // than as a generic SQLite error. Derived from the migrations, not
    // hardcoded, so a column genuinely added later is simply real.
    const real = new Set(lookalikeColumns());
    for (const phantom of ["has_content", "mx_records", "dns_active"]) {
      expect(real, `${phantom} must not be a real column`).not.toContain(phantom);
      for (const [label, sql] of ALL_FOUR()) {
        expect(sql, `${label} references phantom column ${phantom}`).not.toContain(phantom);
      }
    }
    // Sanity: the derived column list is the real thing, not an empty set
    // that would make the loop above vacuous.
    for (const col of ["has_web", "has_mx", "resolves_to", "first_seen", "last_checked"]) {
      expect(real, col).toContain(col);
    }
  });
});
