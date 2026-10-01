/**
 * Shared harness for the silent-AI-failure test lanes.
 *
 * Follows the `node:sqlite` DatabaseSync lane established by
 * `geo-exhaustion-and-diag-folds.test.ts` (built into Node 22 — no new
 * devDependency), with two differences that are the whole point of this
 * guard's tests:
 *
 *   1. The schema comes from `migration-schema.ts`, i.e. it is DERIVED from
 *      `migrations/`, so a query naming a column that does not exist fails
 *      with "no such column" instead of being quietly accommodated.
 *   2. Every statement is LOGGED with its outcome. Flight Control wraps the
 *      check in a mandatory try/catch, which means a throwing query and a
 *      correctly-silent query are indistinguishable from the outside — both
 *      emit nothing. A negative assertion ("did not emit") is therefore only
 *      meaningful alongside proof that the query ran and returned zero
 *      qualifying rows. The log is how a test proves that.
 */

import { createRequire } from "node:module";
import { deriveSchema } from "./migration-schema";

type SqliteStatement = {
  all(...p: unknown[]): unknown[];
  run(...p: unknown[]): { changes?: number | bigint };
};
export type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
};
type SqliteCtor = new (path: string) => SqliteDb;

// Resolved SYNCHRONOUSLY at collection time so `describe.skipIf` sees it
// (same reasoning as geo-exhaustion-and-diag-folds.test.ts).
const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: SqliteCtor | null = null;
try {
  DatabaseSync = (nodeRequire("node:sqlite") as { DatabaseSync: SqliteCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}
export const hasSqlite = (): boolean => DatabaseSync !== null;

/** Fresh in-memory DB with the migration-derived shape of `tables`. */
export function openDerivedDb(tables: string[]): SqliteDb {
  const db = new DatabaseSync!(":memory:");
  // The derived schema contains only the tables under test; the real
  // schema's FKs point at tables that are deliberately not materialised.
  db.exec("PRAGMA foreign_keys = OFF");
  for (const stmt of deriveSchema(tables).ddl) db.exec(stmt);
  return db;
}

export interface StatementLogEntry {
  sql: string;
  /** Present when SQLite rejected the statement. */
  error?: string;
  /** Row count for SELECTs. */
  rows?: number;
  /** True when a lenient policy turned a failure into an empty result. */
  swallowed?: boolean;
}

export interface D1Options {
  /**
   * Called when SQLite rejects a statement. Return true to answer with an
   * empty result instead of throwing (used ONLY for tables that are outside
   * the unit under test). Default: never — errors propagate.
   */
  swallow?: (sql: string, error: Error) => boolean;
  log?: StatementLogEntry[];
}

/** Just enough of D1Database for the code under test. */
export function d1FromSqlite(raw: SqliteDb, opts: D1Options = {}): D1Database {
  const log = opts.log ?? [];
  const exec = (sql: string, bound: unknown[], kind: "read" | "write"): { rows: unknown[]; changes: number } => {
    try {
      if (kind === "read") {
        const rows = raw.prepare(sql).all(...bound);
        log.push({ sql, rows: rows.length });
        return { rows, changes: 0 };
      }
      const r = raw.prepare(sql).run(...bound);
      log.push({ sql });
      return { rows: [], changes: Number(r.changes ?? 0) };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (opts.swallow?.(sql, e)) {
        log.push({ sql, error: e.message, swallowed: true });
        return { rows: [], changes: 0 };
      }
      log.push({ sql, error: e.message });
      throw e;
    }
  };

  const make = (sql: string, bound: unknown[]): D1PreparedStatement =>
    ({
      bind: (...args: unknown[]) => make(sql, args),
      all: async () => ({ results: exec(sql, bound, "read").rows, success: true, meta: {} }),
      first: async (col?: string) => {
        const rows = exec(sql, bound, "read").rows as Array<Record<string, unknown>>;
        if (rows.length === 0) return null;
        return col ? rows[0]![col] : rows[0];
      },
      run: async () => {
        const { changes } = exec(sql, bound, "write");
        return { results: [], success: true, meta: { changes } };
      },
      raw: async () => [],
      // Exposed so `batch` can dispatch reads and writes correctly.
      __sql: sql,
      __bound: bound,
    }) as unknown as D1PreparedStatement;

  return {
    prepare: (sql: string) => make(sql, []),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

/** In-memory KVNamespace (get/put/delete are all the code under test uses). */
export function fakeKv(seed: Record<string, string> = {}): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

/** `YYYY-MM-DD HH:MM:SS` UTC, N hours ago — the format SQLite's datetime() emits. */
export function sqliteTimestampHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Pull the one template literal in `src` that contains every marker.
 * Extracting rather than retyping is the point: the test runs the query the
 * agent actually issues, so a reworded or broken query changes what is
 * tested instead of silently falling out of coverage. Asserts exactly one
 * match so an ambiguous marker set is a failure, not a silent wrong pick.
 */
export function sqlContaining(src: string, markers: string[]): string {
  const literals = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);
  const hits = literals.filter((t) => markers.every((mk) => t.includes(mk)));
  if (hits.length !== 1) {
    throw new Error(`sqlContaining: expected exactly 1 template literal matching [${markers.join(" + ")}], found ${hits.length}`);
  }
  if (/\$\{/.test(hits[0]!)) {
    throw new Error("sqlContaining: unsubstituted interpolation in extracted SQL");
  }
  return hits[0]!;
}
