// Averrow — daily database inventory + size samples (Databases page, A5)
//
// Once a day (Navigator, UTC hour 4 — hour-only gate, cron-audit rule) this
// records, per DB_REGISTRY store:
//   - the user-table list with bounded row estimates (lib/table-estimates.ts —
//     sqlite_stat1 / MAX(rowid) seeks, exact COUNT(*) only for small tables;
//     never a full scan of a large table);
//   - approximate bytes per table from SQLite's `dbstat` virtual table, when
//     D1 allows it and the database is under DBSTAT_MAX_DB_BYTES (dbstat
//     walks every page). A refusal is remembered for DBSTAT_DENIED_TTL_S so
//     it is tried once a week, not every day; bytes are then null;
//   - one size sample (lib/db-sizes.ts — Cloudflare's own figure, else PRAGMA).
//
// Storage is KV, not D1 (deliberate: the Databases page must stay readable
// while the core D1 is overloaded, the data is one small JSON per store, and
// 90 daily points × 4 stores is tiny):
//   `db_inventory:<store>`        latest DbInventory, 26 h TTL
//   `db_size_history:<store>`     [{date, bytes}] oldest → newest, ≤ 90 points,
//                                 one per UTC date (a re-run replaces that date)
//   `db_inventory:<YYYY-MM-DD>`   day state {attempts, pending[]} — written
//                                 after EVERY run. A later hour-4 tick runs
//                                 again only for the stores still pending
//                                 (failed), and at most DB_INVENTORY_MAX_RUNS_PER_DAY
//                                 runs a day, so a persistently failing store
//                                 never re-inventories the healthy ones
//   `db_inventory:claim`          best-effort claim (15 min) so overlapping
//                                 5-min ticks don't both run it
// Skipped while the D1 read budget is over its soft-cap (no run → no state →
// a later hour-4 tick, or tomorrow, retries). The run is D1-metered as its
// own exclusive layer `job:db_inventory` (lib/d1-meter.ts), not inside
// Navigator's agent row.
//
// Bookkeeping (CLAUDE.md §6): a handler-dispatched writer like
// daily_snapshots — `agent_runs` row (agent_id 'db_inventory') created at
// start and finalized via finalizeAgentRun with an overload-sized backoff,
// plus a telemetry `agent_events` row ('db_inventory_complete',
// target_agent NULL). Never throws (runs in a Navigator waitUntil tail).

import type { Env } from "../types";
import { createAgentRun, finalizeAgentRun, type AgentRunHandle, telemetryDbForRun } from "../db/agent-runs";
import { D1_OVERLOAD_RETRY_BASE_MS, withD1Retry } from "./d1-retry";
import { DB_REGISTRY, hasStore, storeBinding, type StoreId } from "./db-registry";
import { getDatabaseSizes, type DbSizeRow } from "./db-sizes";
import { withD1Meter } from "./d1-meter";
import { estimateTableRows, listUserTables, safeReader, type ReadDb } from "./table-estimates";

export const DB_INVENTORY_AGENT_ID = "db_inventory";
export const DB_INVENTORY_HOUR_UTC = 4;
export const DB_INVENTORY_TTL_S = 26 * 3600;
export const DB_SIZE_HISTORY_MAX_POINTS = 90;
/** Size history entries outlive their newest write by this (KV TTL). */
export const DB_SIZE_HISTORY_TTL_S = 120 * 86400;
export const DB_INVENTORY_CLAIM_KEY = "db_inventory:claim";
export const DB_INVENTORY_CLAIM_TTL_S = 15 * 60;
export const DB_INVENTORY_STAMP_TTL_S = 2 * 86400;
/** Runs per UTC day, first run included (a failed store is retried once). */
export const DB_INVENTORY_MAX_RUNS_PER_DAY = 2;
export const DB_INVENTORY_METER_LABEL = "job:db_inventory";
/** Tables kept per store in the stored inventory (largest by rows). */
export const DB_INVENTORY_MAX_TABLES = 50;
/** dbstat walks every page — only on databases at most this big. */
export const DBSTAT_MAX_DB_BYTES = 2 * 1024 ** 3;
export const DBSTAT_DENIED_TTL_S = 7 * 86400;
export const DB_INVENTORY_FINALIZE_BACKOFF_MS: readonly number[] = [3_000, 6_000, 12_000];

export const inventoryKey = (store: StoreId): string => `db_inventory:${store}`;
export const sizeHistoryKey = (store: StoreId): string => `db_size_history:${store}`;
export const inventoryStampKey = (date: string): string => `db_inventory:${date}`;
const dbstatDeniedKey = (store: StoreId): string => `db_inventory:dbstat_denied:${store}`;

