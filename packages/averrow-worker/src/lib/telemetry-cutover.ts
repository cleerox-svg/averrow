// Averrow — telemetry cut-over operations, per family (Track B1c agents, B1d feeds + budget)
//
// Operator tools behind /api/internal/telemetry/* (index.ts). Every tool takes
// `family=agents|feeds|budget` (default agents — the B1c behaviour):
//
//   copyTelemetryConfig  POST /api/internal/telemetry/copy-config[?family=…][&mode=insert|reconcile][&direction=to_telemetry|to_core][&force=1][&dry_run=0]
//       A DRY RUN unless dry_run=0. The family's config / state tables:
//         agents  agent_configs, agent_approvals   (key agent_id)
//         feeds   feed_configs, feed_status        (key feed_name)
//         budget  budget_config                    (key id = 1)
//       mode=insert (default) copies rows missing on the target (ON CONFLICT
//       DO NOTHING). mode=reconcile also overwrites a differing target row
//       when the source row is the same age or newer (force=1: always) and
//       reports per-row diffs. Age = updated_at, except feed_status (no
//       updated_at): the newer of last_successful_pull / last_failure.
//       Reconcile NEVER lifts a pause on its own (agent_configs /
//       feed_configs: enabled 0→1, or clearing paused_reason) — force=1 only.
//       direction=to_core is the reverse reconcile, before a flip back. After
//       a flip these tables are read from the routed store only, so a missing
//       / stale row would lose a pause, a breaker state, an approval or the
//       AI spend ceiling.
//
//   backfillTelemetryHistory  POST /api/internal/telemetry/backfill?table=…&days=30[&dry_run=0]  (dry run unless dry_run=0)
//       Copies recent history of one table core → telemetry so the union
//       reads (lib/telemetry-read.ts) can later drop core: agent_runs /
//       agent_events / agent_activity_log (agents), feed_pull_history
//       (feeds), budget_ledger / agent_budget_rollups (budget). The family
//       follows from the table. One bounded call: ≤ 500 rows in chunks of
//       100 with a pause between chunks, keyset on core rowid, KV cursor
//       (resumable; loop until data.done). The window [from, until) is fixed
//       by the first call: from = now − days, until = now − 24 h, so only
//       finished rows are copied (a copied row is never updated again on
//       core). agent_budget_rollups is a keyed counter table whose window is
//       in whole months: until = the month of (now − 24 h), and never later
//       than the oldest month already on telemetry, so only CLOSED months
//       that telemetry never wrote are copied; a conflicting row with
//       different content stops the call (never silently dropped). The
//       cursor is what the union reads' split predicate excludes from core.
//
//   telemetryPreflight  GET /api/internal/telemetry/preflight[?family=…]
//       The flip gate for one family: ok:true only when TELEMETRY_DB is
//       bound, the family's tables exist there with core's columns and
//       indexes (agents: every wave-1 table, as in B1c), and every config
//       row on core is present on telemetry with the same flip-relevant
//       content (budget: also the budget_config id=1 row). Telemetry-side
//       history row counts and backfill cursors are reported, not blocking.
//
//   setTelemetryRoute  POST /api/internal/telemetry/route?family=…&to=core|telemetry[&force=1][&dry_run=0]
//   telemetryRoutes    GET  /api/internal/telemetry/route
//       The flip itself (one KV write of the family's flag). A DRY RUN unless
//       dry_run=0. to=telemetry is refused unless that family's preflight is
//       ok. to=core (rollback) is refused while telemetry's config rows differ
//       from core's (run copy-config?direction=to_core&mode=reconcile first)
//       unless force=1. GET lists every family's flag, effective route and
//       'used' marker.
//
// All reads of core here are deliberate one-off operator reads (bounded or
// tiny tables). Core is written only by copy-config direction=to_core.

