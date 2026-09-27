import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { LOOKALIKE_LIST_COLUMNS } from "../src/handlers/lookalikeDomains";

// The staff lookalike list endpoint was `SELECT *`, so every column added
// to `lookalike_domains` was published to every staff caller with no
// review step. These tests are that review step: the expected set below
// must be edited by hand, so a new column cannot reach the API payload
// without someone deciding it should.
//
// They also guard the direction that matters more than drift: a column
// the tenant surface must NOT see (page_evidence — a literal lifted
// verbatim from attacker page content) staying out of the tenant SELECT
// even while it is legitimately present here.

const EXPECTED_COLUMNS = [
  // 0031 base table
  "id", "brand_id", "domain", "permutation_type", "registered",
  "resolves_to", "has_mx", "has_web", "first_seen", "last_checked",
  "threat_level", "ai_assessment", "alert_id", "status",
  "created_at", "updated_at",
  // 0227 / 0242
  "takedown_id", "unicode_domain",
  // 0243 page analysis
  "page_fetched_at", "page_http_status", "page_phishing_score",
  "page_signals", "page_content_hash",
  // 0260 anti-bot wall
  "page_anti_bot_wall",
  // 0264 Lane 3 AI build artifacts
  "page_ai_signals", "page_score_delta", "page_generator",
  "page_exfil_sink", "page_exfil_sink_id", "page_evidence",
];

/** Drop // line comments and block comments so assertions test CODE. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every migration file, read fresh. Deliberately a directory scan rather
 * than a hand-listed set: a hardcoded list only guards the migrations
 * someone remembered to add to it, which fails in exactly the case this
 * test exists for — a NEW migration adding a column nobody wired up.
 */
function allMigrations(): Array<{ name: string; sql: string }> {
  const dir = resolve(__dirname, "..", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(resolve(dir, name), "utf8") }));
}

describe("staff lookalike list — explicit column allowlist", () => {
  it("matches the reviewed column set exactly", () => {
    // Order-insensitive: the SQL doesn't care, and a reorder is not a
    // security event. Membership is what's being pinned.
    expect([...LOOKALIKE_LIST_COLUMNS].sort()).toEqual([...EXPECTED_COLUMNS].sort());
  });

  it("has no duplicates (a duplicate column is a malformed SELECT)", () => {
    expect(new Set(LOOKALIKE_LIST_COLUMNS).size).toBe(LOOKALIKE_LIST_COLUMNS.length);
  });

  it("names only plain identifiers — nothing that could carry SQL", () => {
    // The list is interpolated into the query string rather than bound,
    // so this pins the property that makes that safe.
    for (const col of LOOKALIKE_LIST_COLUMNS) {
      expect(col).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });

  it("covers every column ANY migration adds to the table", () => {
    // Drift guard in the other direction: if a migration adds a column
    // and nobody updates the allowlist, the staff payload silently loses
    // a field. Scans the whole migrations directory, so a migration
    // added next year is covered without anyone remembering this test.
    const added: Array<{ col: string; file: string }> = [];
    for (const { name, sql } of allMigrations()) {
      const re = /ALTER\s+TABLE\s+lookalike_domains\s+ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/gi;
      for (const m of sql.matchAll(re)) {
        added.push({ col: m[1]!.toLowerCase(), file: name });
      }
    }
    // Sanity: the scan found the columns we know exist, so a silent
    // regex or path failure can't make this vacuously pass.
    expect(added.length).toBeGreaterThan(10);
    for (const { col, file } of added) {
      // Name the migration in the failure — the next person to hit this
      // needs to know which file added the column, not just its name.
      expect(LOOKALIKE_LIST_COLUMNS, `${col} (added by ${file})`).toContain(col);
    }
  });

  it("finds the base table's CREATE TABLE columns too", () => {
    // The 0031 base columns arrive via CREATE TABLE, not ADD COLUMN, so
    // the scan above cannot see them — this covers the other half.
    const create = allMigrations().find((m) => m.name.startsWith("0031_"));
    expect(create, "0031 base migration not found").toBeDefined();
    const body = create!.sql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?lookalike_domains\s*\(([\s\S]*?)\n\)/i,
    );
    expect(body, "could not parse the CREATE TABLE body").toBeTruthy();
    const baseCols = body![1]!
      .split("\n")
      .map((l) => l.replace(/--.*$/, "").trim())
      .filter(Boolean)
      .map((l) => l.match(/^([a-z_][a-z0-9_]*)\s/i)?.[1]?.toLowerCase())
      .filter((c): c is string => !!c && c !== "unique" && c !== "primary");
    expect(baseCols.length).toBeGreaterThan(10);
    for (const col of baseCols) {
      expect(LOOKALIKE_LIST_COLUMNS).toContain(col);
    }
  });

  it("keeps page_evidence off the tenant SELECT while allowing it here", () => {
    // page_evidence is staff-only: no closed vocabulary, lifted verbatim
    // from attacker page content, and the tenant surface has non-React
    // sinks (CSV export, briefing email). Present here, absent there.
    expect(LOOKALIKE_LIST_COLUMNS).toContain("page_evidence");

    // Comments are stripped first — the tenant handler mentions
    // page_evidence twice on purpose, documenting WHY it is excluded.
    // Matching raw source would fail on the very comments that record
    // the invariant, and "fixing" that by deleting them would be
    // exactly backwards.
    const tenantCode = stripComments(readFileSync(
      resolve(__dirname, "..", "src", "handlers", "tenantDomainModule.ts"),
      "utf8",
    ));
    expect(tenantCode).not.toMatch(/\bpage_evidence\b/);
    // And the tenant handler must not have quietly become SELECT * on
    // lookalike_domains, which would reintroduce it by the back door.
    expect(tenantCode).not.toMatch(/SELECT\s+\*\s+FROM\s+lookalike_domains/i);
  });

  it("no staff query on lookalike_domains uses SELECT *", () => {
    // Covers BOTH response paths that publish a whole row: the list
    // endpoint and the PATCH echo in handleUpdateLookalike. The second
    // one is why this asserts over the file rather than one query — the
    // first version of this test found it.
    const handler = stripComments(readFileSync(
      resolve(__dirname, "..", "src", "handlers", "lookalikeDomains.ts"),
      "utf8",
    ));
    expect(handler).not.toMatch(/SELECT\s+\*\s+FROM\s+lookalike_domains/i);
  });
});