export type DbstatStatus =
  | "ok"
  | "denied"
  | "skipped_large"
  | "skipped_unknown_size"
  | "skipped_denied_recently"
  | "error";

export interface InventoryTable {
  name: string;
  rows_estimate: number | null;
  rows_exact: boolean;
  bytes: number | null;
  estimate_divergent: boolean;
}

export interface DbInventory {
  store: StoreId;
  date: string;
  generated_at: string;
  size_bytes: number | null;
  size_source: DbSizeRow["source"];
  table_count: number;
  tables: InventoryTable[];
  dbstat: DbstatStatus;
  read_errors: number;
}

export interface SizePoint {
  date: string;
  bytes: number;
}

export interface DbInventoryDayState {
  /** Runs started today. */
  attempts: number;
  /** Stores not yet inventoried today (empty = done). */
  pending: StoreId[];
}

/** Parse the day state; a legacy / unparseable value means "done". */
export function parseDayState(raw: string | null): DbInventoryDayState | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw) as Partial<DbInventoryDayState>;
    if (v && typeof v === "object" && typeof v.attempts === "number" && Array.isArray(v.pending)) {
      return { attempts: v.attempts, pending: v.pending.filter((x): x is StoreId => DB_REGISTRY.some((s) => s.id === x)) };
    }
  } catch {
    /* fall through */
  }
  return { attempts: DB_INVENTORY_MAX_RUNS_PER_DAY, pending: [] };
}

export type DbInventoryRunResult =
  | { ran: true; status: "success" | "partial" | "failed"; stores: StoreId[]; failed: StoreId[]; runId: string | null }
  | { ran: false; reason: "not_inventory_hour" | "over_budget" | "done_today" | "claimed" | "no_cache" | "error"; error?: string };

export function isDbInventoryHour(nowMs: number): boolean {
  return new Date(nowMs).getUTCHours() === DB_INVENTORY_HOUR_UTC;
}

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Append/replace today's point, keep the newest `max`, oldest first. Pure. */
export function appendSizePoint(history: readonly SizePoint[], point: SizePoint, max = DB_SIZE_HISTORY_MAX_POINTS): SizePoint[] {
  const out = history.filter((p) => p.date !== point.date);
  out.push(point);
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out.slice(-max);
}

/** Parse a stored size history defensively (bad / missing → []). */
export function parseSizeHistory(raw: string | null): SizePoint[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((p): p is SizePoint =>
      typeof p === "object" && p !== null
      && typeof (p as SizePoint).date === "string"
      && typeof (p as SizePoint).bytes === "number" && Number.isFinite((p as SizePoint).bytes));
  } catch {
    return [];
  }
}

/** Parse a stored inventory defensively (bad / missing → null). */
export function parseInventory(raw: string | null): DbInventory | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as DbInventory;
    return v && typeof v === "object" && Array.isArray(v.tables) ? v : null;
  } catch {
    return null;
  }
}

/** A replica session when the binding supports one, else the binding. */
function readDbFor(db: D1Database): ReadDb {
  const ws = (db as { withSession?: unknown }).withSession;
  return typeof ws === "function" ? db.withSession("first-unconstrained") : db;
}

/**
 * dbstat bytes per TABLE (its own b-tree plus its indexes'), or a status
 * saying why not. One cheap probe, then one aggregate read.
 */
async function dbstatBytes(
  env: Env,
  store: StoreId,
  db: ReadDb,
  sizeBytes: number | null,
): Promise<{ status: DbstatStatus; bytes: Map<string, number> }> {
  const bytes = new Map<string, number>();
  // Unknown size: can't prove dbstat's full page walk is affordable.
  if (sizeBytes == null) return { status: "skipped_unknown_size", bytes };
  if (sizeBytes > DBSTAT_MAX_DB_BYTES) return { status: "skipped_large", bytes };
  if (await env.CACHE.get(dbstatDeniedKey(store))) return { status: "skipped_denied_recently", bytes };
  try {
    await db.prepare("SELECT name FROM dbstat LIMIT 1").all();
  } catch (e) {
    const m = errMsg(e);
    // D1 refuses virtual tables it doesn't expose (SQLITE_AUTH / no such
    // table). Remember it so tomorrow doesn't pay the probe again.
    if (/not authorized|SQLITE_AUTH|no such table|not allowed/i.test(m)) {
      await env.CACHE.put(dbstatDeniedKey(store), m.slice(0, 200), { expirationTtl: DBSTAT_DENIED_TTL_S });
      return { status: "denied", bytes };
    }
    return { status: "error", bytes };
  }
  try {
    // aggregate=TRUE: one row per b-tree. Map index b-trees to their table.
    const rows = (await db.prepare(
      `SELECT d.name AS name, COALESCE(m.tbl_name, d.name) AS tbl, d.pgsize AS bytes
         FROM dbstat AS d LEFT JOIN sqlite_master AS m ON m.name = d.name
        WHERE d.aggregate = 1`,
    ).all<{ name: string; tbl: string; bytes: number }>()).results;
    for (const r of rows) {
      if (typeof r.bytes !== "number" || !Number.isFinite(r.bytes)) continue;
      bytes.set(r.tbl, (bytes.get(r.tbl) ?? 0) + r.bytes);
    }
    return { status: "ok", bytes };
  } catch {
    return { status: "error", bytes };
  }
}