import type { Env } from "../types";
import {
  FAMILY_ROUTE_KV_KEYS,
  FAMILY_TABLES,
  FAMILY_USED_KV_KEYS,
  TELEMETRY_FAMILIES,
  TELEMETRY_ROUTE_CACHE_MS,
  familyRouteState,
  parseTelemetryRoute,
  telemetryDbFor,
  type TelemetryFamily,
  type TelemetryRoute,
} from "./db-route";
import {
  backfillCursorKey,
  FAMILY_HISTORY_TABLES,
  forgetBackfillCursor,
  HISTORY_TABLE_FAMILY,
  HISTORY_TIME_COLUMN,
  parseBackfillCursor,
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
 * (pinned against migrations-telemetry/ by test/telemetry-agent-runs-cutover.test.ts).
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
  feed_configs: [
    "feed_name", "display_name", "description", "source_url", "api_key_encrypted", "schedule_cron",
    "rate_limit", "batch_size", "retry_count", "retry_delay_seconds", "enabled", "filters",
    "normalization_rules", "created_at", "updated_at", "updated_by", "feed_type", "paused_reason",
    "consecutive_failure_threshold", "taxii_root_url", "taxii_collection_id", "taxii_auth_type",
    "taxii_username", "taxii_api_key_env", "taxii_next_added_after",
  ],
  feed_status: [
    "feed_name", "last_successful_pull", "last_failure", "records_ingested_today", "health_status",
    "last_error", "consecutive_failures", "next_retry_at",
  ],
  feed_pull_history: [
    "id", "feed_name", "started_at", "completed_at", "duration_ms", "records_ingested",
    "records_rejected", "status", "error_message",
  ],
  budget_ledger: [
    "id", "agent_id", "run_id", "model", "input_tokens", "output_tokens", "cost_usd", "created_at",
  ],
  budget_config: [
    "id", "monthly_limit_usd", "soft_pct", "hard_pct", "emergency_pct", "updated_at",
  ],
  agent_budget_rollups: [
    "agent_id", "year_month", "total_input_tokens", "total_output_tokens", "total_cost_usd",
    "call_count", "updated_at",
  ],
} as const;

type CopyTable = keyof typeof COPY_COLUMNS;

export type ConfigTable = "agent_configs" | "agent_approvals" | "feed_configs" | "feed_status" | "budget_config";

/** Config / state tables per family, in copy order. */
export const FAMILY_CONFIG_TABLES: Record<TelemetryFamily, readonly ConfigTable[]> = {
  agents: ["agent_configs", "agent_approvals"],
  feeds: ["feed_configs", "feed_status"],
  budget: ["budget_config"],
};

/** Primary key of each config table. */
export const CONFIG_KEY: Record<ConfigTable, string> = {
  agent_configs: "agent_id",
  agent_approvals: "agent_id",
  feed_configs: "feed_name",
  feed_status: "feed_name",
  budget_config: "id",
};

/** Conflict target of each history table (backfill INSERT … ON CONFLICT DO NOTHING). */
const HISTORY_CONFLICT_KEY: Record<TelemetryHistoryTable, string> = {
  agent_runs: "id",
  agent_events: "id",
  agent_activity_log: "id",
  feed_pull_history: "id",
  budget_ledger: "id",
  agent_budget_rollups: "agent_id, year_month",
};

export class TelemetryUnboundError extends Error {
  constructor() {
    super("telemetry_unbound: TELEMETRY_DB is not bound in this environment");
    this.name = "TelemetryUnboundError";
  }
}

/** A backfill that met a conflicting row it must not drop (agent_budget_rollups). */
export class BackfillConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackfillConflictError";
  }
}

async function telemetryOrThrow(env: Env): Promise<D1Database> {
  const { bound } = await familyRouteState(env, "agents");
  if (!bound) throw new TelemetryUnboundError();
  return telemetryDbFor(env, "telemetry");
}

