// Averrow — union reads for the agent-runs family during the telemetry
// cut-over (Track B1c).
//
// Writes go FORWARD: once `db_route:telemetry` says 'telemetry', every new
// agent_runs / agent_events / agent_activity_log row is inserted into
// TELEMETRY_DB (lib/db-route.ts), and a row is always finalized on the DB it
// was inserted into. History written before the flip stays on core until the
// backfill (lib/telemetry-cutover.ts) has copied it. A history read
// therefore has to look at BOTH databases while the route is 'telemetry':
//
//   route 'core', telemetry never used → one part: the caller's core DB (or
//                       read session) — exactly today's single read.
//   route 'telemetry', or 'core' after a flip back (durable KV marker
//   db_route:telemetry_used, lib/db-route.ts) → two parts: telemetry first,
//                       then core.
//
// Rows are disjoint across the two DBs except for rows the backfill copied.
// The backfill (lib/telemetry-cutover.ts) copies core rows whose time column
// is in a FIXED window [from, until) in core rowid order, and records the
// last copied rowid in KV. So the copied set is exactly
//   rowid <= cursor.rowid AND from <= time < until
// and the core part of every read gets a SPLIT predicate that excludes it:
// aggregates (COUNT / SUM / AVG / MAX) summed across the two parts never
// count a row twice. `until` is at least 24 h before the backfill started,
// so only finished rows (terminal status, never updated again) are copied.
// Row reads additionally dedupe by primary key, so they stay correct even
// while an isolate holds a stale cursor (cached <= 60 s: during an active
// backfill an aggregate may count the last copied batch twice for up to a
// minute — acceptable for operator telemetry). The split relies on core
// rowids being stable (D1 never VACUUMs a live database).
//
// agent_configs / agent_approvals are small config tables: they are copied
// before the flip (POST /api/internal/telemetry/copy-config) and then read
// from the routed store only — use `telemetryStore(env)` for those.
//
// Never hand-roll a union in a caller: build the parts with historyParts()
// and read through unionRows / unionFirst / unionGrouped.

//
// agent_outputs (wave 2) is an agents-family history table: it follows
// `db_route:telemetry` and the agents 'used' marker like agent_runs. It is
// append-only (no writer UPDATEs a row), so a row read from either part is
// final; JOINs to core tables (campaigns, brands) are never written in SQL —
// read the outputs through the union, then look the core rows up separately.
//
// Feeds / budget families (Track B1d) use the same machinery: their history
// tables are feed_pull_history, budget_ledger and agent_budget_rollups, and
// each table's union follows ITS family's route + 'used' marker
// (lib/db-route.ts), so cutting one family over never changes another
// family's reads. agent_budget_rollups is a keyed counter table (PK agent_id,
// year_month, upserted in place): a month's row can exist on both DBs (core
// holds the increments made before the flip, telemetry the ones after), so
// its readers always SUM per (agent_id, year_month) across the parts
// (unionGrouped), and its backfill copies only CLOSED months that have no row
// on telemetry (lib/telemetry-cutover.ts).

import type { Env } from "../types";
import { familyEverUsed, familyRouteState, telemetryDbFor, type TelemetryFamily } from "./db-route";

export type ReadDb = Pick<D1Database, "prepare">;

/** History tables per family (append / finalize-in-place; rollups: keyed counters). */
export type TelemetryHistoryTable =
  | "agent_runs" | "agent_events" | "agent_activity_log" | "agent_outputs"
  | "feed_pull_history"
  | "budget_ledger" | "agent_budget_rollups";

/** Time column per history table (the backfill window is on it). */
export const HISTORY_TIME_COLUMN: Record<TelemetryHistoryTable, string> = {
  agent_runs: "started_at",
  agent_events: "created_at",
  agent_activity_log: "created_at",
  agent_outputs: "created_at",
  feed_pull_history: "started_at",
  budget_ledger: "created_at",
  // 'YYYY-MM' — the backfill window is in whole months (closed months only).
  agent_budget_rollups: "year_month",
};

