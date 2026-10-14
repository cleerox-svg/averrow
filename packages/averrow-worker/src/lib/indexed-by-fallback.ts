/**
 * Fail-soft wrapper for queries that pin a partial index with `INDEXED BY`.
 *
 * The hint is a cost optimisation (D1 read-spend fix, 2026-10-14: the planner
 * prefers an `ip_address > ?` range on idx_threats_ip_source_feed over the
 * small partial indexes). It must never cost correctness or availability:
 * SQLite turns a missing/renamed index into "no such index" and a WHERE that
 * stops implying a partial index's predicate into "no query solution" — both
 * hard errors. On exactly those two errors the same query is retried without
 * the hint, so the number stays correct (just expensive). Any other error
 * propagates unchanged.
 */

const INDEXED_BY_HINT = /\s+INDEXED\s+BY\s+[A-Za-z_][A-Za-z0-9_]*/gi;

/** The query with every `INDEXED BY <index>` hint removed. */
export function stripIndexedBy(sql: string): string {
  return sql.replace(INDEXED_BY_HINT, "");
}

/** True for the two errors an unusable `INDEXED BY` hint produces. */
export function isIndexHintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such index|no query solution/i.test(msg);
}

/**
 * Run `sql`; if it fails only because its `INDEXED BY` hint is unusable,
 * re-run it with the hint stripped.
 */
export async function withIndexHintFallback<T>(sql: string, run: (sql: string) => Promise<T>): Promise<T> {
  try {
    return await run(sql);
  } catch (err) {
    const unhinted = stripIndexedBy(sql);
    if (unhinted === sql || !isIndexHintError(err)) throw err;
    return run(unhinted);
  }
}