function insertSql(table: CopyTable, conflictKey: string): string {
  const cols = COPY_COLUMNS[table];
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(${conflictKey}) DO NOTHING`;
}

function rowValues(table: CopyTable, row: Record<string, unknown>): unknown[] {
  return COPY_COLUMNS[table].map((c) => (row[c] === undefined ? null : row[c]));
}

/** Parse `family=` (default agents). */
export function parseFamily(sp: URLSearchParams): { ok: true; family: TelemetryFamily } | { ok: false; error: string } {
  const raw = sp.get("family");
  if (raw === null || raw === "") return { ok: true, family: "agents" };
  const f = raw.trim().toLowerCase();
  return (TELEMETRY_FAMILIES as readonly string[]).includes(f)
    ? { ok: true, family: f as TelemetryFamily }
    : { ok: false, error: `family must be one of ${TELEMETRY_FAMILIES.join(", ")}` };
}

// ─── copy-config ─────────────────────────────────────────────────

export type ConfigCopyMode = "insert" | "reconcile";
export type ConfigCopyDirection = "to_telemetry" | "to_core";

export interface ConfigRowDiff {
  /** The row's primary key value (agent_id / feed_name / id). */
  key: string;
  /** Same as `key`, agents family only (the B1c field name). */
  agent_id?: string;
  /** insert = missing on target; update = differs and source is as new or newer (or force);
   *  skip_target_newer = differs but the target row is newer;
   *  skip_unpause_needs_force = would re-enable a paused agent / feed (enabled
   *  0→1 or clear paused_reason) — never done without force=1. */
  action: "insert" | "update" | "skip_target_newer" | "skip_unpause_needs_force";
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
  skipped_unpause_needs_force: number;
  /** Per-row plan (≤ CONFIG_DIFF_REPORT_LIMIT rows), dry run or not. */
  diffs: ConfigRowDiff[];
}

export interface ConfigCopyResult {
  family: TelemetryFamily;
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

/** Tables whose rows carry an operator pause (enabled / paused_reason). */
const PAUSABLE_TABLES: ReadonlySet<ConfigTable> = new Set(["agent_configs", "feed_configs"]);

/**
 * Would overwriting `target` with `source` re-enable a paused agent / feed? A
 * pause (manual or a tripped breaker) is only ever lifted by an operator, so
 * reconcile never does it on its own — an age comparison is not a safe tiebreak.
 */
function wouldUnpause(target: Record<string, unknown>, source: Record<string, unknown>): boolean {
  const tgtPaused = Number(target.enabled) === 0;
  const srcEnabled = Number(source.enabled) !== 0;
  const clearsReason = target.paused_reason != null && source.paused_reason == null;
  return (tgtPaused && srcEnabled) || clearsReason;
}

/** Epoch ms of a stored timestamp ('YYYY-MM-DD HH:MM:SS' UTC or ISO); null when absent / unparseable. */
export function timestampMs(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const s = v.trim();
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * How recent a config row is, for reconcile's "source newer" rule. Every
 * config table has updated_at except feed_status, whose freshest event is
 * the newer of its last success / last failure (the breaker fields change
 * only on those events). null = unknown age (treated as oldest).
 */
export function configRowAge(table: ConfigTable, row: Record<string, unknown>): number | null {
  if (table === "feed_status") {
    const a = timestampMs(row.last_successful_pull);
    const b = timestampMs(row.last_failure);
    return a === null ? b : b === null ? a : Math.max(a, b);
  }
  return timestampMs(row.updated_at);
}

function upsertSql(table: ConfigTable): string {
  const cols = COPY_COLUMNS[table];
  const key = CONFIG_KEY[table];
  const set = cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(", ");
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(${key}) DO UPDATE SET ${set}`;
}

export interface CopyConfigParams {
  family: TelemetryFamily;
  dryRun: boolean;
  mode: ConfigCopyMode;
  direction: ConfigCopyDirection;
  force: boolean;
}

export function parseCopyConfigParams(sp: URLSearchParams): { ok: true; params: CopyConfigParams } | { ok: false; error: string } {
  const fam = parseFamily(sp);
  if (!fam.ok) return fam;
  const mode = sp.get("mode") ?? "insert";
  if (mode !== "insert" && mode !== "reconcile") return { ok: false, error: "mode must be insert or reconcile" };
  const direction = sp.get("direction") ?? "to_telemetry";
  if (direction !== "to_telemetry" && direction !== "to_core") return { ok: false, error: "direction must be to_telemetry or to_core" };
  if (direction === "to_core" && mode !== "reconcile") return { ok: false, error: "direction=to_core requires mode=reconcile" };
  const force = sp.get("force") === "1";
  if (force && mode !== "reconcile") return { ok: false, error: "force=1 requires mode=reconcile" };
  // A DRY RUN unless dry_run=0.
  return { ok: true, params: { family: fam.family, dryRun: sp.get("dry_run") !== "0", mode, direction, force } };
}

const diffKey = (family: TelemetryFamily, key: string): Pick<ConfigRowDiff, "key" | "agent_id"> =>
  family === "agents" ? { key, agent_id: key } : { key };

