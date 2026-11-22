// Averrow — telemetry cut-over operations for the agent-runs family (Track B1c)
//
// Three operator tools behind /api/internal/telemetry/* (index.ts):
//
//   copyTelemetryConfig  POST /api/internal/telemetry/copy-config[?dry_run=0]  (dry run unless dry_run=0)
//       Copies agent_configs + agent_approvals core → TELEMETRY_DB with
//       INSERT … ON CONFLICT DO NOTHING (idempotent; a row already on
//       telemetry is never overwritten). Run before the route flip — after
//       it, both tables are read from the routed store only, so a missing
//       approval row would block that agent (approval gate) and a missing
//       config row would reset its breaker.
//
//   backfillTelemetryHistory  POST /api/internal/telemetry/backfill?table=…&days=30[&dry_run=1]
//       Copies recent history of agent_runs / agent_events /
//       agent_activity_log core → telemetry so the union reads
//       (lib/telemetry-read.ts) can later drop core. One bounded call:
//       ≤ 500 rows in chunks of 100 with a pause between chunks, keyset on
//       core rowid, KV cursor (resumable; loop until data.done). The window
//       [from, until) is fixed by the first call: from = now − days,
//       until = now − 24 h, so only finished rows are copied (a copied row is
//       never updated again on core). The cursor is what the union reads'
//       split predicate excludes from core.
//
//   telemetryPreflight  GET /api/internal/telemetry/preflight
//       The flip gate: ok:true only when TELEMETRY_DB is bound, every wave-1
//       table exists there with core's columns and indexes, and every
//       agent_configs / agent_approvals row on core is present on telemetry.
//       Row counts and backfill cursors are reported, not blocking.
//
// All reads of core here are deliberate one-off operator reads (bounded or
// tiny tables). Core is never written.

import type { Env } from "../types";
import { telemetryDbFor, telemetryRouteState } from "./db-route";
import {
  backfillCursorKey,
  forgetBackfillCursor,
  HISTORY_TIME_COLUMN,
  parseBackfillCursor,
  TELEMETRY_HISTORY_TABLES,
  type BackfillCursor,
  type TelemetryHistoryTable,
} from "./telemetry-read";

/** The wave-1 tables migrations-telemetry/0001_init.sql creates. */
export const WAVE1_TABLES = [
  "agent_runs",
  "agent_configs",
  "agent_events",
  "agent_activity_log",
  "agent_approvals",
  "feed_configs",
  "feed_status",
  "feed_pull_history",
  "budget_ledger",
  "budget_config",
  "agent_budget_rollups",
] as const;

/**
 * Columns copied per table — exactly the telemetry schema's columns
 * (pinned against migrations-telemetry/ by test/telemetry-cutover.test.ts).
 */
export const COPY_COLUMNS = {
  agent_configs: [
    "agent_id", "enabled", "paused_reason", "consecutive_failures", "consecutive_failure_threshold",
    "circuit_trip_rule", "paused_at", "paused_after_n_failures", "created_at", "updated_at",
  ],
  agent_approvals: [
    "agent_id", "state", "requested_at", "reviewed_at", "reviewed_by", "reviewer_notes",
    "source_pr", "created_at", "updated_at",
  ],
  agent_runs: [
    "id", "agent_id", "started_at", "completed_at", "duration_ms", "status", "error_message",
    "records_processed", "outputs_generated", "tokens_used", "input_tokens", "output_tokens",
  ],
  agent_events: [
    "id", "event_type", "source_agent", "target_agent", "payload_json", "priority",
    "created_at", "processed_at", "status",
  ],
  agent_activity_log: [
    "id", "agent_id", "run_id", "event_type", "message", "metadata_json", "severity", "created_at",
  ],
} as const;

export type ConfigTable = "agent_configs" | "agent_approvals";
const CONFIG_TABLES: readonly ConfigTable[] = ["agent_configs", "agent_approvals"];

export class TelemetryUnboundError extends Error {
  constructor() {
    super("telemetry_unbound: TELEMETRY_DB is not bound in this environment");
    this.name = "TelemetryUnboundError";
  }
}

