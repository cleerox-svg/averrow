/**
 * Live index DDL for a table, replayed from `migrations/` — the index-side
 * companion to `migration-schema.ts` (which deliberately ignores indexes).
 *
 * Query-plan pins (EXPLAIN QUERY PLAN) are only meaningful against the
 * index set production actually has: an index created in one migration may
 * be dropped in a later one (e.g. 0200 dropped three threats DNS indexes),
 * and a plan test that materialises a dropped index would pin a plan prod
 * can never pick. Replays every `CREATE [UNIQUE] INDEX [IF NOT EXISTS] … ON
 * <table>` and `DROP INDEX [IF EXISTS]` in file order and returns the
 * surviving CREATE statements (first definition wins, matching
 * `IF NOT EXISTS` semantics).
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitStatements } from "./migration-schema";

const MIGRATIONS_DIR = resolve(__dirname, "..", "migrations");

export function liveIndexDdl(table: string): Map<string, string> {
  const live = new Map<string, string>();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of splitStatements(sql)) {
      const c = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+ON\s+["'`]?(\w+)["'`]?/i.exec(stmt);
      if (c) {
        if (c[2] === table && !live.has(c[1]!)) {
          live.set(c[1]!, stmt.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?/i, "CREATE $1INDEX IF NOT EXISTS "));
        }
        continue;
      }
      const d = /^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i.exec(stmt);
      if (d) live.delete(d[1]!);
    }
  }
  return live;
}