/**
 * Copy a family's config / state tables between core and TELEMETRY_DB.
 *
 *  mode=insert (default): rows missing on the target only, ON CONFLICT DO
 *    NOTHING — never touches an existing target row. The pre-flip seed.
 *  mode=reconcile: also overwrites a target row whose content differs, when
 *    the source row is the same age or newer (force=1: always). Run again
 *    after the flip once in-flight work has drained: runs / pulls / isolates
 *    still holding a cached 'core' route can trip a breaker, pause a feed or
 *    record an approval on core (agents ~90 s; feeds: the longest pull,
 *    ~11 min — see CLAUDE.md §8 runbook).
 *  direction=to_core (reconcile only): the reverse, before flipping back —
 *    config changes made while the route was 'telemetry' live only there.
 */
export async function copyTelemetryConfig(
  env: Env,
  opts: { dryRun: boolean; mode?: ConfigCopyMode; direction?: ConfigCopyDirection; force?: boolean; family?: TelemetryFamily },
): Promise<ConfigCopyResult> {
  const telemetry = await telemetryOrThrow(env);
  const family = opts.family ?? "agents";
  const mode = opts.mode ?? "insert";
  const direction = opts.direction ?? "to_telemetry";
  const force = opts.force === true;
  const source = direction === "to_telemetry" ? env.DB : telemetry;
  const target = direction === "to_telemetry" ? telemetry : env.DB;
  const tables: ConfigCopyTableResult[] = [];
  for (const table of FAMILY_CONFIG_TABLES[family]) {
    const key = CONFIG_KEY[table];
    const cols = COPY_COLUMNS[table].join(", ");
    const srcRows = (await source.prepare(`SELECT ${cols} FROM ${table}`).all<Record<string, unknown>>()).results ?? [];
    const tgtRows = (await target.prepare(`SELECT ${cols} FROM ${table}`).all<Record<string, unknown>>()).results ?? [];
    const tgtByKey = new Map(tgtRows.map((r) => [String(r[key]), r]));
    const plan: Array<{ row: Record<string, unknown>; diff: ConfigRowDiff }> = [];
    let differing = 0;
    for (const row of srcRows) {
      const id = String(row[key]);
      const tgt = tgtByKey.get(id);
      if (!tgt) {
        plan.push({ row, diff: { ...diffKey(family, id), action: "insert", changed: {} } });
        continue;
      }
      if (mode !== "reconcile") continue;
      const changed = configRowDiff(table, tgt, row);
      if (Object.keys(changed).length === 0) continue;
      differing++;
      const sourceNewer = (configRowAge(table, row) ?? -Infinity) >= (configRowAge(table, tgt) ?? -Infinity);
      const action: ConfigRowDiff["action"] = force
        ? "update"
        : PAUSABLE_TABLES.has(table) && wouldUnpause(tgt, row)
          ? "skip_unpause_needs_force"
          : sourceNewer ? "update" : "skip_target_newer";
      plan.push({ row, diff: { ...diffKey(family, id), action, changed } });
    }
    let inserted = 0;
    let updated = 0;
    if (!opts.dryRun) {
      const writes = plan.filter((p) => p.diff.action === "insert" || p.diff.action === "update");
      const sql = mode === "reconcile" ? upsertSql(table) : insertSql(table, key);
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
      skipped_unpause_needs_force: plan.filter((p) => p.diff.action === "skip_unpause_needs_force").length,
      diffs: plan.slice(0, CONFIG_DIFF_REPORT_LIMIT).map((p) => p.diff),
    });
  }
  return { family, dry_run: opts.dryRun, mode, direction, force, tables };
}

/**
 * Seed a missing agents-family config row on TELEMETRY_DB from core's row (Track B1c).
 * executeAgent calls this when the route is 'telemetry' and telemetry has no
 * row for the agent, so a flip made before copy-config can't reset a manual
 * pause / breaker state (agent_configs) or block a grandfathered agent
 * (agent_approvals). Without a core row it seeds nothing (the caller keeps
 * its own default). Returns true when a core row was copied.
 */
