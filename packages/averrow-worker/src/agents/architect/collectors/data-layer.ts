/**
 * ARCHITECT — data-layer inventory collector.
 *
 * Queries D1 for every user table (sqlite_master), captures row counts +
 * sampled byte-size estimates + index counts, computes 7-day growth by
 * comparing to architect_table_snapshots, then writes a fresh snapshot
 * row so the next run has a delta baseline.
 *
 * Pure read-plus-append — never alters existing schema, never deletes
 * rows.
 *
 * Byte-size estimation: D1 does not compile in the `dbstat` virtual
 * table, so a direct "how big is this table" query is impossible.
 * Instead we sample at most 1000 rows per table, compute the average
 * serialized length, and extrapolate to the row count. The sample is
 * wrapped in a 100ms soft budget — if it doesn't return in time we set
 * `est_bytes` to `null` so ARCHITECT can tell "unknown" apart from
 * "empty" downstream.
 */

import type { Env } from "../../../types";
import type {
  DataLayerInventory,
  FeedRuntimeRow,
  TableInventory,
} from "../types";

// ─── Query row shapes ─────────────────────────────────────────────

interface MasterTableRow {
  name: string;
}

interface CountRow {
  n: number;
}

interface IndexCountRow {
  c: number;
}

interface ColumnInfoRow {
  name: string | null;
}

interface SampleRow {
  total_bytes: number | null;
  n: number;
}

interface SnapshotRow {
  row_count: number;
}

// Valid SQLite identifier — used to whitelist table and column names
// pulled from sqlite_master / PRAGMA output before interpolating them
// into size-sampling queries. D1 prepared statements can't bind
// identifiers, so we validate instead.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Tables we skip entirely — internal SQLite bookkeeping.
const SKIP_TABLES = new Set(["sqlite_sequence", "_cf_KV", "d1_migrations"]);

// Soft wall-clock budget per sample query. D1 does not let us cancel a
// running query, so this is really "how long we will wait before giving
// up and returning null"; the query may still finish in the background.
const SAMPLE_TIMEOUT_MS = 100;

// Cap on sampled rows. Higher = more accurate average, but also more
// I/O per ARCHITECT run. 1000 is a reasonable trade-off for tables up
// to the 100K-row range.
const SAMPLE_LIMIT = 1000;

// ─── Public API ───────────────────────────────────────────────────

export async function collectDataLayerInventory(
  env: Env,
): Promise<DataLayerInventory> {
  const collectedAt = new Date().toISOString();
  const nowMs = Date.now();
  const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;

  const tableRows = await env.DB.prepare(
    `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
  ).all<MasterTableRow>();

  const tableNames = (tableRows.results ?? [])
    .map((r) => r.name)
    .filter((name) => IDENT_RE.test(name) && !SKIP_TABLES.has(name));

  const tables: TableInventory[] = [];
  let totalRows = 0;
  let totalBytes = 0;

  for (const name of tableNames) {
    const rows = await countRows(env, name);
    totalRows += rows;

    const indexCount = await countIndexes(env, name);
    const estBytes = await estimateBytes(env, name, rows);
    if (estBytes !== null) {
      totalBytes += estBytes;
    }

    const growth = await computeGrowth(env, name, rows, sevenDaysAgoMs);

    tables.push({
      name,
      rows,
      est_bytes: estBytes,
      has_indexes: indexCount > 0,
      index_count: indexCount,
      growth_7d_rows: growth.rows,
      growth_7d_pct: growth.pct,
    });

    // Append snapshot row for future delta computation. est_bytes is
    // nullable in the schema so we can faithfully persist "unknown".
    await env.DB.prepare(
      `INSERT INTO architect_table_snapshots
         (captured_at, table_name, row_count, est_bytes)
         VALUES (?, ?, ?, ?)`,
    )
      .bind(nowMs, name, rows, estBytes)
      .run();
  }

  return {
    collected_at: collectedAt,
    tables,
    totals: {
      table_count: tables.length,
      total_rows: totalRows,
      total_est_bytes: totalBytes,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

async function countRows(env: Env, table: string): Promise<number> {
  // Table name is whitelisted via IDENT_RE against sqlite_master output
  // above, so interpolation is safe here. D1 cannot bind identifiers.
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM "${table}"`,
  ).first<CountRow>();
  return row?.n ?? 0;
}

