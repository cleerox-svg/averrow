// Averrow — D1 Health Handler
//
// Focused database-level diagnostic. Designed for programmatic
// consumption (MCP tool, ops scripts) when investigating storage
// growth, query slowness, or schema drift. All queries are read-only.
//
// What's queryable from a Worker context:
//   - Page size + page count → database size in bytes
//   - sqlite_master → table / index counts and shapes
//   - Per-table row ESTIMATES (sqlite_stat1 / MAX(rowid)); an exact
//     COUNT(*) only for tables provably under EXACT_COUNT_MAX_ROWS
//   - PRAGMA foreign_keys → enforcement state (we relied on this
//     for migration 0112's defer trick)
//   - PRAGMA foreign_key_check → broken FK count, GATED behind a
//     query param because it's an O(rows × FKs) scan
//   - d1_migrations → applied migration count + latest name
//   - Sample query latencies on primary-key probes
//
// D1 safety (v2, 2026-11): v1 COUNT(*)-ed every table in one Promise.all
// (threats ~1.65M rows) and benchmarked a threats ORDER BY — on its own it
// could spend D1's 10 s overload window. Now every read is sequential and
// bounded, and the whole response is KV-cached 10 min (cachedValue,
// single-flight). A degraded snapshot (failed reads) is cached 60 s, or not
// at all when the table list came back empty.
//
// What requires CF API access (NOT in this endpoint):
//   - Replica lag, billing tier, throttle status — surfaced by
//     platform-diagnostics's d1_metrics_24h block from PR #834

import { json } from "../lib/cors";
import { cachedValue } from "../lib/cached-value";
import { getDbContext, getReadSession } from "../lib/db";
import type { Env } from "../types";

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
/** More failed reads than this → degraded snapshot (short cache). */
export const D1_HEALTH_MAX_READ_ERRORS = 3;
export const D1_HEALTH_TTL_S = 600;
export const D1_HEALTH_DEGRADED_TTL_S = 60;
export const D1_HEALTH_CACHE_KEY_PREFIX = "d1_health.v2";

/** Identifiers are interpolated (they cannot be bound) — only plain names. */
const SAFE_IDENT = /^[A-Za-z0-9_]+$/;

type EstimateSource = "count" | "sqlite_stat1" | "max_rowid" | null;

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

interface ReadDb {
  prepare: D1Database["prepare"];
}

interface FkCheck {
  enabled: boolean;
  checked: boolean;
  violations: number;
  sample: Array<{ table: string; rowid: number; parent: string; fkid: number }>;
}

export interface D1HealthData {
  _meta: { generated_at: string; endpoint_version: number; cache_ttl_seconds: number };
  /** Reads that threw during this compute (a refused PRAGMA, a missing sqlite_stat1, an overload). */
  read_errors: number;
  database: {
    size_bytes: number | null;
    size_mb: number | null;
    page_size_bytes: number | null;
    page_count: number | null;
    schema_version: number | null;
    fk_enforcement_on: boolean | null;
  };
  inventory: {
    table_count: number;
    index_count: number;
    partial_index_count: number;
    /** Sum of `rows` — mixes exact counts and estimates. */
    total_rows: number;
    /** Tables whose `rows` is an estimate, not a COUNT(*). */
    estimated_table_count: number;
    top_tables_by_rows: TableRow[];
  };
  migrations: { applied_count: number; latest: string | null };
  fk_check: FkCheck;
  query_latency: {
    trivial_select_1_ms: number | null;
    brands_pk_probe_ms: number | null;
    threats_pk_probe_ms: number | null;
    /** Deprecated (v2): the brands COUNT(*) benchmark is gone; always null. */
    brands_count_ms: null;
    /** Deprecated (v2): the threats ORDER BY benchmark is gone; always null. */
    threats_recent_10_ms: null;
    total_bench_ms: number;
  };
}

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Leading integer of a sqlite_stat1 `stat` string ("12345 3 1" → 12345). */
export function statLeadingRows(stat: unknown): number | null {
  if (typeof stat !== "string") return null;
  const m = /^\s*(\d+)/.exec(stat);
  return m ? Number(m[1]) : null;
}