/** The family whose route + marker a history table's reads follow. */
export const HISTORY_TABLE_FAMILY: Record<TelemetryHistoryTable, TelemetryFamily> = {
  agent_runs: "agents",
  agent_events: "agents",
  agent_activity_log: "agents",
  agent_outputs: "agents",
  feed_pull_history: "feeds",
  budget_ledger: "budget",
  agent_budget_rollups: "budget",
};

/**
 * The agents family's history tables (B1c; the default backfill / preflight
 * set). agent_outputs (wave 2) is append-only: every row is final on insert,
 * so the 24 h backfill horizon only keeps the window consistent with the
 * other tables.
 */
export const TELEMETRY_HISTORY_TABLES: readonly TelemetryHistoryTable[] = ["agent_runs", "agent_events", "agent_activity_log", "agent_outputs"];

/** History tables per family. */
export const FAMILY_HISTORY_TABLES: Record<TelemetryFamily, readonly TelemetryHistoryTable[]> = {
  agents: TELEMETRY_HISTORY_TABLES,
  feeds: ["feed_pull_history"],
  budget: ["budget_ledger", "agent_budget_rollups"],
};

/** KV key holding the backfill cursor for one history table. */
export const backfillCursorKey = (table: TelemetryHistoryTable): string => `telemetry_backfill:${table}`;

export interface BackfillCursor {
  /** Copied window on the time column, [from, until); fixed once the backfill starts. */
  from: string;
  until: string;
  /** Last copied core rowid; null until the first chunk was copied. */
  rowid: number | null;
  done: boolean;
  copied: number;
  updated_at: string;
}

export function parseBackfillCursor(raw: string | null): BackfillCursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<BackfillCursor>;
    if (typeof v.from !== "string" || typeof v.until !== "string") return null;
    return {
      from: v.from,
      until: v.until,
      rowid: typeof v.rowid === "number" && Number.isFinite(v.rowid) ? v.rowid : null,
      done: v.done === true,
      copied: typeof v.copied === "number" ? v.copied : 0,
      updated_at: typeof v.updated_at === "string" ? v.updated_at : "",
    };
  } catch {
    return null;
  }
}

const CURSOR_CACHE_MS = 60_000;
const cursorCache = new Map<TelemetryHistoryTable, { cursor: BackfillCursor | null; expiresAt: number }>();

/** Test hook: forget cached backfill cursors. */
export function resetBackfillCursorCache(): void {
  cursorCache.clear();
}

/** Drop one cached cursor (the backfill calls this after advancing it). */
export function forgetBackfillCursor(table: TelemetryHistoryTable): void {
  cursorCache.delete(table);
}

async function readCursor(env: Env, table: TelemetryHistoryTable, nowMs: number): Promise<BackfillCursor | null> {
  const hit = cursorCache.get(table);
  if (hit && nowMs < hit.expiresAt) return hit.cursor;
  let cursor: BackfillCursor | null = hit?.cursor ?? null;
  try {
    cursor = parseBackfillCursor(await env.CACHE.get(backfillCursorKey(table)));
  } catch {
    // KV blip: keep the last known cursor. Unknown → no split (core counts
    // everything) — at worst copied rows are double-counted, never lost.
  }
  cursorCache.set(table, { cursor, expiresAt: nowMs + CURSOR_CACHE_MS });
  return cursor;
}

/**
 * SQL that keeps a core row only if the backfill has NOT copied it (see the
 * header). A NULL time column is never inside the window, so it stays.
 */
export function coreSplitPredicate(table: TelemetryHistoryTable, cursor: BackfillCursor | null, alias = ""): { split: string; splitBinds: unknown[] } {
  if (!cursor || cursor.rowid === null) return { split: "", splitBinds: [] };
  const a = alias ? `${alias}.` : "";
  const tc = `COALESCE(${a}${HISTORY_TIME_COLUMN[table]}, '')`;
  return {
    split: ` AND NOT (${a}rowid <= ? AND ${tc} >= ? AND ${tc} < ?)`,
    splitBinds: [cursor.rowid, cursor.from, cursor.until],
  };
}

export interface ReadPart {
  source: "telemetry" | "core";
  /** Where this part is read from (core: the caller's DB / read session). */
  db: ReadDb;
  /** Where a row read from this part is written back (claim / finalize); absent without env. */
  writeDb?: D1Database;
  /** Appended to the WHERE clause of this part's query ('' = nothing). */
  split: string;
  splitBinds: unknown[];
}

