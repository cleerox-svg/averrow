/**
 * Table DDL derived from the migration files — a general-purpose sibling of
 * `lookalike-schema.ts`.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * A hand-written `CREATE TABLE` inside a test can only be edited to match
 * the query under test; it can never fail on a column that does not exist.
 * For the silent-AI-failure guard that matters directly: the Flight Control
 * check reads `json_extract(details, ...)` out of `agent_outputs` and
 * `MAX(created_at)` out of `budget_ledger`, and a typo'd or renamed column
 * in either query is swallowed by FC's mandatory try/catch — i.e. it leaves
 * the alert permanently dead, which is the exact defect class the fix exists
 * to remove. Deriving the schema from `migrations/` makes a phantom column a
 * test FAILURE ("no such column") instead of a quiet accommodation.
 *
 * ── What it simulates ───────────────────────────────────────────────
 *
 * Migrations are replayed in file order, tracking only table *shape*:
 *   - `CREATE TABLE [IF NOT EXISTS] t (...)`
 *   - `ALTER TABLE t ADD COLUMN ...` (and RENAME COLUMN / DROP COLUMN)
 *   - `DROP TABLE t`
 *   - `ALTER TABLE a RENAME TO b`
 * The last two matter: `agent_outputs` is rebuilt by the CHECK-widening
 * "create _v3, copy, drop, rename" dance (0009 → 0061), so the live shape is
 * the `_v3` definition renamed, not the 0003 original. Replaying the dance
 * is the only way to land on the shape production actually has.
 *
 * Data statements (INSERT/UPDATE), indexes and triggers are ignored: the
 * tests seed their own rows, and query plans are not under test.
 *
 * Directory scan, not a hand-listed set, so a migration added later is
 * picked up automatically.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(__dirname, "..", "migrations");

/**
 * Split SQL into statements, honouring `'...'` string literals and `--`
 * comments (a comment may legitimately contain a `;`, and a string may
 * contain `--`). `CREATE TRIGGER ... BEGIN ... END;` bodies contain
 * semicolons of their own, so a trigger is consumed through its `END;`.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let inTrigger = false;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (ch === ";") {
      if (inTrigger && !/\bEND\s*$/i.test(cur)) { cur += ch; i++; continue; }
      const stmt = cur.trim();
      if (stmt) out.push(stmt);
      cur = "";
      inTrigger = false;
      i++;
      continue;
    }
    cur += ch;
    i++;
    if (!inTrigger && /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(cur) && /\bBEGIN\s*$/i.test(cur)) {
      inTrigger = true;
    }
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

interface TableState {
  create: string;
  alters: string[];
}

export interface DerivedSchema {
  /** DDL in dependency-free replay order, ready to `exec`. */
  ddl: string[];
  /** Column names SQLite will report, parsed from the derived DDL. */
  columns: Record<string, string[]>;
  /** Migration files that contributed to each table's final shape. */
  sources: Record<string, string[]>;
}

const IDENT = String.raw`["'\`]?([A-Za-z_][A-Za-z0-9_]*)["'\`]?`;

/**
 * Derive the live shape of `tables` from every migration, in order.
 * Throws if a requested table is never created (a vacuous schema would turn
 * "no such column" back into "no such table").
 */
export function deriveSchema(tables: string[]): DerivedSchema {
  const state = new Map<string, TableState>();
  const touchedBy = new Map<string, Set<string>>();
  const note = (table: string, file: string): void => {
    if (!touchedBy.has(table)) touchedBy.set(table, new Set());
    touchedBy.get(table)!.add(file);
  };

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of splitStatements(sql)) {
      let m = new RegExp(String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s*\(`, "i").exec(stmt);
      if (m) {
        const name = m[1]!;
        if (!state.has(name)) {
          state.set(name, { create: stmt, alters: [] });
          note(name, file);
        }
        continue;
      }
      m = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENT}\s*$`, "i").exec(stmt);
      if (m) {
        state.delete(m[1]!);
        touchedBy.delete(m[1]!);
        continue;
      }
      m = new RegExp(String.raw`^ALTER\s+TABLE\s+${IDENT}\s+RENAME\s+TO\s+${IDENT}\s*$`, "i").exec(stmt);
      if (m) {
        const from = m[1]!;
        const to = m[2]!;
        const st = state.get(from);
        if (st) {
          // Re-point the CREATE and every accumulated ALTER at the new name.
          const rename = (s: string): string =>
            s.replace(new RegExp(String.raw`(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)["'\`]?${from}["'\`]?`, "i"), `$1${to}`)
             .replace(new RegExp(String.raw`(ALTER\s+TABLE\s+)["'\`]?${from}["'\`]?`, "i"), `$1${to}`);
          state.set(to, { create: rename(st.create), alters: st.alters.map(rename) });
          state.delete(from);
          const src = touchedBy.get(from) ?? new Set<string>();
          src.add(file);
          touchedBy.set(to, src);
          touchedBy.delete(from);
        }
        continue;
      }
      m = new RegExp(String.raw`^ALTER\s+TABLE\s+${IDENT}\s+(?:ADD\s+COLUMN|RENAME\s+COLUMN|DROP\s+COLUMN)\b`, "i").exec(stmt);
      if (m) {
        const st = state.get(m[1]!);
        if (st) {
          st.alters.push(stmt);
          note(m[1]!, file);
        }
      }
    }
  }

  const ddl: string[] = [];
  const columns: Record<string, string[]> = {};
  const sources: Record<string, string[]> = {};
  for (const t of tables) {
    const st = state.get(t);
    if (!st) throw new Error(`deriveSchema: table "${t}" is never created in migrations/ (or was dropped without being re-created)`);
    ddl.push(`${st.create};`, ...st.alters.map((a) => `${a};`));
    columns[t] = parseColumns(st);
    sources[t] = [...(touchedBy.get(t) ?? [])];
  }
  return { ddl, columns, sources };
}

function parseColumns(st: TableState): string[] {
  const cols: string[] = [];
  const body = st.create.slice(st.create.indexOf("(") + 1, st.create.lastIndexOf(")"));
  // Top-level comma split (CHECK (x IN ('a','b')) contains commas of its own).
  let depth = 0;
  let cur = "";
  const parts: string[] = [];
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    const m = /^\s*["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s+[A-Za-z]/.exec(p);
    if (m && !["unique", "primary", "foreign", "check", "constraint"].includes(m[1]!.toLowerCase())) {
      cols.push(m[1]!.toLowerCase());
    }
  }
  for (const a of st.alters) {
    const add = /ADD\s+COLUMN\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(a);
    if (add) cols.push(add[1]!.toLowerCase());
  }
  return cols;
}
