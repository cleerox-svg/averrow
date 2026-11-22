// Averrow — bounded per-table row estimates for one D1 database
//
// Shared by the d1-health diagnostic (handlers/d1-health.ts) and the daily
// database inventory (lib/db-inventory.ts). Never a full scan:
//   - table list from sqlite_master (tiny);
//   - sqlite_stat1's leading number per table (as fresh as the last ANALYZE);
//   - MAX(rowid) per rowid table — a b-tree seek to the last row, one row read,
//     an upper bound that overshoots after deletes;
//   - an exact COUNT(*) only for a table provably small (MAX(rowid) under
//     EXACT_COUNT_MAX_ROWS, or a WITHOUT ROWID table whose stat is under
//     EXACT_COUNT_NO_ROWID_MAX_ROWS), within a cumulative row budget.
// Every read is sequential and individually non-fatal: a failed read is
// counted in `readErrors` and the field it fed is null.

/** Exact COUNT(*) only when a rowid table's MAX(rowid) is below this. */
export const EXACT_COUNT_MAX_ROWS = 100_000;
/**
 * WITHOUT ROWID tables have no MAX(rowid) upper bound — the only bound is the
 * sqlite_stat1 estimate, which is as stale as the last ANALYZE and may
 * undercount badly. So the exact count there gets a much smaller cap.
 */
export const EXACT_COUNT_NO_ROWID_MAX_ROWS = 10_000;
/** Cumulative upper-bound rows all exact counts in one compute may scan. */
export const EXACT_COUNT_ROW_BUDGET = 1_000_000;
/** stat1 below max_rowid / this → `estimate_divergent` (stat1 is likely stale). */
export const ESTIMATE_DIVERGENCE_FACTOR = 2;

/** Identifiers are interpolated (they cannot be bound) — only plain names. */
const SAFE_IDENT = /^[A-Za-z0-9_]+$/;

export type EstimateSource = "count" | "sqlite_stat1" | "max_rowid" | null;

export interface TableRow {
  name: string;
  /**
   * Row count: EXACT when `rows_exact` is true, otherwise the estimate
   * (`rows_estimate`, or 0 when nothing could be estimated). Sorted and
   * summed on this. Kept for the d1_health MCP tool.
   */
  rows: number;
  /**
   * For a rowid table the LARGER of sqlite_stat1 and MAX(rowid) (stat1 is
   * only as fresh as the last ANALYZE; MAX(rowid) is an upper bound that
   * overshoots after deletes). WITHOUT ROWID: stat1 only. null = unknown.
   */
  rows_estimate: number | null;
  rows_exact: boolean;
  /** Where `rows` came from. */
  estimate_source: EstimateSource;
  /** sqlite_stat1 leading number (per-table max over its indexes); null = none. */
  stat_rows: number | null;
  /** MAX(rowid) — an upper bound on the row count for rowid tables; null otherwise. */
  max_rowid: number | null;
  /** stat_rows < max_rowid / ESTIMATE_DIVERGENCE_FACTOR — stat1 is likely stale. */
  estimate_divergent: boolean;
}

export interface ReadDb {
  prepare: D1Database["prepare"];
}

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Leading integer of a sqlite_stat1 `stat` string ("12345 3 1" → 12345). */
export function statLeadingRows(stat: unknown): number | null {
  if (typeof stat !== "string") return null;
  const m = /^\s*(\d+)/.exec(stat);
  return m ? Number(m[1]) : null;
}

/** Sequential, non-fatal read helpers that count their own failures. */
export function safeReader(db: ReadDb): {
  first: <T>(sql: string) => Promise<T | null>;
  all: <T>(sql: string) => Promise<T[]>;
  errors: () => number;
  countError: () => void;
} {
  let readErrors = 0;
  return {
    first: async <T>(sql: string): Promise<T | null> => {
      try {
        return await db.prepare(sql).first<T>();
      } catch {
        readErrors += 1;
        return null;
      }
    },
    all: async <T>(sql: string): Promise<T[]> => {
      try {
        return (await db.prepare(sql).all<T>()).results;
      } catch {
        readErrors += 1;
        return [];
      }
    },
    errors: () => readErrors,
    countError: () => { readErrors += 1; },
  };
}