/**
 * The read plan for one history table. Without `env` (unit tests handing in
 * a bare DB) or with route 'core' it is one core part with no split.
 */
export async function historyParts(
  env: Env | undefined,
  table: TelemetryHistoryTable,
  opts: {
    core?: ReadDb;
    alias?: string;
    nowMs?: number;
    /**
     * Put the part of the family's CURRENT route first (core first after a
     * flip back). For a query that JOINs a history table to its family's
     * config table (feed_pull_history ⋈ feed_configs) and merges groups
     * first-seen-wins: the config columns then come from the routed store.
     * Default (false): telemetry first, as B1c.
     */
    routedFirst?: boolean;
  } = {},
): Promise<ReadPart[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const core = opts.core ?? env?.DB;
  if (!core) throw new Error("telemetry-read: no core database");
  if (!env) return [{ source: "core", db: core, split: "", splitBinds: [] }];
  const family = HISTORY_TABLE_FAMILY[table];
  const { route, bound } = await familyRouteState(env, family, nowMs);
  // Both DBs while the route is 'telemetry' AND after it ever was (rollback
  // safety: a flip back to core must not hide the rows written on telemetry).
  const readBoth = route === "telemetry" || (bound && (await familyEverUsed(env, family, nowMs)));
  if (!readBoth) {
    return [{ source: "core", db: core, writeDb: env.DB, split: "", splitBinds: [] }];
  }
  const telemetry = telemetryDbFor(env, "telemetry");
  const cursor = await readCursor(env, table, nowMs);
  const parts: ReadPart[] = [
    { source: "telemetry", db: telemetry, writeDb: telemetry, split: "", splitBinds: [] },
    { source: "core", db: core, writeDb: env.DB, ...coreSplitPredicate(table, cursor, opts.alias) },
  ];
  return opts.routedFirst && route === "core" ? [parts[1]!, parts[0]!] : parts;
}

/**
 * The parts of a family's history read, or null when the family reads ONE
 * core part (route core, telemetry never used) — the caller then runs its
 * pre-cut-over statement unchanged. For readers whose single-DB statement
 * JOINs a history table to a core table and must be split on the union path.
 */
export async function historyPartsIfUnion(
  env: Env,
  table: TelemetryHistoryTable,
  opts: Parameters<typeof historyParts>[2] = {},
): Promise<ReadPart[] | null> {
  const parts = await historyParts(env, table, opts);
  return parts.length > 1 ? parts : null;
}

export interface PartQuery {
  sql: string;
  binds: unknown[];
}

/**
 * Builds one part's statement. `split` must be appended inside the WHERE
 * clause and `splitBinds` placed at the matching position. `limit` /
 * `offset` are what this part should apply: the caller's own values on a
 * single-part read, `limit + offset` / 0 on a union (re-paged in code).
 */
export type PartBuilder = (p: { split: string; splitBinds: unknown[]; limit: number; offset: number; source: ReadPart["source"] }) => PartQuery;

export interface ReadMeta {
  rows_read: number;
  rows_written: number;
}

function sumMeta(list: ReadMeta[]): ReadMeta {
  return list.reduce((a, m) => ({ rows_read: a.rows_read + m.rows_read, rows_written: a.rows_written + m.rows_written }), { rows_read: 0, rows_written: 0 });
}

/**
 * Where a query takes the split: write this marker (a plain SQL comment)
 * inside the WHERE clause of a static SQL literal, and leave the split's
 * binds out of `binds` — the helpers splice them in at the marker. Keeps the
 * SQL a literal without interpolation (so plan / static tests can extract
 * it) and valid as-is: on a single core part the marker is just a comment.
 */
export const SPLIT_MARKER = "/*split*/";

/** Number of `?` placeholders before `end` (outside quotes and comments). */
function placeholdersBefore(sql: string, end: number): number {
  let n = 0;
  for (let i = 0; i < end; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const close = sql.indexOf(c, i + 1);
      i = close < 0 ? end : close;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? end : nl;
    } else if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close < 0 ? end : close + 1;
    } else if (c === "?") {
      n++;
    }
  }
  return n;
}