/** Inventory one bound store (no KV writes). Throws only if nothing could be read. */
export async function inventoryStore(
  env: Env,
  store: StoreId,
  size: DbSizeRow | undefined,
  nowMs: number,
): Promise<DbInventory> {
  // The store's OWN binding: a fallback (telemetry → core) would inventory
  // core's tables under the telemetry label.
  const binding = hasStore(env, store) ? storeBinding(env, store) : undefined;
  if (!binding) throw new Error(`store ${store} not bound`);
  const db = readDbFor(binding);
  const reader = safeReader(db);
  const list = await listUserTables(reader);
  if (list.length === 0 && reader.errors() > 0) {
    throw new Error(`store ${store}: table list unreadable`);
  }
  const rows = await estimateTableRows(reader, list);
  const sizeBytes = size?.sizeBytes ?? null;
  const ds = await dbstatBytes(env, store, db, sizeBytes);
  const tables: InventoryTable[] = rows.slice(0, DB_INVENTORY_MAX_TABLES).map((t) => ({
    name: t.name,
    rows_estimate: t.rows_exact ? t.rows : t.rows_estimate,
    rows_exact: t.rows_exact,
    bytes: ds.status === "ok" ? ds.bytes.get(t.name) ?? 0 : null,
    estimate_divergent: t.estimate_divergent,
  }));
  return {
    store,
    date: utcDate(nowMs),
    generated_at: new Date(nowMs).toISOString(),
    size_bytes: sizeBytes,
    size_source: size?.source ?? null,
    table_count: list.length,
    tables,
    dbstat: ds.status,
    read_errors: reader.errors(),
  };
}

async function writeInventory(env: Env, inv: DbInventory): Promise<void> {
  await env.CACHE.put(inventoryKey(inv.store), JSON.stringify(inv), { expirationTtl: DB_INVENTORY_TTL_S });
  if (inv.size_bytes == null) return;
  const history = parseSizeHistory(await env.CACHE.get(sizeHistoryKey(inv.store)));
  const next = appendSizePoint(history, { date: inv.date, bytes: inv.size_bytes });
  await env.CACHE.put(sizeHistoryKey(inv.store), JSON.stringify(next), { expirationTtl: DB_SIZE_HISTORY_TTL_S });
}

export interface DbInventoryOptions {
  env: Env;
  nowMs: number;
  /** True when the D1 read budget is over its soft-cap — skip. */
  overBudget?: boolean;
  /** Override for tests (default DB_INVENTORY_FINALIZE_BACKOFF_MS). */
  finalizeBackoffMs?: readonly number[];
  /** Override for tests (default D1_OVERLOAD_RETRY_BASE_MS). */
  overloadBaseMs?: number;
}

/**
 * Navigator's daily inventory. Hour-only gate, then: skip over budget, skip
 * when today's stamp exists, skip when another tick holds the claim;
 * otherwise claim, inventory every bound store sequentially, stamp the day
 * when no store failed. Never throws.
 */
export async function runDbInventory(opts: DbInventoryOptions): Promise<DbInventoryRunResult> {
  const { env, nowMs } = opts;
  if (!isDbInventoryHour(nowMs)) return { ran: false, reason: "not_inventory_hour" };
  if (opts.overBudget) return { ran: false, reason: "over_budget" };
  if (!env.CACHE) return { ran: false, reason: "no_cache" };
  const date = utcDate(nowMs);
  let state: DbInventoryDayState | null;
  try {
    state = parseDayState(await env.CACHE.get(inventoryStampKey(date)));
    if (state && (state.pending.length === 0 || state.attempts >= DB_INVENTORY_MAX_RUNS_PER_DAY)) {
      return { ran: false, reason: "done_today" };
    }
    if (await env.CACHE.get(DB_INVENTORY_CLAIM_KEY)) return { ran: false, reason: "claimed" };
    await env.CACHE.put(DB_INVENTORY_CLAIM_KEY, new Date(nowMs).toISOString(), {
      expirationTtl: DB_INVENTORY_CLAIM_TTL_S,
    });
  } catch (e) {
    return { ran: false, reason: "error", error: errMsg(e) };
  }
  const targets = state?.pending ?? null; // null = every bound store
  const attempts = (state?.attempts ?? 0) + 1;
  return withD1Meter(env, DB_INVENTORY_METER_LABEL, (meteredEnv) =>
    inventoryRun(meteredEnv, opts, date, targets, attempts));
}

