/**
 * `lookalike_domains` DDL, BUILT FROM THE MIGRATION FILES.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * Three SQLite-backed lookalike test files each hand-wrote their own
 * `CREATE TABLE lookalike_domains (...)`. A hand-written schema cannot
 * fail on a column that does not exist — it can only be *edited to
 * match* the query under test. That is not a hypothetical: the reports
 * test declared `has_content INTEGER, mx_records TEXT, dns_active
 * INTEGER`, inserted into them, and keyed its statement extraction on
 * `"dns_active"` — three columns that appear in NO migration for this
 * table. The queries it was written to prove threw `SQLITE_ERROR` in
 * production while every assertion here was green, and one of those
 * throws had silently deleted the entire lookalike section of the
 * Observer daily briefing.
 *
 * So the schema is now DERIVED, exactly as
 * `test/lookalike-sql-statements.test.ts` already derived its index DDL:
 * the base `CREATE TABLE` from migration 0031, every
 * `ALTER TABLE lookalike_domains ADD COLUMN` from every later migration,
 * and every `CREATE INDEX ... ON lookalike_domains`, applied in
 * migration order. A phantom column is now a test FAILURE
 * ("no such column"), which is the only arrangement under which these
 * files test the code rather than themselves.
 *
 * Directory scan, not a hand-listed set: a hardcoded list only covers
 * the migrations someone remembered to add to it, which fails in exactly
 * the case that matters — a migration added later.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** The minimal surface of a `node:sqlite` DatabaseSync this module needs. */
export interface ExecutableDb {
  exec(sql: string): void;
}

const MIGRATIONS_DIR = resolve(__dirname, "..", "migrations");

/** Every migration file, sorted by name (= apply order). */
function allMigrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(resolve(MIGRATIONS_DIR, name), "utf8") }));
}

/**
 * Split a migration into statements.
 *
 * `--` line comments are stripped FIRST. Every lookalike migration
 * discusses DDL in prose ("ADD COLUMN / CREATE INDEX, never DROP/ALTER"),
 * and a match that began inside a comment would run to the next real
 * semicolon and swallow the statement after it.
 */
function statements(migrationSql: string): string[] {
  return migrationSql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface LookalikeSchema {
  /** The DDL statements, in migration order, ready to `exec`. */
  ddl: string[];
  /** Migration file names that contributed at least one statement. */
  sources: string[];
  /** `CREATE INDEX` statements only. */
  indexes: string[];
}

/**
 * Collect the `lookalike_domains` DDL from the migrations directory.
 *
 * Deliberately NOT a general-purpose migration runner: it picks out the
 * three statement shapes that define this one table and ignores
 * everything else (other tables, `ANALYZE`, data backfills). `ANALYZE`
 * in particular is a caller concern — statistics are only meaningful
 * after the caller has seeded representative rows.
 */
export function lookalikeSchema(): LookalikeSchema {
  const ddl: string[] = [];
  const indexes: string[] = [];
  const sources: string[] = [];

  for (const { name, sql } of allMigrations()) {
    let used = false;
    for (const stmt of statements(sql)) {
      const isCreateTable = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?lookalike_domains\s*\(/i.test(stmt);
      const isAddColumn = /^ALTER\s+TABLE\s+lookalike_domains\s+ADD\s+COLUMN\s+/i.test(stmt);
      const isCreateIndex = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+lookalike_domains\s*\(/i.test(stmt);
      if (!isCreateTable && !isAddColumn && !isCreateIndex) continue;
      ddl.push(`${stmt};`);
      if (isCreateIndex) indexes.push(`${stmt};`);
      used = true;
    }
    if (used) sources.push(name);
  }

  // Guards against a silent path / regex failure making a caller's
  // schema vacuously empty (which would turn "no such column" back into
  // "no such table" and be just as uninformative).
  if (!ddl.some((s) => /^CREATE\s+TABLE/i.test(s))) {
    throw new Error("lookalikeSchema: no CREATE TABLE lookalike_domains found in migrations/");
  }
  if (ddl.length < 15) {
    throw new Error(`lookalikeSchema: only ${ddl.length} statements extracted — extraction is probably broken`);
  }

  return { ddl, sources, indexes };
}

/**
 * Apply the derived `lookalike_domains` schema to a fresh in-memory DB
 * and return the column names SQLite ended up with.
 *
 * The returned column list is itself useful as an assertion target: it
 * is the table's REAL column set, so a test can prove a query's columns
 * are a subset of it without trusting either side's prose.
 */
export function applyLookalikeSchema(db: ExecutableDb): { columns: string[]; ddl: string[] } {
  const schema = lookalikeSchema();
  for (const stmt of schema.ddl) db.exec(stmt);
  return { columns: lookalikeColumns(), ddl: schema.ddl };
}

/**
 * The table's column names, parsed from the same derived DDL.
 *
 * Parsed rather than read back via `PRAGMA table_info` so this works
 * without a live database (the reports test uses it to assert that the
 * agents' SELECT lists name only real columns).
 */
export function lookalikeColumns(): string[] {
  const { ddl } = lookalikeSchema();
  const cols: string[] = [];

  const create = ddl.find((s) => /^CREATE\s+TABLE/i.test(s))!;
  const body = create.slice(create.indexOf("(") + 1, create.lastIndexOf(")"));
  for (const line of body.split("\n")) {
    const m = line.trim().match(/^([a-z_][a-z0-9_]*)\s+[A-Z]/);
    if (m && !["unique", "primary", "foreign", "check"].includes(m[1]!.toLowerCase())) {
      cols.push(m[1]!.toLowerCase());
    }
  }
  for (const stmt of ddl) {
    const m = stmt.match(/^ALTER\s+TABLE\s+lookalike_domains\s+ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/i);
    if (m) cols.push(m[1]!.toLowerCase());
  }
  return cols;
}