/**
 * The statement a part runs: every SPLIT_MARKER replaced by the part's split
 * (with its binds spliced in at that position), else `q` verbatim. Exported
 * for callers that run per-part statements themselves (batches).
 */
export function applySplit(part: Pick<ReadPart, "split" | "splitBinds">, q: PartQuery): PartQuery {
  if (!q.sql.includes(SPLIT_MARKER)) return q;
  let sql = q.sql;
  const binds = [...q.binds];
  let at = sql.indexOf(SPLIT_MARKER);
  while (at >= 0) {
    const pos = placeholdersBefore(sql, at);
    sql = sql.slice(0, at) + part.split + sql.slice(at + SPLIT_MARKER.length);
    binds.splice(pos, 0, ...part.splitBinds);
    at = sql.indexOf(SPLIT_MARKER, at + part.split.length);
  }
  return { sql, binds };
}

/** The part's statement; unbound when there is nothing to bind (as the pre-union callers did). */
function prepared(part: ReadPart, q: PartQuery): D1PreparedStatement {
  const { sql, binds } = applySplit(part, q);
  const stmt = part.db.prepare(sql);
  return binds.length > 0 ? stmt.bind(...binds) : stmt;
}

async function runPartWithMeta<T>(part: ReadPart, q: PartQuery): Promise<{ rows: T[]; meta: ReadMeta }> {
  const r = await prepared(part, q).all<T>();
  const m = (r as { meta?: { rows_read?: number; rows_written?: number } }).meta;
  return { rows: r.results ?? [], meta: { rows_read: m?.rows_read ?? 0, rows_written: m?.rows_written ?? 0 } };
}

export interface UnionRowsOptions<T> {
  /** Primary key for dedupe across parts (a backfilled row exists on both). */
  key?: (row: T) => string;
  /** Which duplicate to keep; default: the first seen (telemetry). */
  prefer?: (seen: T, other: T) => T;
  /** Re-applied ordering of the merged rows (the parts' ORDER BY). */
  sort?: (a: T, b: T) => number;
  limit?: number;
  offset?: number;
  /** Helper-only columns (e.g. a sort key) removed from every returned row. */
  drop?: string[];
}

/** Rows tagged with the part they came from (for write-back to the same DB). */
export async function unionRowsWithPart<T>(
  parts: ReadPart[],
  build: PartBuilder,
  opts: UnionRowsOptions<T> = {},
): Promise<Array<{ row: T; part: ReadPart }>> {
  return (await unionRowsCore<T>(parts, build, opts)).items;
}

async function unionRowsCore<T>(
  parts: ReadPart[],
  build: PartBuilder,
  opts: UnionRowsOptions<T>,
): Promise<{ items: Array<{ row: T; part: ReadPart }>; meta: ReadMeta }> {
  const metas: ReadMeta[] = [];
  const items = await unionRowsMerge<T>(parts, build, opts, metas);
  return { items, meta: sumMeta(metas) };
}

async function unionRowsMerge<T>(
  parts: ReadPart[],
  build: PartBuilder,
  opts: UnionRowsOptions<T>,
  metas: ReadMeta[],
): Promise<Array<{ row: T; part: ReadPart }>> {
  const single = parts.length === 1;
  const limit = opts.limit ?? 0;
  const offset = opts.offset ?? 0;
  const perPart = await Promise.all(
    parts.map(async (part) => {
      const q = build({
        split: part.split,
        splitBinds: part.splitBinds,
        limit: single ? limit : limit + offset,
        offset: single ? offset : 0,
        source: part.source,
      });
      const out = await runPartWithMeta<T>(part, q);
      metas.push(out.meta);
      return out.rows.map((row) => ({ row, part }));
    }),
  );
  if (single) return perPart[0] ?? [];
  let merged: Array<{ row: T; part: ReadPart }> = [];
  if (opts.key) {
    const byKey = new Map<string, { row: T; part: ReadPart }>();
    for (const list of perPart) {
      for (const item of list) {
        const k = opts.key(item.row);
        const seen = byKey.get(k);
        if (!seen) byKey.set(k, item);
        else if (opts.prefer && opts.prefer(seen.row, item.row) !== seen.row) byKey.set(k, item);
      }
    }
    merged = [...byKey.values()];
  } else {
    merged = perPart.flat();
  }
  if (opts.sort) {
    const cmp = opts.sort;
    merged.sort((a, b) => cmp(a.row, b.row));
  }
  if (opts.limit !== undefined) merged = merged.slice(offset, offset + limit);
  return merged;
}

