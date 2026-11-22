// Averrow — telemetry cut-over operations for the agent-runs family (Track B1c)
//
// Three operator tools behind /api/internal/telemetry/* (index.ts):
//
//   copyTelemetryConfig  POST /api/internal/telemetry/copy-config[?mode=insert|reconcile][&direction=to_telemetry|to_core][&force=1][&dry_run=0]
//       A DRY RUN unless dry_run=0. mode=insert (default) copies
//       agent_configs + agent_approvals rows missing on the target (ON
//       CONFLICT DO NOTHING). mode=reconcile also overwrites a differing
//       target row when the source's updated_at is the same or newer
//       (force=1: always) and reports per-row diffs. direction=to_core is the
//       reverse reconcile, before a flip back. After the flip both tables are
//       read from the routed store only, so a missing / stale approval row
//       would block that agent and a stale config row would lose a pause.
//
//   backfillTelemetryHistory  POST /api/internal/telemetry/backfill?table=…&days=30[&dry_run=0]  (dry run unless dry_run=0)
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
//       agent_configs / agent_approvals row on core is present on telemetry
//       with the same pause / breaker / approval content. Telemetry-side
//       history row counts and backfill cursors are reported, not blocking.
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

export type ConfigCopyMode = "insert" | "reconcile";
export type ConfigCopyDirection = "to_telemetry" | "to_core";

export interface ConfigRowDiff {
  agent_id: string;
  /** insert = missing on target; update = differs and source is as new or newer (or force);
   *  skip_target_newer = differs but the target row's updated_at is newer. */
  action: "insert" | "update" | "skip_target_newer";
  /** Changed columns, target value → source value (empty for an insert). */
  changed: Record<string, { target: unknown; source: unknown }>;
}

export interface ConfigCopyTableResult {
  table: ConfigTable;
  source_rows: number;
  target_rows_before: number;
  missing_on_target: number;
  /** Rows present on both whose content differs (reconcile mode). */
  differing: number;
  /** Rows written (0 on a dry run). */
  inserted: number;
  updated: number;
  skipped_target_newer: number;
  /** Per-row plan (≤ CONFIG_DIFF_REPORT_LIMIT rows), dry run or not. */
  diffs: ConfigRowDiff[];
}

export interface ConfigCopyResult {
  dry_run: boolean;
  mode: ConfigCopyMode;
  direction: ConfigCopyDirection;
  force: boolean;
  tables: ConfigCopyTableResult[];
}

/** Statements per D1 batch when copying (well inside D1's batch limits). */
const COPY_BATCH = 50;
export const CONFIG_DIFF_REPORT_LIMIT = 200;

const sameValue = (a: unknown, b: unknown): boolean =>
  (a ?? null) === (b ?? null) || (a != null && b != null && String(a) === String(b));

/** Columns whose values differ between two rows of a config table. */
export function configRowDiff(
  table: ConfigTable,
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  columns: readonly string[] = COPY_COLUMNS[table],
): Record<string, { target: unknown; source: unknown }> {
  const changed: Record<string, { target: unknown; source: unknown }> = {};
  for (const c of columns) {
    if (!sameValue(target[c], source[c])) changed[c] = { target: target[c] ?? null, source: source[c] ?? null };
  }
  return changed;
}

