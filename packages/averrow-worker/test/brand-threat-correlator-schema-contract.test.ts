/**
 * W1.2 — schema-contract regression tests for the three dead-read column
 * bugs fixed in a2f511a (brand-threat-correlator.ts):
 *
 *   - spam_trap_captures:        classification -> category
 *   - spam_trap_captures:        sender_email    -> from_address
 *   - phishing_pattern_signals:  ai_generated    -> ai_generated_probability
 *
 * All three were `.catch()`-swallowed "no such column" SQLite errors —
 * correlateBrandThreats() silently fell back to its zeroed defaults
 * (`{ total: 0, phishing: 0, ... }` / `{ count: 0 }`) for months. Nothing
 * threw, nothing logged loudly, `tsc` has no visibility into D1 column
 * names, and no existing test executed these two queries against a real
 * schema — this is exactly the failure class `docs`/CLAUDE.md calls out
 * ("SQL column/placeholder/bind arity ... runtime bugs tsc waves through").
 *
 * This suite has no SQLite engine available in this package's devDeps (no
 * better-sqlite3 / miniflare D1 harness — checked package.json), so instead
 * of executing the queries it does static schema-contract verification,
 * following the house pattern of reading real source/migration files off
 * disk (see test/cron-scanner-dispatch.test.ts's orchestrator-source
 * assertions):
 *
 *   1. Parse the real `CREATE TABLE` column lists for spam_trap_captures
 *      (migration 0022) and phishing_pattern_signals (migration 0023) —
 *      confirmed via grep that no later migration ALTERs either table.
 *   2. Extract the two live SQL query strings straight out of
 *      brand-threat-correlator.ts.
 *   3. Extract every column identifier each query actually references and
 *      assert it exists in the parsed schema.
 *
 * A revert of any of the three column names, or a newly introduced phantom
 * column in either query, fails this suite.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AI_GENERATION_PROBABILITY_THRESHOLD } from "../src/lib/phishing-signals";

const migrationsDirPath = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrationPath = (name: string) =>
  fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));

const correlatorPath = fileURLToPath(
  new URL("../src/brand-threat-correlator.ts", import.meta.url),
);

// ─── Minimal CREATE TABLE column parser ─────────────────────────────
//
// Handles the subset of SQLite DDL this codebase's migrations actually
// use: flat column definitions plus an optional table-level
// `FOREIGN KEY (...) REFERENCES ...` line, and `--` line comments
// interleaved between columns (both migration files use them as section
// headers, e.g. "-- Sender info").

function parseCreateTableColumns(rawSql: string, table: string): string[] {
  const sql = rawSql.replace(/--[^\n]*/g, ""); // strip line comments first

  const startRe = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`, "i");
  const startMatch = startRe.exec(sql);
  if (!startMatch) {
    throw new Error(`CREATE TABLE for "${table}" not found in migration source`);
  }

  let depth = 1;
  let i = startMatch.index + startMatch[0].length;
  const bodyStart = i;
  for (; i < sql.length && depth > 0; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
  }
  const body = sql.slice(bodyStart, i - 1);

  // Split on top-level (paren-depth-0) commas only, so a column's own
  // parenthesized default (e.g. `datetime('now')`) or a table-level
  // `FOREIGN KEY (x) REFERENCES y(z)` doesn't get split mid-clause.
  const lines: string[] = [];
  let cur = "";
  let d = 0;
  for (const ch of body) {
    if (ch === "(") d++;
    if (ch === ")") d--;
    if (ch === "," && d === 0) {
      lines.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) lines.push(cur);

  const tableLevelKeywords = new Set(["FOREIGN", "PRIMARY", "UNIQUE", "CHECK", "CONSTRAINT"]);
  const columns: string[] = [];
  for (const line of lines) {
    const firstToken = line.trim().split(/\s+/)[0];
    if (!firstToken) continue;
    if (tableLevelKeywords.has(firstToken.toUpperCase())) continue;
    columns.push(firstToken);
  }
  return columns;
}

/**
 * Additive columns a later migration adds to `tableName` via
 * `ALTER TABLE <tableName> ADD COLUMN <col>`. CLAUDE.md §8 permits only
 * additive column changes (never DROP/ALTER of existing columns), so folding
 * these into the base CREATE TABLE set keeps the authoritative schema current
 * without freezing the parser to 0022/0023. Scans every migration except the
 * two base files.
 */
function parseAddedColumns(tableName: string): string[] {
  const added: string[] = [];
  const files = readdirSync(migrationsDirPath).filter(
    (f) =>
      f.endsWith(".sql") &&
      f !== "0022_spam_trap_system.sql" &&
      f !== "0023_seed_campaign_v1_and_phishing_signals.sql",
  );
  const re = new RegExp(
    `ALTER\\s+TABLE\\s+${tableName}\\s+ADD\\s+COLUMN\\s+([A-Za-z_]\\w*)`,
    "gi",
  );
  for (const file of files) {
    const content = readFileSync(migrationPath(file), "utf8");
    for (const m of content.matchAll(re)) added.push(m[1]);
  }
  return added;
}

// ─── Minimal SQL column-reference extractor ─────────────────────────

const SQL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "AS", "COUNT", "DISTINCT", "SUM",
  "CASE", "WHEN", "THEN", "ELSE", "END", "MAX", "MIN", "AVG", "JOIN", "ON",
  "GROUP", "BY", "ORDER", "LIMIT", "OFFSET", "IS", "NOT", "NULL", "IN",
  "LIKE", "DATETIME", "NOW",
]);

function stripStringLiterals(sql: string): string {
  return sql.replace(/'[^']*'/g, "''");
}

/** For a single-table query with no aliases: every leftover non-keyword,
 *  non-table-name identifier is a bare column reference. */
function extractSingleTableColumns(sql: string, tableName: string): string[] {
  let s = stripStringLiterals(sql);
  s = s.replace(/\bAS\s+\w+/gi, ""); // drop output aliases (`as total`) — not column refs
  const tokens = s.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  const cols = new Set<string>();
  for (const t of tokens) {
    if (SQL_KEYWORDS.has(t.toUpperCase())) continue;
    if (t === tableName) continue;
    cols.add(t);
  }
  return [...cols];
}

/** For a multi-table (JOIN) query: every `alias.column` reference. */
function extractQualifiedColumns(sql: string): Array<{ alias: string; column: string }> {
  const s = stripStringLiterals(sql);
  return [...s.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g)].map((m) => ({
    alias: m[1],
    column: m[2],
  }));
}

/** Resolves `alias -> table` from a query's FROM + JOIN clauses. */
function extractAliasTableMap(sql: string): Record<string, string> {
  const map: Record<string, string> = {};
  const fromMatch = /FROM\s+(\w+)\s+(\w+)/i.exec(sql);
  if (fromMatch) map[fromMatch[2]] = fromMatch[1];
  const joinMatch = /JOIN\s+(\w+)\s+(\w+)\s+ON/i.exec(sql);
  if (joinMatch) map[joinMatch[2]] = joinMatch[1];
  return map;
}

// ─── Fixtures: real schema + real query source ──────────────────────

const migration0022 = readFileSync(migrationPath("0022_spam_trap_system.sql"), "utf8");
const migration0023 = readFileSync(
  migrationPath("0023_seed_campaign_v1_and_phishing_signals.sql"),
  "utf8",
);
const correlatorSrc = readFileSync(correlatorPath, "utf8");

// Authoritative schema = base CREATE TABLE columns + additive columns folded
// in from any later migration's ALTER TABLE ... ADD COLUMN (CLAUDE.md §8).
const spamTrapColumns = [
  ...parseCreateTableColumns(migration0022, "spam_trap_captures"),
  ...parseAddedColumns("spam_trap_captures"),
];
const phishingSignalColumns = [
  ...parseCreateTableColumns(migration0023, "phishing_pattern_signals"),
  ...parseAddedColumns("phishing_pattern_signals"),
];

// The two queries under test, pulled directly out of the source file by
// content (not by line number, so the test survives reformatting).
const templateLiterals = [...correlatorSrc.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
const trapQuery = templateLiterals.find(
  (t) => /FROM\s+spam_trap_captures/i.test(t) && !/phishing_pattern_signals/i.test(t),
);
const aiQuery = templateLiterals.find((t) => /FROM\s+phishing_pattern_signals/i.test(t));

describe("brand-threat-correlator SQL column contract (regression for a2f511a)", () => {
  it("locates both target queries in the source (sanity check for the extraction itself)", () => {
    expect(trapQuery, "spam-trap stats query not found — correlator SQL shape changed").toBeTruthy();
    expect(aiQuery, "AI-phishing count query not found — correlator SQL shape changed").toBeTruthy();
  });

  it("parses the real spam_trap_captures schema off migration 0022 (sanity check for the schema parser)", () => {
    // A handful of known-real columns must be present...
    expect(spamTrapColumns).toEqual(
      expect.arrayContaining(["category", "from_address", "sending_ip", "captured_at", "spoofed_brand_id"]),
    );
    // ...and the two bug-report column names must NOT be, or this suite
    // would pass vacuously even with the old bug reinstated.
    expect(spamTrapColumns).not.toContain("classification");
    expect(spamTrapColumns).not.toContain("sender_email");
  });

  it("parses the real phishing_pattern_signals schema off migration 0023 (sanity check for the schema parser)", () => {
    expect(phishingSignalColumns).toContain("ai_generated_probability");
    expect(phishingSignalColumns).not.toContain("ai_generated");
    // classification IS a real column on this table (unlike spam_trap_captures) —
    // confirms the parser isn't just accidentally matching table names.
    expect(phishingSignalColumns).toContain("classification");
  });

  describe("spam-trap stats query (section 3)", () => {
    it("every column it references exists on spam_trap_captures", () => {
      const referenced = extractSingleTableColumns(trapQuery!, "spam_trap_captures");
      expect(referenced.length).toBeGreaterThan(0);
      for (const col of referenced) {
        expect(
          spamTrapColumns,
          `column "${col}" referenced in the spam-trap stats query does not exist on spam_trap_captures`,
        ).toContain(col);
      }
    });

    it("uses category (not the old dead column classification)", () => {
      expect(trapQuery).toMatch(/\bcategory\s*=\s*'phishing'/);
      expect(trapQuery).not.toMatch(/\bclassification\b/);
    });

    it("uses from_address (not the old dead column sender_email)", () => {
      expect(trapQuery).toMatch(/COUNT\(DISTINCT from_address\)/);
      expect(trapQuery).not.toMatch(/\bsender_email\b/);
    });
  });

  describe("AI-phishing count query (section 4)", () => {
    it("joins phishing_pattern_signals (pps) to spam_trap_captures (stc) as expected", () => {
      const aliasMap = extractAliasTableMap(aiQuery!);
      expect(aliasMap).toEqual({ pps: "phishing_pattern_signals", stc: "spam_trap_captures" });
    });

    it("every alias-qualified column it references exists on its real table", () => {
      const aliasMap = extractAliasTableMap(aiQuery!);
      const refs = extractQualifiedColumns(aiQuery!);
      expect(refs.length).toBeGreaterThan(0);

      const schemas: Record<string, string[]> = {
        spam_trap_captures: spamTrapColumns,
        phishing_pattern_signals: phishingSignalColumns,
      };

      for (const { alias, column } of refs) {
        const table = aliasMap[alias];
        expect(table, `unknown alias "${alias}" in AI-phishing count query`).toBeTruthy();
        expect(
          schemas[table],
          `column "${column}" referenced via ${alias}.${column} does not exist on ${table}`,
        ).toContain(column);
      }
    });

    it("filters on pps.ai_generated_probability (not the old dead column ai_generated)", () => {
      expect(aiQuery).toMatch(/pps\.ai_generated_probability\s*>=\s*\?/);
      // \b requires a non-word boundary, so this correctly does NOT match
      // inside "ai_generated_probability" (underscore is a word char) —
      // it only fires if the bare dead column name reappears verbatim.
      expect(aiQuery).not.toMatch(/\bai_generated\b/);
    });
  });

  it("folds additive ALTER TABLE columns into the authoritative schema (parser stays current, not frozen to 0022/0023)", () => {
    // The authoritative column sets union the base CREATE TABLE with any
    // later migration's ADD COLUMN, so an additive migration (CLAUDE.md §8)
    // can't make a legitimate new column look like a phantom reference. This
    // pins that the fold-in actually ran: migration 0257 adds campaign_key /
    // campaign_key_kind to phishing_pattern_signals. If a future migration
    // additively extends either table, the fold picks it up automatically —
    // only a DROP/rename of an existing column (which §8 forbids) would break
    // the contract, and that would surface as a phantom-column failure above.
    expect(phishingSignalColumns).toContain("campaign_key");
    expect(phishingSignalColumns).toContain("campaign_key_kind");
    // Base columns still present (union didn't clobber the CREATE TABLE set).
    expect(phishingSignalColumns).toContain("ai_generated_probability");
    expect(spamTrapColumns).toContain("category");
    expect(spamTrapColumns).toContain("from_address");
  });
});

// ─── AI_GENERATION_PROBABILITY_THRESHOLD boundary semantics ─────────

describe("AI_GENERATION_PROBABILITY_THRESHOLD", () => {
  it("is 0.7", () => {
    expect(AI_GENERATION_PROBABILITY_THRESHOLD).toBe(0.7);
  });

  it("is a valid probability threshold, strictly between 0 and 1", () => {
    expect(AI_GENERATION_PROBABILITY_THRESHOLD).toBeGreaterThan(0);
    expect(AI_GENERATION_PROBABILITY_THRESHOLD).toBeLessThan(1);
  });

  it("is the literal value bound into the correlator's AI-phishing count query", () => {
    // Pins that the query binds the shared constant rather than a
    // re-hardcoded magic number that could drift from it.
    expect(correlatorSrc).toContain("AI_GENERATION_PROBABILITY_THRESHOLD");
    expect(correlatorSrc).toMatch(
      /\.bind\(brandId,\s*AI_GENERATION_PROBABILITY_THRESHOLD\)/,
    );
  });
});

/**
 * Mirrors SQLite's three-valued-logic semantics for
 * `ai_generated_probability >= ?` documented in the comment above the
 * query in brand-threat-correlator.ts: `NULL >= 0.7` evaluates to NULL,
 * which a WHERE clause treats as false — so unscored rows are excluded
 * without an explicit `IS NOT NULL` guard, and the comparison itself is
 * inclusive (`>=`, not `>`).
 *
 * No SQLite engine is available in this package's test deps, so this
 * reproduces the predicate in JS to pin the exact boundary behavior the
 * commit's boundary widen (`>` -> `>=`) depends on.
 */
function nullSafeGte(value: number | null, threshold: number): boolean {
  if (value === null) return false;
  return value >= threshold;
}

describe("ai_generated_probability >= AI_GENERATION_PROBABILITY_THRESHOLD (NULL-safe inclusive comparison)", () => {
  it("excludes NULL — unscored rows never count, matching SQLite's NULL >= x => NULL => falsy semantics", () => {
    expect(nullSafeGte(null, AI_GENERATION_PROBABILITY_THRESHOLD)).toBe(false);
  });

  it("excludes a score just below the threshold (0.69)", () => {
    expect(nullSafeGte(0.69, AI_GENERATION_PROBABILITY_THRESHOLD)).toBe(false);
  });

  it("includes a score exactly at the threshold (0.7) — the comparison is inclusive", () => {
    expect(nullSafeGte(0.7, AI_GENERATION_PROBABILITY_THRESHOLD)).toBe(true);
  });

  it("includes a score just above the threshold (0.71)", () => {
    expect(nullSafeGte(0.71, AI_GENERATION_PROBABILITY_THRESHOLD)).toBe(true);
  });
});