async function telemetryOrThrow(env: Env): Promise<D1Database> {
  const { bound } = await telemetryRouteState(env);
  if (!bound) throw new TelemetryUnboundError();
  return telemetryDbFor(env, "telemetry");
}

function insertSql(table: keyof typeof COPY_COLUMNS, conflictKey: string): string {
  const cols = COPY_COLUMNS[table];
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(${conflictKey}) DO NOTHING`;
}

function rowValues(table: keyof typeof COPY_COLUMNS, row: Record<string, unknown>): unknown[] {
  return COPY_COLUMNS[table].map((c) => (row[c] === undefined ? null : row[c]));
}

// ─── copy-config ─────────────────────────────────────────────────

export interface ConfigCopyTableResult {
  table: ConfigTable;
  core_rows: number;
  telemetry_rows_before: number;
  missing_on_telemetry: number;
  /** Rows written (0 on a dry run). */
  inserted: number;
}

export interface ConfigCopyResult {
  dry_run: boolean;
  tables: ConfigCopyTableResult[];
}

/** Statements per D1 batch when copying (well inside D1's batch limits). */
const COPY_BATCH = 50;

export async function copyTelemetryConfig(env: Env, opts: { dryRun: boolean }): Promise<ConfigCopyResult> {
  const telemetry = await telemetryOrThrow(env);
  const tables: ConfigCopyTableResult[] = [];
  for (const table of CONFIG_TABLES) {
    const cols = COPY_COLUMNS[table].join(", ");
    const core = (await env.DB.prepare(`SELECT ${cols} FROM ${table}`).all<Record<string, unknown>>()).results ?? [];
    const have = new Set(
      ((await telemetry.prepare(`SELECT agent_id FROM ${table}`).all<{ agent_id: string }>()).results ?? []).map((r) => r.agent_id),
    );
    const missing = core.filter((r) => !have.has(String(r.agent_id)));
    let inserted = 0;
    if (!opts.dryRun && missing.length > 0) {
      const sql = insertSql(table, "agent_id");
      for (let i = 0; i < missing.length; i += COPY_BATCH) {
        const chunk = missing.slice(i, i + COPY_BATCH);
        const res = await telemetry.batch(chunk.map((r) => telemetry.prepare(sql).bind(...rowValues(table, r))));
        inserted += res.reduce((n, r) => n + Number(r.meta?.changes ?? 0), 0);
      }
    }
    tables.push({
      table,
      core_rows: core.length,
      telemetry_rows_before: have.size,
      missing_on_telemetry: missing.length,
      inserted,
    });
  }
  return { dry_run: opts.dryRun, tables };
}

// ─── backfill ────────────────────────────────────────────────────

export const BACKFILL_MAX_ROWS_PER_CALL = 500;
export const BACKFILL_CHUNK_ROWS = 100;
export const BACKFILL_CHUNK_PAUSE_MS = 250;
export const BACKFILL_DEFAULT_DAYS = 30;
export const BACKFILL_MAX_DAYS = 90;
/** Rows younger than this are never copied (may still be finalized on core). */
export const BACKFILL_HORIZON_HOURS = 24;

export interface BackfillParams {
  table: TelemetryHistoryTable;
  days: number;
  dryRun: boolean;
}

export function parseBackfillParams(sp: URLSearchParams): { ok: true; params: BackfillParams } | { ok: false; error: string } {
  const table = sp.get("table") ?? "";
  if (!(TELEMETRY_HISTORY_TABLES as readonly string[]).includes(table)) {
    return { ok: false, error: `table must be one of ${TELEMETRY_HISTORY_TABLES.join(", ")}` };
  }
  const rawDays = sp.get("days");
  const days = rawDays === null ? BACKFILL_DEFAULT_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > BACKFILL_MAX_DAYS) {
    return { ok: false, error: `days must be an integer 1..${BACKFILL_MAX_DAYS}` };
  }
  // Default is a dry run; only dry_run=0 writes.
  const dryRun = sp.get("dry_run") !== "0";
  return { ok: true, params: { table: table as TelemetryHistoryTable, days, dryRun } };
}

/** SQLite `datetime()` text for `ms` (UTC, 'YYYY-MM-DD HH:MM:SS'). */
export function sqliteTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export interface BackfillResult {
  table: TelemetryHistoryTable;
  dry_run: boolean;
  /** The window this backfill copies — fixed by its first call. */
  from: string;
  until: string;
  /** Rows read from core this call (≤ BACKFILL_MAX_ROWS_PER_CALL). */
  scanned: number;
  /** Rows newly written to telemetry (0 on a dry run; a row already there is not counted). */
  inserted: number;
  /** Cursor after this call (unchanged on a dry run). */
  cursor_rowid: number | null;
  copied_total: number;
  done: boolean;
  /** `days` was ignored because the backfill already started with another window. */
  window_fixed?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function backfillTelemetryHistory(
  env: Env,
  params: BackfillParams,
  opts: { nowMs?: number; pauseMs?: number; maxRows?: number; chunkRows?: number } = {},
): Promise<BackfillResult> {
  const telemetry = await telemetryOrThrow(env);
  const nowMs = opts.nowMs ?? Date.now();
  const pauseMs = opts.pauseMs ?? BACKFILL_CHUNK_PAUSE_MS;
  const maxRows = Math.min(opts.maxRows ?? BACKFILL_MAX_ROWS_PER_CALL, BACKFILL_MAX_ROWS_PER_CALL);
  const chunkRows = Math.max(1, Math.min(opts.chunkRows ?? BACKFILL_CHUNK_ROWS, maxRows));
  const { table } = params;
  const key = backfillCursorKey(table);
  const tc = HISTORY_TIME_COLUMN[table];

  const stored = parseBackfillCursor(await env.CACHE.get(key));
  const requestedFrom = sqliteTs(nowMs - params.days * 86_400_000);
  const cursor: BackfillCursor = stored ?? {
    from: requestedFrom,
    until: sqliteTs(nowMs - BACKFILL_HORIZON_HOURS * 3_600_000),
    rowid: null,
    done: false,
    copied: 0,
    updated_at: new Date(nowMs).toISOString(),
  };
  const windowFixed = stored !== null && stored.from !== requestedFrom ? true : undefined;
  const base = { table, dry_run: params.dryRun, from: cursor.from, until: cursor.until, ...(windowFixed ? { window_fixed: true } : {}) };

  if (cursor.done) {
    return { ...base, scanned: 0, inserted: 0, cursor_rowid: cursor.rowid, copied_total: cursor.copied, done: true };
  }

  // First call: start at the first rowid inside the window (one indexed
  // MIN for agent_runs / agent_activity_log; agent_events has no index on
  // created_at alone, so that one MIN is a single scan).
  let after = cursor.rowid;
  if (after === null) {
    const first = await env.DB.prepare(
      `SELECT MIN(rowid) AS r FROM ${table} WHERE ${tc} >= ? AND ${tc} < ?`,
    ).bind(cursor.from, cursor.until).first<{ r: number | null }>();
    if (first?.r === null || first?.r === undefined) {
      const finished: BackfillCursor = { ...cursor, done: true, updated_at: new Date(nowMs).toISOString() };
      if (!params.dryRun) {
        await env.CACHE.put(key, JSON.stringify(finished));
        forgetBackfillCursor(table);
      }
      return { ...base, scanned: 0, inserted: 0, cursor_rowid: null, copied_total: cursor.copied, done: true };
    }
    after = first.r - 1;
  }

  const cols = COPY_COLUMNS[table];
  const select = `SELECT rowid AS _rowid, ${cols.join(", ")} FROM ${table}
     WHERE rowid > ? AND ${tc} >= ? AND ${tc} < ?
     ORDER BY rowid
     LIMIT ?`;
  const insert = insertSql(table, "id");
  let scanned = 0;
  let inserted = 0;
  let done = false;
  let last = after;
  while (scanned < maxRows) {
    if (scanned > 0 && pauseMs > 0) await sleep(pauseMs);
    const want = Math.min(chunkRows, maxRows - scanned);
    const rows = (await env.DB.prepare(select).bind(last, cursor.from, cursor.until, want)
      .all<Record<string, unknown> & { _rowid: number }>()).results ?? [];
    if (rows.length === 0) {
      done = true;
      break;
    }
    scanned += rows.length;
    if (!params.dryRun) {
      const res = await telemetry.batch(rows.map((r) => telemetry.prepare(insert).bind(...rowValues(table, r))));
      inserted += res.reduce((n, r) => n + Number(r.meta?.changes ?? 0), 0);
      // Copy first, cursor after: a crash between the two re-copies the
      // chunk next call (ON CONFLICT DO NOTHING), never skips it.
      last = Number(rows[rows.length - 1]!._rowid);
      const next: BackfillCursor = {
        ...cursor,
        rowid: last,
        copied: cursor.copied + inserted,
        done: false,
        updated_at: new Date(nowMs).toISOString(),
      };
      await env.CACHE.put(key, JSON.stringify(next));
    } else {
      last = Number(rows[rows.length - 1]!._rowid);
    }
    if (rows.length < want) {
      done = true;
      break;
    }
  }

  const finalCursor: BackfillCursor = {
    ...cursor,
    rowid: params.dryRun ? cursor.rowid : last,
    copied: cursor.copied + inserted,
    done: params.dryRun ? false : done,
    updated_at: new Date(nowMs).toISOString(),
  };
  if (!params.dryRun) {
    await env.CACHE.put(key, JSON.stringify(finalCursor));
    forgetBackfillCursor(table);
  }
  return {
    ...base,
    scanned,
    inserted,
    cursor_rowid: finalCursor.rowid,
    copied_total: finalCursor.copied,
    done: params.dryRun ? false : done,
  };
}

// ─── preflight ───────────────────────────────────────────────────

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface TablePreflight {
  table: string;
  on_telemetry: boolean;
  columns_match: boolean;
  column_diff: string[];
  missing_indexes: string[];
  index_sql_differs: string[];
  extra_indexes: string[];
}

export interface TelemetryPreflight {
  ok: boolean;
  blocking: string[];
  warnings: string[];
  route: { route: string; requested: string | null; bound: boolean };
  tables: TablePreflight[];
  config: Array<{ table: ConfigTable; core_rows: number; telemetry_rows: number; missing_on_telemetry: string[] }>;
  history: Array<{ table: TelemetryHistoryTable; core_rows: number | null; telemetry_rows: number | null; backfill: BackfillCursor | null }>;
}

const normSql = (sql: string | null): string =>
  (sql ?? "").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").replace(/\bIF NOT EXISTS\b/gi, "").replace(/\s*([(),])\s*/g, "$1").trim().toLowerCase();

async function columnsOf(db: D1Database, table: string): Promise<ColumnInfo[]> {
  const rows = (await db.prepare(
    `SELECT name, type, "notnull" AS nn, dflt_value, pk FROM pragma_table_info(?) ORDER BY cid`,
  ).bind(table).all<Omit<ColumnInfo, "notnull"> & { nn: number }>()).results ?? [];
  return rows.map(({ nn, ...c }) => ({ ...c, notnull: nn }));
}

async function indexesOf(db: D1Database, table: string): Promise<Map<string, string>> {
  const rows = (await db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_autoindex_%'`,
  ).bind(table).all<{ name: string; sql: string | null }>()).results ?? [];
  return new Map(rows.map((r) => [r.name, normSql(r.sql)]));
}