async function countIndexes(env: Env, table: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM sqlite_master
       WHERE type = 'index' AND tbl_name = ?`,
  )
    .bind(table)
    .first<IndexCountRow>();
  return row?.c ?? 0;
}

/**
 * Sampled size estimate. Returns:
 *   - `0`    when the table is empty (truly zero bytes of row data)
 *   - a positive number when sampling succeeded
 *   - `null` when sampling failed (timeout, permission error, bad
 *     schema response) — callers should treat this as "unknown"
 */
async function estimateBytes(
  env: Env,
  table: string,
  rows: number,
): Promise<number | null> {
  if (rows === 0) return 0;

  const columns = await listSampleableColumns(env, table);
  if (columns.length === 0) return null;

  // Build SUM(COALESCE(LENGTH("col1"),0) + COALESCE(LENGTH("col2"),0) + …)
  // over the sample. LENGTH returns bytes for BLOB and characters for
  // TEXT — not perfect for multi-byte text, but the order of magnitude
  // is what ARCHITECT cares about. Row-size outside column data (page
  // overhead, indexes, slack) is ignored — the Haiku pass is free to
  // scale this later.
  const lengthExpr = columns
    .map((c) => `COALESCE(LENGTH("${c}"), 0)`)
    .join(" + ");

  const query =
    `SELECT SUM(${lengthExpr}) AS total_bytes, COUNT(*) AS n ` +
    `FROM (SELECT * FROM "${table}" LIMIT ${SAMPLE_LIMIT})`;

  try {
    const sample = await raceWithTimeout(
      env.DB.prepare(query).first<SampleRow>(),
      SAMPLE_TIMEOUT_MS,
    );
    if (!sample || !sample.n || sample.n === 0) return null;
    const avgRowBytes = (sample.total_bytes ?? 0) / sample.n;
    return Math.round(avgRowBytes * rows);
  } catch {
    // Timeout or SQL error — leave the caller with "unknown" so ARCHITECT
    // can distinguish an estimation gap from an empty table.
    return null;
  }
}

async function listSampleableColumns(
  env: Env,
  table: string,
): Promise<string[]> {
  // PRAGMA statements don't accept bound parameters in D1. Table name
  // is already whitelisted via IDENT_RE, and we re-validate column
  // names below before interpolating them into the sample query.
  try {
    const result = await env.DB.prepare(
      `PRAGMA table_info("${table}")`,
    ).all<ColumnInfoRow>();
    const out: string[] = [];
    for (const row of result.results ?? []) {
      const name = row.name;
      if (name && IDENT_RE.test(name)) out.push(name);
    }
    return out;
  } catch {
    return [];
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`sample timeout after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface GrowthResult {
  rows: number | null;
  pct: number | null;
}

// ─── Feed runtime collector ───────────────────────────────────────
//
// Schedules and enabled flags live in the `feed_configs` D1 table,
// not in the repo. The repo walker at collectors/repo-fs.ts cannot
// see them by contract (it's a Node fs walker, no Worker runtime, no
// D1). Without this extension the Phase 2 feeds analyzer sees 38
// rows of `schedule: null` and — correctly — treats them as dormant.
// That conclusion is wrong: the feeds are very much running, the
// schedule just lives in D1.
//
// This collector joins `feed_configs` + `feed_status` and rolls up
// pull counts from `feed_pull_history` over the last 7 days so the
// feeds analyzer has a real "scheduled vs dormant vs disabled"
// signal. See docs/architect/findings/feeds-schedule-investigation.md
// for the full justification.
//
// Returns an empty array (never throws) when any of the feed tables
// are missing, so unit tests / future schema cleanups don't break
// the whole collector run.

interface FeedRuntimeQueryRow {
  feed_name: string;
  enabled: number;
  schedule_cron: string | null;
  last_successful_pull: string | null;
  last_attempted_pull: string | null;
  last_error: string | null;
  consecutive_failures: number;
  pulls_7d: number;
  successes_7d: number;
}

export async function collectFeedRuntime(
  env: Env,
): Promise<FeedRuntimeRow[]> {
  // feed_pull_history stores `started_at` (TEXT, datetime('now')
  // format). The 7-day subquery compares lexicographically, which
  // is correct for that format.
  //
  // consecutive_failures is now a persisted counter on feed_status
  // (Phase 4 Step 3 — feed auto-pause). Prior to that migration this
  // collector recomputed it from feed_pull_history on every read;
  // that subquery has been removed and we simply COALESCE the
  // column, since the feedRunner is now the single writer that
  // increments on failure and resets to 0 on success.
  try {
    const rows = await env.DB.prepare(
      `SELECT
         fc.feed_name,
         fc.enabled,
         fc.schedule_cron,
         fs.last_successful_pull,
         fs.last_error,
         COALESCE(fs.consecutive_failures, 0) AS consecutive_failures,
         (SELECT MAX(started_at)
            FROM feed_pull_history
            WHERE feed_name = fc.feed_name) AS last_attempted_pull,
         (SELECT COUNT(*)
            FROM feed_pull_history
            WHERE feed_name = fc.feed_name
              AND started_at > datetime('now','-7 days')) AS pulls_7d,
         (SELECT COUNT(*)
            FROM feed_pull_history
            WHERE feed_name = fc.feed_name
              AND started_at > datetime('now','-7 days')
              AND status = 'success') AS successes_7d
       FROM feed_configs fc
       LEFT JOIN feed_status fs ON fc.feed_name = fs.feed_name
       ORDER BY fc.feed_name`,
    ).all<FeedRuntimeQueryRow>();

    return (rows.results ?? []).map((r) => ({
      feed_name: r.feed_name,
      enabled: r.enabled ?? 0,
      schedule_cron: r.schedule_cron ?? null,
      last_successful_pull: r.last_successful_pull ?? null,
      last_attempted_pull: r.last_attempted_pull ?? null,
      last_error: r.last_error ?? null,
      consecutive_failures: r.consecutive_failures ?? 0,
      pulls_7d: r.pulls_7d ?? 0,
      successes_7d: r.successes_7d ?? 0,
    }));
  } catch {
    // Missing feed_configs / feed_status / feed_pull_history — treat
    // as "no runtime signal" rather than failing the whole collector
    // run. The feeds analyzer falls back to its repo-only view in
    // this case, which is no worse than the pre-fix behaviour.
    return [];
  }
}

async function computeGrowth(
  env: Env,
  table: string,
  currentRows: number,
  sinceMs: number,
): Promise<GrowthResult> {
  const prior = await env.DB.prepare(
    `SELECT row_count FROM architect_table_snapshots
       WHERE table_name = ?
         AND captured_at <= ?
       ORDER BY captured_at DESC
       LIMIT 1`,
  )
    .bind(table, sinceMs)
    .first<SnapshotRow>();

  if (!prior) return { rows: null, pct: null };
  const deltaRows = currentRows - prior.row_count;
  const pct =
    prior.row_count > 0 ? (deltaRows / prior.row_count) * 100 : null;
  return { rows: deltaRows, pct };
}