export async function seedConfigRowFromCore(env: Env, telemetry: D1Database, table: "agent_configs" | "agent_approvals", agentId: string): Promise<boolean> {
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

const ALL_HISTORY_TABLES: readonly TelemetryHistoryTable[] = TELEMETRY_FAMILIES.flatMap((f) => [...FAMILY_HISTORY_TABLES[f]]);

export interface BackfillParams {
  table: TelemetryHistoryTable;
  days: number;
  dryRun: boolean;
}

export function parseBackfillParams(sp: URLSearchParams): { ok: true; params: BackfillParams } | { ok: false; error: string } {
  const table = sp.get("table") ?? "";
  if (!(ALL_HISTORY_TABLES as readonly string[]).includes(table)) {
    return { ok: false, error: `table must be one of ${ALL_HISTORY_TABLES.join(", ")}` };
  }
  // family= is optional (the table names it); when given it must agree.
  if (sp.get("family") !== null) {
    const fam = parseFamily(sp);
    if (!fam.ok) return fam;
    if (HISTORY_TABLE_FAMILY[table as TelemetryHistoryTable] !== fam.family) {
      return { ok: false, error: `table ${table} belongs to family ${HISTORY_TABLE_FAMILY[table as TelemetryHistoryTable]}` };
    }
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

/** 'YYYY-MM' (UTC) for `ms` — agent_budget_rollups.year_month. */
export function yearMonth(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * One backfill chunk: a rowid seek on the table's own B-tree. NOT INDEXED +
 * the unary `+` on the time column keep the planner from range-scanning a
 * time index and sorting the whole remaining window by rowid (a TEMP B-TREE
 * per call); pinned by test/telemetry-agent-runs-cutover.test.ts and
 * test/telemetry-feeds-budget-cutover.test.ts with and without ANALYZE.
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
  family: TelemetryFamily;
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

/**
 * The window a FIRST backfill call fixes. For agent_budget_rollups (keyed
 * counters, PK agent_id + year_month) it is whole months, and `until` is
 * clamped to the oldest month already on telemetry: a month telemetry has
 * written to holds post-flip increments there and pre-flip ones on core, so
 * copying core's row would be dropped by ON CONFLICT DO NOTHING while the
 * split hid core's — losing spend. Months before it were never written on
 * telemetry (writes stamp the current month), and the month of (now − 24 h)
 * is excluded so a month is at least a day closed.
 */
async function initialWindow(telemetry: D1Database, table: TelemetryHistoryTable, days: number, nowMs: number): Promise<{ from: string; until: string }> {
  if (table !== "agent_budget_rollups") {
    return { from: sqliteTs(nowMs - days * 86_400_000), until: sqliteTs(nowMs - BACKFILL_HORIZON_HOURS * 3_600_000) };
  }
  const from = yearMonth(nowMs - days * 86_400_000);
  let until = yearMonth(nowMs - BACKFILL_HORIZON_HOURS * 3_600_000);
  const oldest = await telemetry.prepare(`SELECT MIN(year_month) AS m FROM agent_budget_rollups`).first<{ m: string | null }>();
  if (oldest?.m && oldest.m < until) until = oldest.m;
  return { from, until };
}

const ROLLUP_COMPARE_COLUMNS = ["total_input_tokens", "total_output_tokens", "total_cost_usd", "call_count"] as const;

/**
 * agent_budget_rollups chunk guard: a row the INSERT did not write (it
 * exists on telemetry) is fine only if telemetry holds the same counters (a
 * re-copy after a crash). Anything else would lose spend once the split
 * hides core's row, so the call stops before advancing the cursor.
 */
async function assertRollupConflictsIdentical(telemetry: D1Database, rows: Array<Record<string, unknown>>, results: D1Result[]): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    if (Number(results[i]?.meta?.changes ?? 0) > 0) continue;
    const r = rows[i]!;
    const t = await telemetry.prepare(
      `SELECT ${ROLLUP_COMPARE_COLUMNS.join(", ")} FROM agent_budget_rollups WHERE agent_id = ? AND year_month = ?`,
    ).bind(r.agent_id, r.year_month).first<Record<string, unknown>>();
    const differs = !t || ROLLUP_COMPARE_COLUMNS.some((c) => !sameValue(t[c], r[c]));
    if (differs) {
      throw new BackfillConflictError(
        `agent_budget_rollups (${String(r.agent_id)}, ${String(r.year_month)}) already exists on TELEMETRY_DB with different counters — not copied; the cursor was not advanced past it`,
      );
    }
  }
}

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
  const family = HISTORY_TABLE_FAMILY[table];
  const key = backfillCursorKey(table);
  const tc = HISTORY_TIME_COLUMN[table];

  const stored = parseBackfillCursor(await env.CACHE.get(key));
  const requestedFrom = table === "agent_budget_rollups"
    ? yearMonth(nowMs - params.days * 86_400_000)
    : sqliteTs(nowMs - params.days * 86_400_000);
  const cursor: BackfillCursor = stored ?? {
    ...(await initialWindow(telemetry, table, params.days, nowMs)),
    rowid: null,
    done: false,
    copied: 0,
    updated_at: new Date(nowMs).toISOString(),
  };
  const windowFixed = stored !== null && stored.from !== requestedFrom ? true : undefined;
  const base = { table, family, dry_run: params.dryRun, from: cursor.from, until: cursor.until, ...(windowFixed ? { window_fixed: true } : {}) };

  if (cursor.done) {
    return { ...base, scanned: 0, inserted: 0, cursor_rowid: cursor.rowid, copied_total: cursor.copied, done: true };
  }

  // First call: start at the first rowid inside the window (one indexed
  // MIN for every table but agent_events, which has no index on created_at
  // alone, so that one MIN is a single scan).
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
  const insert = insertSql(table, HISTORY_CONFLICT_KEY[table]);
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
      if (table === "agent_budget_rollups") await assertRollupConflictsIdentical(telemetry, rows, res);
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

export interface ConfigPreflight {
  table: ConfigTable;
  core_rows: number;
  telemetry_rows: number;
  missing_on_telemetry: string[];
  /** Rows whose flip-relevant content differs (≤ 50 reported). */
  content_mismatch: Array<{ key: string; agent_id?: string; changed: Record<string, { target: unknown; source: unknown }> }>;
}

export interface TelemetryPreflight {
  family: TelemetryFamily;
  ok: boolean;
  blocking: string[];
  warnings: string[];
  route: { route: string; requested: string | null; bound: boolean };
  tables: TablePreflight[];
  config: ConfigPreflight[];
  /** Telemetry-side counts only: a COUNT(*) over core's history tables is a full scan. */
  history: Array<{ table: TelemetryHistoryTable; telemetry_rows: number | null; backfill: BackfillCursor | null }>;
}

/**
 * The columns that change what an agent / feed / the AI throttle DOES after
 * the flip. A mismatch on any of them blocks the flip.
 */
export const PREFLIGHT_CONTENT_COLUMNS: Record<ConfigTable, readonly string[]> = {
  agent_configs: ["enabled", "paused_reason", "consecutive_failures", "consecutive_failure_threshold", "circuit_trip_rule"],
  agent_approvals: ["state"],
  feed_configs: ["enabled", "paused_reason", "consecutive_failure_threshold", "schedule_cron", "source_url", "feed_type", "taxii_next_added_after"],
  feed_status: ["consecutive_failures", "next_retry_at"],
  budget_config: ["monthly_limit_usd", "soft_pct", "hard_pct", "emergency_pct"],
};

/** Schema the preflight checks: agents keeps B1c's full wave-1 check; the others their own tables. */
const PREFLIGHT_SCHEMA_TABLES: Record<TelemetryFamily, readonly string[]> = {
  agents: WAVE1_TABLES,
  feeds: FAMILY_TABLES.feeds,
  budget: FAMILY_TABLES.budget,
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

/**
 * Every config row of `family` on `source` must be on `target` with the same
 * flip-relevant content. Used forwards (preflight: core → telemetry) and
 * backwards (a flip back to core: telemetry → core).
 */
async function configParity(
  family: TelemetryFamily,
  source: D1Database,
  target: D1Database,
  tableOk: (table: ConfigTable) => boolean,
): Promise<ConfigPreflight[]> {
  const out: ConfigPreflight[] = [];
  for (const table of FAMILY_CONFIG_TABLES[family]) {
    const key = CONFIG_KEY[table];
    const cols = COPY_COLUMNS[table].join(", ");
    const src = (await source.prepare(`SELECT ${cols} FROM ${table}`).all<Record<string, unknown>>()).results ?? [];
    const tgt = tableOk(table)
      ? new Map(((await target.prepare(`SELECT ${cols} FROM ${table}`).all<Record<string, unknown>>()).results ?? []).map((r) => [String(r[key]), r]))
      : new Map<string, Record<string, unknown>>();
    const missing: string[] = [];
    const mismatch: ConfigPreflight["content_mismatch"] = [];
    for (const row of src) {
      const id = String(row[key]);
      const t = tgt.get(id);
      if (!t) { missing.push(id); continue; }
      const changed = configRowDiff(table, t, row, PREFLIGHT_CONTENT_COLUMNS[table]);
      if (Object.keys(changed).length > 0) mismatch.push({ ...diffKey(family, id), changed });
    }
    out.push({
      table, core_rows: src.length, telemetry_rows: tgt.size,
      missing_on_telemetry: missing.slice(0, 50), content_mismatch: mismatch.slice(0, 50),
    });
  }
  return out;
}

export async function telemetryPreflight(env: Env, family: TelemetryFamily = "agents"): Promise<TelemetryPreflight> {
  const state = await familyRouteState(env, family);
  const blocking: string[] = [];
  const warnings: string[] = [];
  const result: TelemetryPreflight = {
    family,
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

  // Schema: the family's tables on telemetry, with core's columns + indexes.
  for (const table of PREFLIGHT_SCHEMA_TABLES[family]) {
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
  // flip-relevant content (pause / breaker state, approval, spend ceiling).
  const famQ = family === "agents" ? "" : `family=${family}&`;
  result.config = await configParity(family, env.DB, telemetry,
    (t) => result.tables.find((x) => x.table === t)?.columns_match === true);
  for (const c of result.config) {
    const missing = c.missing_on_telemetry.length;
    const mismatch = c.content_mismatch.length;
    if (missing > 0) blocking.push(`${c.table}: ${missing} core row(s) not copied to TELEMETRY_DB (POST /api/internal/telemetry/copy-config?${famQ}dry_run=0)`);
    if (mismatch > 0) blocking.push(`${c.table}: ${mismatch} row(s) differ from core in ${PREFLIGHT_CONTENT_COLUMNS[c.table].join(" / ")} — review POST /api/internal/telemetry/copy-config?${famQ}mode=reconcile (dry run), apply with dry_run=0; rows reported skip_target_newer or skip_unpause_needs_force need force=1 after review`);
  }

  // Budget: the AI spend ceiling. BudgetManager.getConfig() falls back to a
  // built-in default when the singleton row is missing, so the throttle would
  // silently run against the wrong limit — the row must be there.
  if (family === "budget" && result.tables.find((t) => t.table === "budget_config")?.columns_match === true) {
    const row = await telemetry.prepare(`SELECT id FROM budget_config WHERE id = 1`).first<{ id: number }>();
    if (!row) blocking.push("budget_config: the id=1 row (monthly AI ceiling) is missing on TELEMETRY_DB (POST /api/internal/telemetry/copy-config?family=budget&dry_run=0; if core has none either, set the ceiling first)");
  }

  // History: informational (the union reads cover anything not backfilled).
  for (const table of FAMILY_HISTORY_TABLES[family]) {
    let backfill: BackfillCursor | null = null;
    try { backfill = parseBackfillCursor(await env.CACHE.get(backfillCursorKey(table))); } catch { backfill = null; }
    const telRows = await countRows(telemetry, table);
    result.history.push({ table, telemetry_rows: telRows, backfill });
  }

  result.ok = blocking.length === 0;
  return result;
}

// ─── route flip ──────────────────────────────────────────────────

export interface FamilyRouteInfo {
  family: TelemetryFamily;
  kv_key: string;
  /** The parsed flag as KV holds it now (null = unset / invalid). */
  flag: TelemetryRoute | null;
  /** The route this isolate serves (≤ 60 s behind the flag). */
  route: TelemetryRoute;
  bound: boolean;
  /** The family's durable 'used' marker (ISO time of the first telemetry use), if any. */
  used_at: string | null;
}

/** GET /api/internal/telemetry/route — every family's flag and route. */
export async function telemetryRoutes(env: Env): Promise<FamilyRouteInfo[]> {
  const out: FamilyRouteInfo[] = [];
  for (const family of TELEMETRY_FAMILIES) {
    const state = await familyRouteState(env, family);
    let flag: TelemetryRoute | null = null;
    let usedAt: string | null = null;
    try { flag = parseTelemetryRoute(await env.CACHE.get(FAMILY_ROUTE_KV_KEYS[family])); } catch { flag = state.requested; }
    try { usedAt = await env.CACHE.get(FAMILY_USED_KV_KEYS[family]); } catch { usedAt = null; }
    out.push({ family, kv_key: FAMILY_ROUTE_KV_KEYS[family], flag, route: state.route, bound: state.bound, used_at: usedAt });
  }
  return out;
}

export interface SetRouteParams {
  family: TelemetryFamily;
  to: TelemetryRoute;
  dryRun: boolean;
  force: boolean;
}

export function parseSetRouteParams(sp: URLSearchParams): { ok: true; params: SetRouteParams } | { ok: false; error: string } {
  if (sp.get("family") === null) return { ok: false, error: "family is required (agents, feeds or budget)" };
  const fam = parseFamily(sp);
  if (!fam.ok) return fam;
  const to = parseTelemetryRoute(sp.get("to"));
  if (!to) return { ok: false, error: "to must be core or telemetry" };
  return { ok: true, params: { family: fam.family, to, dryRun: sp.get("dry_run") !== "0", force: sp.get("force") === "1" } };
}

export interface SetRouteResult {
  family: TelemetryFamily;
  dry_run: boolean;
  /** true = the flag was (or, on a dry run, would be) written. */
  allowed: boolean;
  written: boolean;
  from: TelemetryRoute | null;
  to: TelemetryRoute;
  refused_reasons: string[];
  /** Flip-to-telemetry gate. */
  preflight?: TelemetryPreflight;
  /** Flip-back gate: telemetry's config rows that core lacks / differs from. */
  reverse_config?: ConfigPreflight[];
  /** Isolates pick the new flag up within this many ms. */
  effective_within_ms: number;
  routes: FamilyRouteInfo[];
}

/**
 * Flip one family's route flag (owner-approved operator tool). Refuses
 * to=telemetry unless that family's preflight is ok; refuses to=core while
 * telemetry's config rows are missing on / differ from core (they would be
 * lost by the flip back) unless force=1. Writes nothing on a dry run.
 */
export async function setTelemetryRoute(env: Env, params: SetRouteParams): Promise<SetRouteResult> {
  const { family, to } = params;
  const refused: string[] = [];
  let preflight: TelemetryPreflight | undefined;
  let reverse: ConfigPreflight[] | undefined;
  const state = await familyRouteState(env, family);
  if (!state.bound) refused.push("TELEMETRY_DB is not bound in this environment");
  let from: TelemetryRoute | null = null;
  try { from = parseTelemetryRoute(await env.CACHE.get(FAMILY_ROUTE_KV_KEYS[family])); } catch { from = state.requested; }

  if (state.bound && to === "telemetry") {
    preflight = await telemetryPreflight(env, family);
    if (!preflight.ok) refused.push(...preflight.blocking.map((b) => `preflight: ${b}`));
  }
  if (state.bound && to === "core") {
    const telemetry = telemetryDbFor(env, "telemetry");
    reverse = await configParity(family, telemetry, env.DB, () => true);
    const stale = reverse.filter((c) => c.missing_on_telemetry.length > 0 || c.content_mismatch.length > 0);
    if (stale.length > 0 && !params.force) {
      const famQ = family === "agents" ? "" : `family=${family}&`;
      refused.push(
        `core's config differs from TELEMETRY_DB in ${stale.map((c) => c.table).join(", ")} — run POST /api/internal/telemetry/copy-config?${famQ}mode=reconcile&direction=to_core (dry run first), or pass force=1 to flip back anyway`,
      );
    }
  }

  const allowed = refused.length === 0;
  let written = false;
  if (allowed && !params.dryRun) {
    await env.CACHE.put(FAMILY_ROUTE_KV_KEYS[family], to);
    written = true;
  }
  return {
    family,
    dry_run: params.dryRun,
    allowed,
    written,
    from,
    to,
    refused_reasons: refused,
    ...(preflight ? { preflight } : {}),
    ...(reverse ? { reverse_config: reverse } : {}),
    effective_within_ms: TELEMETRY_ROUTE_CACHE_MS,
    routes: await telemetryRoutes(env),
  };
}
