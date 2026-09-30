/**
 * Coverage for `lib/monitored-brands.ts` — the ONE definition of the
 * brand population that lookalike generation and page analysis share.
 *
 * Two lanes, and the split is deliberate:
 *
 *   1. REAL SQLITE (`node:sqlite`, house pattern from
 *      test/geo-exhaustion-and-diag-folds.test.ts). The predicate is a
 *      SQL string, so the only honest test of what it ADMITS is to run
 *      it. This lane exists because a structural/string test would have
 *      passed the bug that shipped in the first draft of this change:
 *      `tier IN ('monitored','customer') AND monitoring_status='active'`
 *      reads correctly and halves the production population, because two
 *      of the three `customer`-tier brands are flagged inactive.
 *
 *   2. STATIC SOURCE. Both call sites must interpolate the SHARED
 *      constant, and neither may reintroduce an `org_brands` gate. The
 *      whole point of the constant is that seeder and analyzer cannot
 *      drift; a copy-pasted predicate in one of them would still pass
 *      lane 1 while breaking that invariant.
 *
 * Lane 1 runs the queries EXTRACTED FROM SOURCE, not retyped: a retyped
 * copy tests the copy. See `sqlContaining` below.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  MONITORED_BRAND_PREDICATE_SQL,
  MONITORED_BRAND_TIERS,
} from "../src/lib/monitored-brands";

type SqliteCtor = new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
};

// Resolved SYNCHRONOUSLY at collection time — `describe.skipIf` is
// evaluated before any `beforeAll` hook, so an async import here would
// skip the SQLite lane on a runtime that actually supports it.
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

const seederSrc = read("../src/scanners/lookalike-domains.ts");
const analyzerSrc = read("../src/scanners/lookalike-page-analysis.ts");

/** Drop // line comments and block comments so assertions test CODE. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The single template literal in `src` containing every marker, with
 * `${MONITORED_BRAND_PREDICATE_SQL}` substituted for its real value.
 *
 * Extracting rather than retyping is the point: this runs the query the
 * scanner actually issues, so an alias mismatch (`b.` vs the JOIN's
 * alias) or an unbalanced paren in the predicate fails here instead of
 * at 3am in a cron tick. Asserts exactly one match, so an ambiguous
 * marker set is a test failure rather than a silent wrong pick.
 */
function sqlContaining(src: string, markers: string[]): string {
  const literals = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);
  const hits = literals.filter((t) => markers.every((mk) => t.includes(mk)));
  expect(hits.length, `expected exactly 1 template literal matching ${markers.join(" + ")}`).toBe(1);
  const withPredicate = hits[0]!.replace(
    /\$\{MONITORED_BRAND_PREDICATE_SQL\}/g,
    MONITORED_BRAND_PREDICATE_SQL,
  );
  // Any OTHER interpolation would run as literal `${...}` text and make
  // the SQL below meaningless-but-passing. Fail loudly instead.
  expect(withPredicate, "unsubstituted interpolation left in extracted SQL").not.toMatch(/\$\{/);
  return withPredicate;
}

// ═══════════════════════════════════════════════════════════════════════
// Lane 1 — what the predicate ADMITS, against real SQLite
// ═══════════════════════════════════════════════════════════════════════

const BRANDS_DDL = `
  CREATE TABLE brands (
    id TEXT PRIMARY KEY,
    name TEXT,
    canonical_domain TEXT,
    tier TEXT,
    monitoring_status TEXT
  );
`;

const LOOKALIKE_DDL = `
  CREATE TABLE lookalike_domains (
    id TEXT PRIMARY KEY,
    brand_id TEXT,
    domain TEXT,
    registered INTEGER,
    has_web INTEGER,
    resolves_to TEXT,
    page_fetched_at TEXT,
    threat_level TEXT,
    alert_id TEXT,
    -- Columns the page-analysis SELECT gained when that pass became an
    -- alert PRODUCER (it reproduces the checker's alert shape from the
    -- same row rather than making a second round-trip). Unused by the
    -- brand gate this file is about, but the query is executed for real
    -- against this DDL, so a missing column fails as a SQL error.
    permutation_type TEXT,
    unicode_domain TEXT,
    has_mx INTEGER
  );
`;

/**
 * The tier × monitoring_status matrix, with the expected verdict spelled
 * out per row. `in: true` means "the platform monitors this brand".
 */