/** How long a snapshot may be cached: full, short (degraded), or 0 = don't write. */
export function d1HealthTtlFor(data: D1HealthData): number {
  if (data.inventory.table_count === 0) return 0;
  if (data.database.size_bytes == null || data.read_errors > D1_HEALTH_MAX_READ_ERRORS) {
    return D1_HEALTH_DEGRADED_TTL_S;
  }
  return D1_HEALTH_TTL_S;
}

/** The uncached computation. Every read is sequential and bounded. */
export async function computeD1Health(db: ReadDb, checkFk: boolean): Promise<D1HealthData> {
  let readErrors = 0;
  const safeFirst = async <T>(sql: string): Promise<T | null> => {
    try {
      return await db.prepare(sql).first<T>();
    } catch {
      readErrors += 1;
      return null;
    }
  };
  const safeAll = async <T>(sql: string): Promise<T[]> => {
    try {
      return (await db.prepare(sql).all<T>()).results;
    } catch {
      readErrors += 1;
      return [];
    }
  };
  /** Timed run of one read; null (and counted) when it failed. */
  const timed = async (fn: () => Promise<unknown>): Promise<number | null> => {
    const t = Date.now();
    try {
      await fn();
      return Date.now() - t;
    } catch {
      readErrors += 1;
      return null;
    }
  };

  // ─── Page geometry → database size ────────────────────────────
  // D1 restricts some PRAGMAs (SQLITE_AUTH) — each is non-fatal.
  const pageSize = await safeFirst<{ page_size: number }>("PRAGMA page_size");
  const pageCount = await safeFirst<{ page_count: number }>("PRAGMA page_count");
  const schemaVersion = await safeFirst<{ schema_version: number }>("PRAGMA schema_version");
  const fkPragma = await safeFirst<{ foreign_keys: number }>("PRAGMA foreign_keys");

  const ps = finite(pageSize?.page_size);
  const pc = finite(pageCount?.page_count);
  const sizeBytes = ps != null && pc != null ? ps * pc : null;

  // ─── Table + index inventory (sqlite_master is tiny) ──────────
  const tables = await safeAll<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name");
  const indexes = await safeFirst<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'");
  const partialIndexes = await safeFirst<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND sql LIKE '%WHERE%'");

  // ─── Row estimates ────────────────────────────────────────────
  // sqlite_stat1: one row per analysed index (idx NULL = table-only stat);
  // the leading number is the rows the index covers. A partial index covers
  // fewer, so the per-table MAX is the table's stat.
  const statRows = new Map<string, number>();
  for (const r of await safeAll<{ tbl: string; stat: string }>("SELECT tbl, stat FROM sqlite_stat1")) {
    const n = statLeadingRows(r.stat);
    if (n != null) statRows.set(r.tbl, Math.max(statRows.get(r.tbl) ?? 0, n));
  }

  const tableRows: TableRow[] = [];
  let countBudget = EXACT_COUNT_ROW_BUDGET;
  for (const t of tables) {
    if (!SAFE_IDENT.test(t.name)) continue;
    const ddl = (t.sql ?? "").toUpperCase();
    const isVirtual = ddl.startsWith("CREATE VIRTUAL TABLE");
    const hasRowid = !isVirtual && !/WITHOUT\s+ROWID/.test(ddl);

    // MAX(rowid) is a b-tree seek to the last row — one row read.
    const maxRowidRow = hasRowid
      ? await safeFirst<{ m: number | null }>(`SELECT MAX(rowid) AS m FROM "${t.name}"`)
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
      exact = finite((await safeFirst<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t.name}"`))?.n);
    }
    tableRows.push({
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
  tableRows.sort((a, b) => b.rows - a.rows);

  // ─── Migrations (small table) ─────────────────────────────────
  const migrationCount = await safeFirst<{ n: number }>("SELECT COUNT(*) AS n FROM d1_migrations");
  const latestMigration = await safeFirst<{ name: string }>("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1");

  // ─── Sample query latency: primary-key probes only ───────────
  // A bound id that never exists — one index seek, zero rows returned.
  const benchStart = Date.now();
  const trivialMs = await timed(() => db.prepare("SELECT 1 AS n").first());
  const brandsProbeMs = await timed(() =>
    db.prepare("SELECT id FROM brands WHERE id = ? LIMIT 1").bind("__d1_health_probe__").first());
  const threatsProbeMs = await timed(() =>
    db.prepare("SELECT id FROM threats WHERE id = ? LIMIT 1").bind("__d1_health_probe__").first());
  const totalBenchMs = Date.now() - benchStart;

  // ─── FK violations (optional, gated) ─────────────────────────
  const fkEnabled = fkPragma != null ? (fkPragma.foreign_keys ?? 0) === 1 : null;
  let fkCheck: FkCheck = { enabled: fkEnabled ?? false, checked: false, violations: 0, sample: [] };
  if (checkFk) {
    try {
      const fkRows = await db.prepare("PRAGMA foreign_key_check").all<{
        table: string; rowid: number; parent: string; fkid: number;
      }>();
      fkCheck = {
        enabled: fkEnabled ?? false,
        checked: true,
        violations: fkRows.results.length,
        sample: fkRows.results.slice(0, 10),
      };
    } catch {
      // Best-effort — don't surface internals.
      readErrors += 1;
    }
  }

  const out: D1HealthData = {
    _meta: { generated_at: new Date().toISOString(), endpoint_version: 2, cache_ttl_seconds: D1_HEALTH_TTL_S },
    read_errors: readErrors,
    database: {
      // Fields may be null when D1 restricts the PRAGMA — expected.
      size_bytes: sizeBytes,
      size_mb: sizeBytes != null ? Math.round((sizeBytes / 1024 / 1024) * 10) / 10 : null,
      page_size_bytes: ps,
      page_count: pc,
      schema_version: finite(schemaVersion?.schema_version),
      fk_enforcement_on: fkEnabled,
    },
    inventory: {
      table_count: tableRows.length,
      index_count: indexes?.n ?? 0,
      partial_index_count: partialIndexes?.n ?? 0,
      total_rows: tableRows.reduce((s, t) => s + t.rows, 0),
      estimated_table_count: tableRows.filter((t) => !t.rows_exact).length,
      top_tables_by_rows: tableRows,
    },
    migrations: {
      applied_count: migrationCount?.n ?? 0,
      latest: latestMigration?.name ?? null,
    },
    fk_check: fkCheck,
    query_latency: {
      trivial_select_1_ms: trivialMs,
      brands_pk_probe_ms: brandsProbeMs,
      threats_pk_probe_ms: threatsProbeMs,
      brands_count_ms: null,
      threats_recent_10_ms: null,
      total_bench_ms: totalBenchMs,
    },
  };
  // Report the TTL this snapshot is actually cached for (0 = not cached).
  out._meta.cache_ttl_seconds = d1HealthTtlFor(out);
  return out;
}

/** GET /api/admin/d1-health    (JWT super-admin auth)
 *  GET /api/internal/d1-health  (AVERROW_INTERNAL_SECRET auth)
 *
 *  Query params:
 *    check_fk=true — run PRAGMA foreign_key_check (slow, O(rows × FKs))
 *    top_n=N       — tables returned (default 20, max 50)
 *
 *  KV-cached 10 min per check_fk value (`cv:d1_health.v2.fk{0,1}`,
 *  single-flight; 60 s / not written when degraded — d1HealthTtlFor);
 *  top_n slices the cached table list, so changing it never recomputes.
 */
export async function handleD1Health(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const checkFk = url.searchParams.get("check_fk") === "true";
  const parsedTopN = parseInt(url.searchParams.get("top_n") ?? "20", 10);
  const topNTables = Math.max(1, Math.min(50, Number.isFinite(parsedTopN) ? parsedTopN : 20));

  try {
    const session = getReadSession(env, getDbContext(request));
    const data = await cachedValue<D1HealthData>(
      env,
      `${D1_HEALTH_CACHE_KEY_PREFIX}.fk${checkFk ? 1 : 0}`,
      D1_HEALTH_TTL_S,
      () => computeD1Health(session, checkFk),
      {
        ttlFor: d1HealthTtlFor,
        singleFlight: { lockTtlSeconds: 60, waitMs: 10_000 },
      },
    );
    return json({
      success: true,
      data: {
        ...data,
        inventory: {
          ...data.inventory,
          top_tables_by_rows: data.inventory.top_tables_by_rows.slice(0, topNTables),
        },
      },
    }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ success: false, error: message }, 500, origin);
  }
}