async function countRows(db: D1Database, table: string): Promise<number | null> {
  try {
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return r?.n ?? 0;
  } catch {
    return null;
  }
}

const colKey = (c: ColumnInfo): string =>
  `${c.name} ${String(c.type).toUpperCase()} notnull=${c.notnull} default=${c.dflt_value ?? "NULL"} pk=${c.pk}`;

export async function telemetryPreflight(env: Env): Promise<TelemetryPreflight> {
  const state = await telemetryRouteState(env);
  const blocking: string[] = [];
  const warnings: string[] = [];
  const result: TelemetryPreflight = {
    ok: false,
    blocking,
    warnings,
    route: { route: state.route, requested: state.requested, bound: state.bound },
    tables: [],
    config: [],
    history: [],
  };
  if (!state.bound) {
    blocking.push("TELEMETRY_DB is not bound in this environment");
    return result;
  }
  const telemetry = telemetryDbFor(env, "telemetry");

  // Schema: every wave-1 table on telemetry, with core's columns + indexes.
  for (const table of WAVE1_TABLES) {
    const [coreCols, telCols, coreIdx, telIdx] = await Promise.all([
      columnsOf(env.DB, table), columnsOf(telemetry, table), indexesOf(env.DB, table), indexesOf(telemetry, table),
    ]);
    const onTelemetry = telCols.length > 0;
    const coreKeys = coreCols.map(colKey);
    const telKeys = telCols.map(colKey);
    const columnDiff = [
      ...coreKeys.filter((k) => !telKeys.includes(k)).map((k) => `core only: ${k}`),
      ...telKeys.filter((k) => !coreKeys.includes(k)).map((k) => `telemetry only: ${k}`),
    ];
    const missingIdx = [...coreIdx.keys()].filter((n) => !telIdx.has(n));
    const differs = [...coreIdx.keys()].filter((n) => telIdx.has(n) && telIdx.get(n) !== coreIdx.get(n));
    const extra = [...telIdx.keys()].filter((n) => !coreIdx.has(n));
    result.tables.push({
      table, on_telemetry: onTelemetry, columns_match: onTelemetry && columnDiff.length === 0,
      column_diff: columnDiff, missing_indexes: missingIdx, index_sql_differs: differs, extra_indexes: extra,
    });
    if (!onTelemetry) blocking.push(`${table}: missing on TELEMETRY_DB (apply migrations-telemetry)`);
    else if (columnDiff.length > 0) blocking.push(`${table}: column mismatch (${columnDiff.join("; ")})`);
    if (onTelemetry && missingIdx.length > 0) blocking.push(`${table}: indexes missing on TELEMETRY_DB: ${missingIdx.join(", ")}`);
    if (differs.length > 0) warnings.push(`${table}: index definitions differ: ${differs.join(", ")}`);
    if (extra.length > 0) warnings.push(`${table}: indexes only on TELEMETRY_DB: ${extra.join(", ")}`);
  }

  // Config rows: every core row must already be on telemetry.
  for (const table of CONFIG_TABLES) {
    const tableOk = result.tables.find((t) => t.table === table)?.on_telemetry === true;
    const core = ((await env.DB.prepare(`SELECT agent_id FROM ${table}`).all<{ agent_id: string }>()).results ?? []).map((r) => r.agent_id);
    const tel = tableOk
      ? new Set(((await telemetry.prepare(`SELECT agent_id FROM ${table}`).all<{ agent_id: string }>()).results ?? []).map((r) => r.agent_id))
      : new Set<string>();
    const missing = core.filter((id) => !tel.has(id));
    result.config.push({ table, core_rows: core.length, telemetry_rows: tel.size, missing_on_telemetry: missing.slice(0, 50) });
    if (missing.length > 0) blocking.push(`${table}: ${missing.length} core row(s) not copied to TELEMETRY_DB (POST /api/internal/telemetry/copy-config?dry_run=0)`);
  }

  // History: informational (the union reads cover anything not backfilled).
  for (const table of TELEMETRY_HISTORY_TABLES) {
    let backfill: BackfillCursor | null = null;
    try { backfill = parseBackfillCursor(await env.CACHE.get(backfillCursorKey(table))); } catch { backfill = null; }
    const [coreRows, telRows] = await Promise.all([countRows(env.DB, table), countRows(telemetry, table)]);
    result.history.push({ table, core_rows: coreRows, telemetry_rows: telRows, backfill });
  }

  result.ok = blocking.length === 0;
  return result;
}