const MATRIX: Array<{ id: string; tier: string | null; status: string | null; in: boolean; why: string }> = [
  // ── customer tier: unconditional ───────────────────────────────────
  { id: "cust_active",   tier: "customer",  status: "active",   in: true,  why: "paying customer" },
  { id: "cust_inactive", tier: "customer",  status: "inactive", in: true,  why: "2 of 3 production customer brands look like this" },
  { id: "cust_null",     tier: "customer",  status: null,       in: true,  why: "status never stamped" },
  { id: "cust_weird",    tier: "customer",  status: "paused",   in: true,  why: "unknown status value" },

  // ── monitored tier: ALSO unconditional ─────────────────────────────
  // `monitoring_status` is vestigial — nothing in the repo ever writes
  // 'inactive', so its absence encodes no decision. These four rows are
  // the standing stipulation: every monitored brand is covered. A change
  // that flips any of them to `in: false` is re-adding a closed
  // narrowing; see the constant's docstring before doing it.
  { id: "mon_active",   tier: "monitored", status: "active",   in: true,  why: "the curated seed set" },
  { id: "mon_inactive", tier: "monitored", status: "inactive", in: true,  why: "1,505 brands — the INSERT default, not a decision" },
  { id: "mon_null",     tier: "monitored", status: null,       in: true,  why: "status is not consulted at all" },
  { id: "mon_weird",    tier: "monitored", status: "paused",   in: true,  why: "'paused' has never existed in a single row" },

  // ── everything else: out ───────────────────────────────────────────
  // `tracked` stays out on BOTH statuses. 631 catalog rows carry
  // 'active', which is exactly why tier is the scope column and the
  // status flag is not.
  { id: "tracked_active", tier: "tracked", status: "active", in: false, why: "catalog — and 631 real rows look like this" },
  { id: "tracked_null",   tier: "tracked", status: null,     in: false, why: "catalog" },
  { id: "tracked_inact",  tier: "tracked", status: "inactive", in: false, why: "catalog, 111,753 rows" },
  { id: "tier_null",      tier: null,      status: "active", in: false, why: "no tier = not monitored" },
  { id: "tier_unknown",   tier: "prospect", status: "active", in: false, why: "a tier added later must opt IN explicitly" },
];