function upsertSql(table: ConfigTable): string {
  const cols = COPY_COLUMNS[table];
  const set = cols.filter((c) => c !== "agent_id").map((c) => `${c} = excluded.${c}`).join(", ");
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(agent_id) DO UPDATE SET ${set}`;
}

export interface CopyConfigParams {
  dryRun: boolean;
  mode: ConfigCopyMode;
  direction: ConfigCopyDirection;
  force: boolean;
}

export function parseCopyConfigParams(sp: URLSearchParams): { ok: true; params: CopyConfigParams } | { ok: false; error: string } {
  const mode = sp.get("mode") ?? "insert";
  if (mode !== "insert" && mode !== "reconcile") return { ok: false, error: "mode must be insert or reconcile" };
  const direction = sp.get("direction") ?? "to_telemetry";
  if (direction !== "to_telemetry" && direction !== "to_core") return { ok: false, error: "direction must be to_telemetry or to_core" };
  if (direction === "to_core" && mode !== "reconcile") return { ok: false, error: "direction=to_core requires mode=reconcile" };
  const force = sp.get("force") === "1";
  if (force && mode !== "reconcile") return { ok: false, error: "force=1 requires mode=reconcile" };
  // A DRY RUN unless dry_run=0.
  return { ok: true, params: { dryRun: sp.get("dry_run") !== "0", mode, direction, force } };
}

/**
 * Copy agent_configs + agent_approvals between core and TELEMETRY_DB.
 *
 *  mode=insert (default): rows missing on the target only, ON CONFLICT DO
 *    NOTHING — never touches an existing target row. The pre-flip seed.
 *  mode=reconcile: also overwrites a target row whose content differs, when
 *    the source row's updated_at is the same or newer (force=1: always). Run
 *    again ~90 s after the flip: in-flight runs and isolates still holding a
 *    cached 'core' route can trip a breaker / record an approval on core.
 *  direction=to_core (reconcile only): the reverse, before flipping back —
 *    config changes made while the route was 'telemetry' live only there.
 */
export async function copyTelemetryConfig(
  env: Env,
  opts: { dryRun: boolean; mode?: ConfigCopyMode; direction?: ConfigCopyDirection; force?: boolean },
): Promise<ConfigCopyResult> {
  const telemetry = await telemetryOrThrow(env);
  const mode = opts.mode ?? "insert";
  const direction = opts.direction ?? "to_telemetry";
  const force = opts.force === true;
  const source = direction === "to_telemetry" ? env.DB : telemetry;
  const target = direction === "to_telemetry" ? telemetry : env.DB;
  const tables: ConfigCopyTableResult[] = [];
  for (const table of CONFIG_TABLES) {
    const cols = COPY_COLUMNS[table].join(", ");
    const srcRows = (await source.prepare(`SELECT ${cols} FROM ${table}`).all<Record<string, unknown>>()).results ?? [];
    const tgtRows = (await target.prepare(`SELECT ${cols} FROM ${table}`).all<Record<string, unknown>>()).results ?? [];
    const tgtById = new Map(tgtRows.map((r) => [String(r.agent_id), r]));
    const plan: Array<{ row: Record<string, unknown>; diff: ConfigRowDiff }> = [];
    let differing = 0;
    for (const row of srcRows) {
      const id = String(row.agent_id);
      const tgt = tgtById.get(id);
      if (!tgt) {
        plan.push({ row, diff: { agent_id: id, action: "insert", changed: {} } });
        continue;
      }
      if (mode !== "reconcile") continue;
      const changed = configRowDiff(table, tgt, row);
      if (Object.keys(changed).length === 0) continue;
      differing++;
      const sourceNewer = String(row.updated_at ?? "") >= String(tgt.updated_at ?? "");
      plan.push({ row, diff: { agent_id: id, action: force || sourceNewer ? "update" : "skip_target_newer", changed } });
    }
    let inserted = 0;
    let updated = 0;
    if (!opts.dryRun) {
      const writes = plan.filter((p) => p.diff.action !== "skip_target_newer");
      const sql = mode === "reconcile" ? upsertSql(table) : insertSql(table, "agent_id");
      for (let i = 0; i < writes.length; i += COPY_BATCH) {
        const chunk = writes.slice(i, i + COPY_BATCH);
        const res = await target.batch(chunk.map((p) => target.prepare(sql).bind(...rowValues(table, p.row))));
        res.forEach((r, k) => {
          if (Number(r.meta?.changes ?? 0) === 0) return;
          if (chunk[k]!.diff.action === "insert") inserted++;
          else updated++;
        });
      }
    }
    tables.push({
      table,
      source_rows: srcRows.length,
      target_rows_before: tgtRows.length,
      missing_on_target: plan.filter((p) => p.diff.action === "insert").length,
      differing,
      inserted,
      updated,
      skipped_target_newer: plan.filter((p) => p.diff.action === "skip_target_newer").length,
      diffs: plan.slice(0, CONFIG_DIFF_REPORT_LIMIT).map((p) => p.diff),
    });
  }
  return { dry_run: opts.dryRun, mode, direction, force, tables };
}

/**
 * Seed a missing config row on TELEMETRY_DB from core's row (Track B1c).
 * executeAgent calls this when the route is 'telemetry' and telemetry has no
 * row for the agent, so a flip made before copy-config can't reset a manual
 * pause / breaker state (agent_configs) or block a grandfathered agent
 * (agent_approvals). Without a core row it seeds nothing (the caller keeps
 * its own default). Returns true when a core row was copied.
 */
export async function seedConfigRowFromCore(env: Env, telemetry: D1Database, table: ConfigTable, agentId: string): Promise<boolean> {
  const cols = COPY_COLUMNS[table];
  const row = await env.DB.prepare(`SELECT ${cols.join(", ")} FROM ${table} WHERE agent_id = ?`)
    .bind(agentId).first<Record<string, unknown>>();
  if (!row) return false;
  await telemetry.prepare(insertSql(table, "agent_id")).bind(...rowValues(table, row)).run();
  return true;
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

/**
 * One backfill chunk: a rowid seek on the table's own B-tree. NOT INDEXED +
 * the unary `+` on the time column keep the planner from range-scanning a
 * time index and sorting the whole remaining window by rowid (a TEMP B-TREE
 * per call); pinned by test/telemetry-agent-runs-cutover.test.ts with and
 * without ANALYZE.
 */
export function backfillSelectSql(table: TelemetryHistoryTable): string {
  const tc = HISTORY_TIME_COLUMN[table];
  return `SELECT rowid AS _rowid, ${COPY_COLUMNS[table].join(", ")} FROM ${table} NOT INDEXED
     WHERE rowid > ? AND +${tc} >= ? AND +${tc} < ?
     ORDER BY rowid
     LIMIT ?`;
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

  const select = backfillSelectSql(table);
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
  config: Array<{
    table: ConfigTable;
    core_rows: number;
    telemetry_rows: number;
    missing_on_telemetry: string[];
    /** Rows whose flip-relevant content differs (≤ 50 reported). */
    content_mismatch: Array<{ agent_id: string; changed: Record<string, { target: unknown; source: unknown }> }>;
  }>;
  /** Telemetry-side counts only: a COUNT(*) over core's history tables is a full scan. */
  history: Array<{ table: TelemetryHistoryTable; telemetry_rows: number | null; backfill: BackfillCursor | null }>;
}

/**
 * The columns that change what an agent DOES after the flip: a pause / breaker
 * state or an approval decision. A mismatch on any of them blocks the flip.
 */
export const PREFLIGHT_CONTENT_COLUMNS: Record<ConfigTable, readonly string[]> = {
  agent_configs: ["enabled", "paused_reason", "consecutive_failures", "consecutive_failure_threshold", "circuit_trip_rule"],
  agent_approvals: ["state"],
};

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

  // Config rows: every core row must be on telemetry with the same
  // flip-relevant content (pause / breaker state, approval decision).
  for (const table of CONFIG_TABLES) {
    const tableOk = result.tables.find((t) => t.table === table)?.columns_match === true;
    const cols = COPY_COLUMNS[table].join(", ");
    const core = (await env.DB.prepare(`SELECT ${cols} FROM ${table}`).all<Record<string, unknown>>()).results ?? [];
    const tel = tableOk
      ? new Map(((await telemetry.prepare(`SELECT ${cols} FROM ${table}`).all<Record<string, unknown>>()).results ?? []).map((r) => [String(r.agent_id), r]))
      : new Map<string, Record<string, unknown>>();
    const missing: string[] = [];
    const mismatch: Array<{ agent_id: string; changed: Record<string, { target: unknown; source: unknown }> }> = [];
    for (const row of core) {
      const id = String(row.agent_id);
      const t = tel.get(id);
      if (!t) { missing.push(id); continue; }
      const changed = configRowDiff(table, t, row, PREFLIGHT_CONTENT_COLUMNS[table]);
      if (Object.keys(changed).length > 0) mismatch.push({ agent_id: id, changed });
    }
    result.config.push({
      table, core_rows: core.length, telemetry_rows: tel.size,
      missing_on_telemetry: missing.slice(0, 50), content_mismatch: mismatch.slice(0, 50),
    });
    if (missing.length > 0) blocking.push(`${table}: ${missing.length} core row(s) not copied to TELEMETRY_DB (POST /api/internal/telemetry/copy-config?dry_run=0)`);
    if (mismatch.length > 0) blocking.push(`${table}: ${mismatch.length} row(s) differ from core in ${PREFLIGHT_CONTENT_COLUMNS[table].join(" / ")} (POST /api/internal/telemetry/copy-config?mode=reconcile&dry_run=0)`);
  }

  // History: informational (the union reads cover anything not backfilled).
  for (const table of TELEMETRY_HISTORY_TABLES) {
    let backfill: BackfillCursor | null = null;
    try { backfill = parseBackfillCursor(await env.CACHE.get(backfillCursorKey(table))); } catch { backfill = null; }
    const telRows = await countRows(telemetry, table);
    result.history.push({ table, telemetry_rows: telRows, backfill });
  }

  result.ok = blocking.length === 0;
  return result;
}
