/**
 * The `nrd_domains` writer, shared by feeds/nrd_hagezi.ts (ingest) and
 * lib/nrd-archive-backcheck.ts (archive hits for domains seeded later).
 * Kept out of the feed module so the back-check — called from the phantom
 * enumerator, which must not pull in anything that writes `threats` — does
 * not import the feed (and its bulkInsertThreats path).
 */

import { logger } from "./logger";

/** Key prefix of the daily archive objects in the NRD_ARCHIVE R2 bucket. */
export const NRD_ARCHIVE_PREFIX = "daily/";

/**
 * Domains per INSERT statement in storeNrdReference. The rows travel as ONE
 * JSON-array bind expanded server-side by `json_each(?)`, so each statement
 * binds exactly 2 parameters regardless of row count — D1 caps a statement
 * at 100 bound parameters (the old `VALUES (?, ?)×500` form bound 1000 and
 * every pull died with "too many SQL variables at offset 418"). 1000 NRDs
 * ≈ 25–30 KB of JSON: far under D1's 2 MB value cap and its 100 KB SQL-text
 * cap (the JSON is a bound value, not SQL text).
 */
export const NRD_DOMAINS_PER_STATEMENT = 1000;

/**
 * Statements per `db.batch()` call. One batch = one D1 round-trip (one
 * subrequest) and one implicit transaction: 20 × 1000 = 20K rows/call, so a
 * ~443K-domain day is ~23 calls.
 */
export const NRD_STATEMENTS_PER_BATCH = 20;

/**
 * The nrd_domains insert, with the matchable filter IN the statement: a
 * domain lands only if it equals a lookalike_domains or phantom_domains
 * domain — the matchers' own join predicates (`l.domain = n.domain`,
 * `t.domain = p.domain`), evaluated by SQLite on the same columns, so the
 * filter cannot drift from them. Each EXISTS is a covering-index SEARCH on
 * idx_lookalike_domain / idx_phantom_domain (pinned by EXPLAIN QUERY PLAN in
 * test/nrd-hagezi-matchable.test.ts). No status filter on either side:
 * neither join filters lookalike rows, and the phantom matcher applies
 * `status = 'predicted'` at match time, so any phantom's domain is kept.
 * Binds: registered_date, then the JSON array (2 per statement).
 * json_each yields rows in array order, so in-statement duplicates resolve
 * first-wins under OR IGNORE. Exported for the plan pin.
 */
export const NRD_INSERT_SQL =
  `INSERT OR IGNORE INTO nrd_domains (domain, registered_date)
   SELECT j.value, ? FROM json_each(?) AS j
    WHERE EXISTS (SELECT 1 FROM lookalike_domains l WHERE l.domain = j.value)
       OR EXISTS (SELECT 1 FROM phantom_domains p WHERE p.domain = j.value)`;

/**
 * Store the MATCHABLE subset of `domains` (see NRD_INSERT_SQL) in the
 * reference table read by the phantom matcher and the NRD <-> lookalike
 * matcher; the full day is in the R2 archive. INSERT OR IGNORE keeps re-runs
 * (and in-list duplicates) idempotent: the first registered_date written for
 * a domain wins. Returns the rows actually inserted (sum of meta.changes).
 *
 * Used by feeds/nrd_hagezi.ts and lib/nrd-archive-backcheck.ts.
 */
export async function storeNrdReference(db: D1Database, domains: string[], date: string): Promise<number> {
  if (domains.length === 0) return 0;
  // Ensure reference table exists
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS nrd_domains (
      domain TEXT PRIMARY KEY,
      registered_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      brand_matched INTEGER DEFAULT 0
    )
  `).run();

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < domains.length; i += NRD_DOMAINS_PER_STATEMENT) {
    const chunk = domains.slice(i, i + NRD_DOMAINS_PER_STATEMENT);
    stmts.push(db.prepare(NRD_INSERT_SQL).bind(date, JSON.stringify(chunk)));
  }
  let stored = 0;
  for (let i = 0; i < stmts.length; i += NRD_STATEMENTS_PER_BATCH) {
    const out = await db.batch(stmts.slice(i, i + NRD_STATEMENTS_PER_BATCH));
    for (const r of out) stored += Number(r.meta?.changes ?? 0);
  }

  logger.info("nrd_reference_stored", { domains: domains.length, stored, date, statements: stmts.length });
  return stored;
}