type Reader = ReturnType<typeof safeReader>;

/** User tables (name + DDL), sqlite_ / _cf_ internals excluded. */
export function listUserTables(r: Reader): Promise<Array<{ name: string; sql: string | null }>> {
  return r.all<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name");
}

/**
 * Row estimates for `tables` (from listUserTables), sorted by `rows` desc.
 * Reads sqlite_stat1 once, then per table at most a MAX(rowid) seek and one
 * bounded COUNT(*).
 */
export async function estimateTableRows(
  r: Reader,
  tables: ReadonlyArray<{ name: string; sql: string | null }>,
): Promise<TableRow[]> {
  // sqlite_stat1: one row per analysed index (idx NULL = table-only stat);
  // the leading number is the rows the index covers. A partial index covers
  // fewer, so the per-table MAX is the table's stat.
  const statRows = new Map<string, number>();
  for (const s of await r.all<{ tbl: string; stat: string }>("SELECT tbl, stat FROM sqlite_stat1")) {
    const n = statLeadingRows(s.stat);
    if (n != null) statRows.set(s.tbl, Math.max(statRows.get(s.tbl) ?? 0, n));
  }

  const out: TableRow[] = [];
  let countBudget = EXACT_COUNT_ROW_BUDGET;
  for (const t of tables) {
    if (!SAFE_IDENT.test(t.name)) continue;
    const ddl = (t.sql ?? "").toUpperCase();
    const isVirtual = ddl.startsWith("CREATE VIRTUAL TABLE");
    const hasRowid = !isVirtual && !/WITHOUT\s+ROWID/.test(ddl);

    // MAX(rowid) is a b-tree seek to the last row — one row read.
    const maxRowidRow = hasRowid
      ? await r.first<{ m: number | null }>(`SELECT MAX(rowid) AS m FROM "${t.name}"`)
      : null;
    const maxRowid = finite(maxRowidRow?.m);
    // The query answered with NULL → the table is empty.
    const knownEmpty = maxRowidRow != null && maxRowidRow.m == null;
    const rowidRows = maxRowid != null ? Math.max(0, maxRowid) : knownEmpty ? 0 : null;
    const stat = statRows.get(t.name) ?? null;

    // Larger of the two: a stale stat1 must not hide a table's real size.
    let estimate: number | null;
    let source: EstimateSource;
    if (stat != null && (rowidRows == null || stat >= rowidRows)) {
      estimate = stat;
      source = "sqlite_stat1";
    } else if (rowidRows != null) {
      estimate = rowidRows;
      source = "max_rowid";
    } else {
      estimate = null;
      source = null;
    }
    const divergent = stat != null && maxRowid != null && stat < maxRowid / ESTIMATE_DIVERGENCE_FACTOR;

    // Exact COUNT gate. Rowid table: MAX(rowid) is a true upper bound.
    // WITHOUT ROWID: only the stat, which may be stale — far smaller cap.
    const bound = hasRowid ? rowidRows : stat;
    const cap = hasRowid ? EXACT_COUNT_MAX_ROWS : EXACT_COUNT_NO_ROWID_MAX_ROWS;
    let exact: number | null = null;
    if (!isVirtual && bound != null && bound < cap && bound <= countBudget) {
      countBudget -= bound;
      exact = finite((await r.first<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t.name}"`))?.n);
    }
    out.push({
      name: t.name,
      rows: exact ?? estimate ?? 0,
      rows_estimate: estimate,
      rows_exact: exact != null,
      estimate_source: exact != null ? "count" : source,
      stat_rows: stat,
      max_rowid: maxRowid,
      estimate_divergent: divergent,
    });
  }
  out.sort((a, b) => b.rows - a.rows);
  return out;
}