/** Union of a row read across parts; one part = exactly that part's rows. */
export async function unionRows<T>(parts: ReadPart[], build: PartBuilder, opts: UnionRowsOptions<T> = {}): Promise<T[]> {
  return dropColumns((await unionRowsWithPart<T>(parts, build, opts)).map((x) => x.row), opts.drop);
}

/** unionRows plus a D1Result-shaped `meta` (rows read summed over parts). */
export async function unionRowsResult<T>(parts: ReadPart[], build: PartBuilder, opts: UnionRowsOptions<T> = {}): Promise<{ results: T[]; meta: ReadMeta }> {
  const { items, meta } = await unionRowsCore<T>(parts, build, opts);
  return { results: dropColumns(items.map((x) => x.row), opts.drop), meta };
}

/** First row of a union read (the caller's ORDER BY is re-applied via `sort`). */
export async function unionFirst<T>(parts: ReadPart[], build: PartBuilder, opts: Omit<UnionRowsOptions<T>, "limit" | "offset"> = {}): Promise<T | null> {
  if (parts.length === 1) {
    const part = parts[0]!;
    const q = build({ split: part.split, splitBinds: part.splitBinds, limit: 1, offset: 0, source: part.source });
    return prepared(part, q).first<T>();
  }
  const rows = await unionRows<T>(parts, build, { ...opts, limit: 1 });
  return rows[0] ?? null;
}

type NumKey<T> = Extract<keyof T, string>;

/**
 * How to merge per-part aggregate rows. Every output column the query
 * returns must be listed in exactly one bucket. SQL semantics are kept: SUM
 * of only NULLs stays NULL; MAX/MIN ignore NULL; AVG is merged weighted by a
 * companion count column (COUNT(col) — not COUNT(*) — so NULLs match SQL).
 */
export interface GroupSpec<T> {
  groupBy?: NumKey<T>[];
  /** COUNT(...) / SUM(...) columns. */
  sum?: NumKey<T>[];
  max?: NumKey<T>[];
  min?: NumKey<T>[];
  avg?: Array<{ col: NumKey<T>; weight: NumKey<T> }>;
  /** Re-applied ordering of the merged groups. */
  sort?: (a: T, b: T) => number;
  limit?: number;
  /**
   * Helper-only columns (e.g. an AVG's weight) removed from every returned
   * row — on the single-part path too, so callers see the same row shape
   * whichever route served them.
   */
  drop?: string[];
}

function dropColumns<T>(rows: T[], drop: string[] | undefined): T[] {
  if (!drop || drop.length === 0) return rows;
  return rows.map((r) => {
    const copy = { ...(r as Record<string, unknown>) };
    for (const c of drop) delete copy[c];
    return copy as T;
  });
}

function addNullable(a: unknown, b: unknown): unknown {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Number(a) + Number(b);
}

function pick(a: unknown, b: unknown, wantMax: boolean): unknown {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  if (typeof a === "number" && typeof b === "number") return wantMax ? Math.max(a, b) : Math.min(a, b);
  const sa = String(a);
  const sb = String(b);
  return wantMax ? (sb > sa ? b : a) : (sb < sa ? b : a);
}