async function inventoryRun(
  env: Env,
  opts: DbInventoryOptions,
  date: string,
  targets: StoreId[] | null,
  attempts: number,
): Promise<DbInventoryRunResult> {
  const { nowMs } = opts;
  let run: AgentRunHandle | null = null;
  const done: StoreId[] = [];
  const failed: StoreId[] = [];
  const errors: string[] = [];
  let tablesSeen = 0;
  let status: "success" | "partial" | "failed" = "failed";
  try {
    try {
      run = await createAgentRun(env, DB_INVENTORY_AGENT_ID);
    } catch {
      run = null; // bookkeeping is best-effort; the inventory still runs
    }
    let sizes: DbSizeRow[] = [];
    try {
      sizes = (await getDatabaseSizes(env)).databases;
    } catch (e) {
      errors.push(`sizes: ${errMsg(e)}`);
    }
    for (const spec of DB_REGISTRY) {
      if (!hasStore(env, spec.id)) continue;
      if (targets && !targets.includes(spec.id)) continue; // retry: failed stores only
      try {
        const inv = await inventoryStore(env, spec.id, sizes.find((s) => s.store === spec.id), nowMs);
        await writeInventory(env, inv);
        tablesSeen += inv.table_count;
        done.push(spec.id);
      } catch (e) {
        failed.push(spec.id);
        errors.push(`${spec.id}: ${errMsg(e)}`);
      }
    }
    status = failed.length === 0 ? "success" : done.length > 0 ? "partial" : "failed";
  } catch (e) {
    status = "failed";
    errors.push(errMsg(e));
  } finally {
    // Day state after EVERY run: only `failed` stays pending, and the
    // attempt count caps the day (DB_INVENTORY_MAX_RUNS_PER_DAY).
    try {
      // A whole-run failure outside the per-store loop leaves `failed` empty;
      // keep the run's targets pending so the retry still happens.
      const pending: StoreId[] = status === "failed" && failed.length === 0
        ? (targets ?? DB_REGISTRY.filter((spec) => hasStore(env, spec.id)).map((spec) => spec.id))
        : failed;
      const state: DbInventoryDayState = { attempts, pending };
      await env.CACHE.put(inventoryStampKey(date), JSON.stringify(state), { expirationTtl: DB_INVENTORY_STAMP_TTL_S });
    } catch (e) {
      errors.push(`day state: ${errMsg(e)}`);
    }
    const errorMessage = errors.length > 0 ? errors.join("; ").slice(0, 1000) : null;
    if (run) {
      const backoff = opts.finalizeBackoffMs ?? DB_INVENTORY_FINALIZE_BACKOFF_MS;
      await finalizeAgentRun(
        env,
        run,
        status === "failed"
          ? { kind: "failed", error_message: errorMessage ?? "db inventory failed" }
          : {
              kind: "complete",
              stats: {
                records_processed: tablesSeen,
                outputs_generated: done.length,
                status,
                error_message: errorMessage,
              },
            },
        { backoffMs: backoff, attempts: backoff.length + 1 },
      );
    }
    // Telemetry-only completion event (target_agent NULL): recorded by the
    // orchestrator's consumer, never dispatched. One id + ON CONFLICT DO
    // NOTHING, so a retry after an ambiguous failure writes it once.
    const eventId = crypto.randomUUID();
    const payload = JSON.stringify({ date, status, stores: done, failed });
    try {
      await withD1Retry(
        async () =>
          (await telemetryDbForRun(env, run)).prepare(
            `INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status)
             VALUES (?, 'db_inventory_complete', ?, NULL, ?, 3, 'pending')
             ON CONFLICT DO NOTHING`,
          ).bind(eventId, DB_INVENTORY_AGENT_ID, payload).run(),
        { label: "db_inventory event", retries: 3, overloadBaseMs: opts.overloadBaseMs ?? D1_OVERLOAD_RETRY_BASE_MS },
      );
    } catch {
      /* telemetry only */
    }
  }
  return { ran: true, status, stores: done, failed, runId: run?.id ?? null };
}

/** Latest stored inventory for a store (null when none / unreadable). */
export async function readInventory(env: Env, store: StoreId): Promise<DbInventory | null> {
  return parseInventory(await env.CACHE.get(inventoryKey(store)));
}

/** Stored size history for a store, oldest first. */
export async function readSizeHistory(env: Env, store: StoreId): Promise<SizePoint[]> {
  return parseSizeHistory(await env.CACHE.get(sizeHistoryKey(store)));
}