describe.skipIf(!hasSqlite())("MONITORED_BRAND_PREDICATE_SQL — real SQLite", () => {
  let raw: InstanceType<SqliteCtor>;

  beforeAll(() => {
    raw = new DatabaseSync!(":memory:");
    raw.exec(BRANDS_DDL);
    raw.exec(LOOKALIKE_DDL);
    const ins = raw.prepare(
      `INSERT INTO brands (id, name, canonical_domain, tier, monitoring_status)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of MATRIX) {
      ins.run(row.id, row.id, `${row.id}.example`, row.tier, row.status);
    }
  });

  function admitted(): Set<string> {
    const rows = raw.prepare(
      `SELECT b.id FROM brands b WHERE ${MONITORED_BRAND_PREDICATE_SQL}`,
    ).all() as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  it("is valid SQL and admits the expected set exactly", () => {
    const got = admitted();
    expect([...got].sort()).toEqual(MATRIX.filter((r) => r.in).map((r) => r.id).sort());
  });

  // Per-row cases so a failure names WHICH cell of the matrix moved,
  // not just that the set differs.
  for (const row of MATRIX) {
    it(`${row.in ? "admits" : "excludes"} tier=${row.tier} status=${row.status} — ${row.why}`, () => {
      expect(admitted().has(row.id)).toBe(row.in);
    });
  }

  it("does not consult monitoring_status AT ALL — for any tier", () => {
    // Stated as a property rather than a row list, so it fails even if
    // someone "updates the matrix to match" after re-adding a status
    // term. Within each admitted tier, the status column must make no
    // difference whatsoever: group the matrix by tier and assert every
    // row in that tier agrees. Re-adding `AND monitoring_status =
    // 'active'` splits the monitored and customer groups and fails here.
    const got = admitted();
    for (const tier of MONITORED_BRAND_TIERS) {
      const rows = MATRIX.filter((r) => r.tier === tier);
      expect(rows.length, `matrix must exercise several statuses for ${tier}`).toBeGreaterThan(1);
      const statuses = new Set(rows.map((r) => String(r.status)));
      expect(statuses.size, `${tier} rows must differ in status`).toBeGreaterThan(1);
      for (const r of rows) expect(got.has(r.id), `${r.id} (${r.why})`).toBe(true);
    }
    // And the mirror: `tracked` is excluded regardless of status, so the
    // exclusion is about tier and not about the flag either.
    const tracked = MATRIX.filter((r) => r.tier === "tracked");
    expect(new Set(tracked.map((r) => String(r.status))).size).toBeGreaterThan(1);
    for (const r of tracked) expect(got.has(r.id), r.id).toBe(false);
  });

  it("runs inside the seeder's real query", () => {
    const sql = sqlContaining(seederSrc, ["FROM brands b", "NOT EXISTS"]);
    // One brand already seeded → NOT EXISTS must drop it.
    raw.prepare(
      `INSERT INTO lookalike_domains (id, brand_id, domain, registered, has_web, resolves_to)
       VALUES ('ld_seeded', 'mon_active', 'm0n-active.example', 1, 1, '1.2.3.4')`,
    ).run();
    const rows = raw.prepare(sql).all(50) as Array<{ brand_id: string }>;
    const ids = rows.map((r) => r.brand_id).sort();
    // Every admitted brand EXCEPT the one already holding a lookalike
    // row — derived from the matrix rather than hardcoded, so widening
    // the predicate doesn't silently leave a stale expectation behind.
    const expected = MATRIX.filter((r) => r.in && r.id !== "mon_active").map((r) => r.id).sort();
    expect(ids).toEqual(expected);
    expect(ids).not.toContain("mon_active");
  });

  it("runs inside the page-analysis query, and gates it on the brand tier", () => {
    const sql = sqlContaining(analyzerSrc, ["FROM lookalike_domains ld", "page_fetched_at"]);
    const ins = raw.prepare(
      `INSERT INTO lookalike_domains
         (id, brand_id, domain, registered, has_web, resolves_to, page_fetched_at)
       VALUES (?, ?, ?, 1, 1, '1.2.3.4', NULL)`,
    );
    // One analyzable candidate per matrix brand — eligibility should then
    // be decided purely by the brand gate.
    for (const row of MATRIX) ins.run(`pa_${row.id}`, row.id, `pa-${row.id}.example`, );
    const rows = raw.prepare(sql).all(100) as Array<{ brand_id: string }>;
    const brands = new Set(rows.map((r) => r.brand_id));
    for (const row of MATRIX) {
      expect(brands.has(row.id), `${row.id} (${row.why})`).toBe(row.in);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Lane 2 — the shared-constant invariant
// ═══════════════════════════════════════════════════════════════════════

describe("both gates share one predicate", () => {
  it("the seeder interpolates the constant rather than its own copy", () => {
    const code = stripComments(seederSrc);
    expect(code).toMatch(/import\s*\{[^}]*MONITORED_BRAND_PREDICATE_SQL[^}]*\}\s*from\s*['"]\.\.\/lib\/monitored-brands['"]/);
    expect(code).toContain("${MONITORED_BRAND_PREDICATE_SQL}");
  });

  it("the page analyzer interpolates the same constant", () => {
    const code = stripComments(analyzerSrc);
    expect(code).toMatch(/import\s*\{[^}]*MONITORED_BRAND_PREDICATE_SQL[^}]*\}\s*from\s*['"]\.\.\/lib\/monitored-brands['"]/);
    expect(code).toContain("${MONITORED_BRAND_PREDICATE_SQL}");
  });

  it("neither query gates on org_brands any more", () => {
    // Asserted over the EXTRACTED SQL, not the file: both files mention
    // org_brands in comments on purpose (recording why it was dropped),
    // and the seeder's log event name still carries the old word.
    for (const [label, sql] of [
      ["seeder", sqlContaining(seederSrc, ["FROM brands b", "NOT EXISTS"])],
      ["analyzer", sqlContaining(analyzerSrc, ["FROM lookalike_domains ld", "page_fetched_at"])],
    ] as const) {
      expect(sql, label).not.toMatch(/\borg_brands\b/);
    }
  });

  it("carries no bind placeholder — it is interpolated, so it must be static", () => {
    expect(MONITORED_BRAND_PREDICATE_SQL).not.toContain("?");
    // Only identifiers, quoted literals, parens, dots, commas (the `IN`
    // list separator) and boolean/operator words. A comma cannot carry
    // SQL on its own, and the statement-breaking characters are excluded
    // separately below — that assertion is the one doing the real work.
    expect(MONITORED_BRAND_PREDICATE_SQL).toMatch(/^[a-z_.',=\s()A-Z]+$/);
    expect(MONITORED_BRAND_PREDICATE_SQL).not.toMatch(/[;-]{1,2}|\/\*/);
  });

  it("assumes the `b` alias both call sites provide", () => {
    // Every column reference must be qualified — an unqualified column
    // would resolve against whatever table the caller happens to JOIN.
    // Exactly one reference now (`b.tier`); the count is asserted rather
    // than bounded so that ADDING a second term is itself a failure here
    // and not just in the matrix.
    const cols = [...MONITORED_BRAND_PREDICATE_SQL.matchAll(/([a-z_]+)\.([a-z_]+)/g)];
    expect(cols.length, "the predicate is `tier` alone — see the docstring").toBe(1);
    for (const m of cols) expect(m[1]).toBe("b");
    expect(MONITORED_BRAND_PREDICATE_SQL).not.toMatch(/monitoring_status/);
  });

  it("keeps the exported constants in step with the SQL text", () => {
    // The constants exist so tests and future callers don't re-type the
    // vocabulary; that only holds if they can't drift from the predicate.
    for (const tier of MONITORED_BRAND_TIERS) {
      expect(MONITORED_BRAND_PREDICATE_SQL).toContain(`'${tier}'`);
    }
    // And nothing appears in the SQL that isn't in the allowlist: pull
    // every quoted literal back out and check it's accounted for. Now
    // that the predicate is tier-only, the tier list is the COMPLETE
    // vocabulary, so this also catches a re-added status literal.
    const literals = [...MONITORED_BRAND_PREDICATE_SQL.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
    const known = new Set<string>(MONITORED_BRAND_TIERS);
    for (const lit of literals) expect(known, `unlisted literal '${lit}'`).toContain(lit);
    expect(literals.length).toBe(MONITORED_BRAND_TIERS.length);
  });
});