/** Merge per-part aggregate rows (exported for tests). */
export function mergeGroupedRows<T>(lists: T[][], spec: GroupSpec<T>): T[] {
  const groupBy = spec.groupBy ?? [];
  const groups = new Map<string, Record<string, unknown>>();
  for (const list of lists) {
    for (const raw of list) {
      const row = raw as unknown as Record<string, unknown>;
      const k = JSON.stringify(groupBy.map((g) => row[g] ?? null));
      const acc = groups.get(k);
      if (!acc) {
        groups.set(k, { ...row });
        continue;
      }
      for (const { col, weight } of spec.avg ?? []) {
        const wa = Number(acc[weight] ?? 0);
        const wb = Number(row[weight] ?? 0);
        const va = acc[col];
        const vb = row[col];
        if (wa + wb > 0) {
          acc[col] = ((va == null ? 0 : Number(va)) * wa + (vb == null ? 0 : Number(vb)) * wb) / (wa + wb);
        } else {
          acc[col] = va ?? vb ?? null;
        }
      }
      for (const c of spec.sum ?? []) acc[c] = addNullable(acc[c], row[c]);
      for (const c of spec.max ?? []) acc[c] = pick(acc[c], row[c], true);
      for (const c of spec.min ?? []) acc[c] = pick(acc[c], row[c], false);
    }
  }
  let out = [...groups.values()] as unknown as T[];
  // A no-GROUP-BY aggregate returns one row per part even over zero rows
  // (COUNT 0, SUM NULL) — merged above into one; keep that shape.
  if (spec.sort) out.sort(spec.sort);
  if (spec.limit !== undefined) out = out.slice(0, spec.limit);
  return out;
}

/** Aggregate read across parts, merged per group. One part = that part's rows verbatim. */
export async function unionGrouped<T>(parts: ReadPart[], build: PartBuilder, spec: GroupSpec<T>): Promise<T[]> {
  return (await unionGroupedResult<T>(parts, build, spec)).results;
}

/** unionGrouped plus a D1Result-shaped `meta` (rows read summed over parts). */
export async function unionGroupedResult<T>(parts: ReadPart[], build: PartBuilder, spec: GroupSpec<T>): Promise<{ results: T[]; meta: ReadMeta }> {
  const outs = await Promise.all(
    parts.map((part) =>
      runPartWithMeta<T>(part, build({ split: part.split, splitBinds: part.splitBinds, limit: spec.limit ?? 0, offset: 0, source: part.source })),
    ),
  );
  const meta = sumMeta(outs.map((o) => o.meta));
  if (parts.length === 1) return { results: dropColumns(outs[0]?.rows ?? [], spec.drop), meta };
  return { results: dropColumns(mergeGroupedRows(outs.map((o) => o.rows), spec), spec.drop), meta };
}

/** A no-GROUP-BY aggregate (`.first()` shape) across parts. */
export async function unionAggregateFirst<T>(parts: ReadPart[], build: PartBuilder, spec: Omit<GroupSpec<T>, "groupBy" | "sort" | "limit">): Promise<T | null> {
  if (parts.length === 1) {
    const part = parts[0]!;
    const q = build({ split: part.split, splitBinds: part.splitBinds, limit: 0, offset: 0, source: part.source });
    const row = await prepared(part, q).first<T>();
    return row === null ? null : (dropColumns([row], spec.drop)[0] ?? null);
  }
  const rows = await unionGrouped<T>(parts, build, spec);
  return rows[0] ?? null;
}

// ─── Comparators / merge rules ────────────────────────────────────

export function byDesc<T>(col: NumKey<T>, tie?: NumKey<T>): (a: T, b: T) => number {
  return (a, b) => {
    const va = String((a as Record<string, unknown>)[col] ?? "");
    const vb = String((b as Record<string, unknown>)[col] ?? "");
    if (va !== vb) return va < vb ? 1 : -1;
    if (!tie) return 0;
    const ta = String((a as Record<string, unknown>)[tie] ?? "");
    const tb = String((b as Record<string, unknown>)[tie] ?? "");
    return ta === tb ? 0 : ta < tb ? 1 : -1;
  };
}

export function byAsc<T>(col: NumKey<T>): (a: T, b: T) => number {
  const d = byDesc<T>(col);
  return (a, b) => -d(a, b);
}

/**
 * agent_runs duplicate rule: a backfilled copy can be older than the core
 * row (copied while open). Prefer the finalized one; tie → the first seen.
 */
export function preferFinalizedRun<T>(seen: T, other: T): T {
  const s = seen as Record<string, unknown>;
  const o = other as Record<string, unknown>;
  if ((s.completed_at === null || s.completed_at === undefined) && o.completed_at != null) return other;
  return seen;
}

export const byId = <T extends { id?: unknown }>(r: T): string => String(r.id);
