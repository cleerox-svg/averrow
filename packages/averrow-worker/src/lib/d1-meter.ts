/**
 * d1-meter.ts — per-job D1 rows_read / rows_written attribution.
 *
 * Wraps a D1 binding in a Proxy that sums `meta.rows_read`,
 * `meta.rows_written` and a query count into a `D1Tally` for every
 * statement executed through it — `prepare().bind()…all()/run()/first()`,
 * `batch()`, `exec()`, and everything prepared on a `withSession()`
 * read-replica session (so `getReadSession` / `getDbContext` reads are
 * caught too: they call `env.DB.withSession`). The tally is then written
 * to Analytics Engine by the caller via `recordD1Reads` (lib/analytics.ts),
 * which surfaces in platform-diagnostics `d1_attribution_24h` /
 * `d1_attribution_hourly`.
 *
 * Why: CF's per-query analytics (d1QueriesAdaptiveGroups) are sampled and
 * have no per-job breakdown, and agent_runs carries no rows_read, so the
 * daily spike hours could not be attributed to a job.
 *
 * Semantics are unchanged by design:
 *   - `all()` / `run()` / `batch()` / `exec()` forward to the real binding
 *     and return its exact result object; errors propagate untouched (no
 *     try/catch around a query).
 *   - `first()` gets no meta from D1, so the proxy runs `all()` (D1's
 *     `first()` sends the identical `/query` request — same statement, same
 *     rows read; it does NOT add LIMIT 1) and reproduces workerd's
 *     `first()` exactly: `null` for no rows; with a column name, throws
 *     `D1_COLUMN_NOTFOUND: Column not found (<col>)` when the first row has
 *     no such key, otherwise returns that value. (Mirrors workerd
 *     `cloudflare-internal:d1-api` D1PreparedStatement.first.)
 *   - `raw()` cannot be rebuilt from `all()` without losing duplicate
 *     column names, and D1 returns no meta for it, so it is forwarded as-is
 *     and counted as a query with 0 rows (unmetered). Nothing in src/ uses
 *     raw() today.
 *   - `exec()` returns `{ count, duration }` only: counted as `count`
 *     queries, rows unmetered (exec is migrations/maintenance only).
 *   - `batch()` unwraps metered statements back to the real
 *     D1PreparedStatement before forwarding, because the real batch reads
 *     the statements' internal fields.
 *
 * Overhead: one Proxy per prepared/bound statement and a few
 * additions per result — negligible next to a D1 round trip.
 *
 * Layers are EXCLUSIVE: metering an already-metered binding unwraps it to
 * the raw binding first, so the new layer's tally sees only the work done
 * through it and the enclosing layer's tally does not. An agent run
 * (`agent:`) inside a cron invocation (`cron:`), inside Flight Control
 * (another `agent:`), or inside a Workflow (`workflow:`) is therefore
 * counted once, in its own row — the rows are disjoint and summing every
 * `agent:` / `cron:` / `cron:…:bg` / `workflow:` row approximates the total
 * metered reads. A metered binding never wraps another metered binding, so
 * there is never more than one proxy between a caller and D1.
 */

import { newTally, recordD1Reads, writeD1Attribution, type D1Tally } from "./analytics";
import type { Env } from "../types";

// A metered statement answers this (module-private) key with the raw
// statement it wraps — batch() uses it to unwrap.
const INNER = Symbol("d1-meter.inner");
// A metered database answers this key with the raw binding it wraps —
// meterD1 uses it to keep layers exclusive (never proxy-on-proxy).
const RAW_DB = Symbol("d1-meter.raw-db");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Add a D1 result's meta rows into the tally (no query increment). */
function addRows(tally: D1Tally, result: unknown): void {
  if (!isRecord(result)) return;
  const meta = result.meta;
  if (!isRecord(meta)) return;
  tally.rowsRead += num(meta.rows_read);
  tally.rowsWritten += num(meta.rows_written);
}

function forward(target: object, prop: string | symbol): unknown {
  const value: unknown = Reflect.get(target, prop, target);
  // Bind to the real object so internal `this` access (and any private
  // fields) never sees the proxy.
  return typeof value === "function" ? value.bind(target) : value;
}

/** Wrap one prepared statement. bind() returns a metered statement too. */
export function meterStatement(stmt: D1PreparedStatement, tally: D1Tally): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop) {
      switch (prop) {
        case INNER:
          return target;
        case "bind":
          return (...values: unknown[]): D1PreparedStatement =>
            meterStatement(target.bind(...values), tally);
        case "all":
          return async (): Promise<unknown> => {
            tally.queries += 1;
            const r = await target.all();
            addRows(tally, r);
            return r;
          };
        case "run":
          return async (): Promise<unknown> => {
            tally.queries += 1;
            const r = await target.run();
            addRows(tally, r);
            return r;
          };
        case "first":
          return async (...args: unknown[]): Promise<unknown> => {
            tally.queries += 1;
            const colName = args[0];
            // A non-D1 binding without all() (some test fakes): forward
            // unchanged, count the query only.
            if (typeof (target as { all?: unknown }).all !== "function") {
              return colName === undefined
                ? target.first()
                : target.first(String(colName));
            }
            const r = await target.all();
            addRows(tally, r);
            const rows = isRecord(r) && Array.isArray(r.results) ? r.results : [];
            if (rows.length === 0) return null;
            const firstRow: unknown = rows[0];
            if (colName !== undefined) {
              const col = String(colName);
              const value = isRecord(firstRow) ? firstRow[col] : undefined;
              if (value === undefined) {
                throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${col})`, {
                  cause: new Error("Column not found"),
                });
              }
              return value;
            }
            return firstRow;
          };
        case "raw":
          return (...args: unknown[]): Promise<unknown> => {
            tally.queries += 1;
            return Reflect.apply(target.raw, target, args) as Promise<unknown>;
          };
        default:
          return forward(target, prop);
      }
    },
  });
}

/** Map metered statements back to the statement one layer down. */
function unwrapStatements(stmts: D1PreparedStatement[]): D1PreparedStatement[] {
  return stmts.map((s) => {
    const inner: unknown = isRecord(s) ? Reflect.get(s, INNER) : undefined;
    return inner === undefined ? s : (inner as D1PreparedStatement);
  });
}

async function meteredBatch(
  target: { batch: (s: D1PreparedStatement[]) => Promise<unknown> },
  stmts: D1PreparedStatement[],
  tally: D1Tally,
): Promise<unknown> {
  tally.queries += Array.isArray(stmts) ? stmts.length : 0;
  const results = await target.batch(Array.isArray(stmts) ? unwrapStatements(stmts) : stmts);
  if (Array.isArray(results)) for (const r of results) addRows(tally, r);
  return results;
}

/** Wrap a read-replica session (`db.withSession(...)`). */
export function meterSession(session: D1DatabaseSession, tally: D1Tally): D1DatabaseSession {
  return new Proxy(session, {
    get(target, prop) {
      switch (prop) {
        case "prepare":
          return (query: string): D1PreparedStatement => meterStatement(target.prepare(query), tally);
        case "batch":
          return (stmts: D1PreparedStatement[]): Promise<unknown> => meteredBatch(target, stmts, tally);
        default:
          return forward(target, prop);
      }
    },
  });
}

/** The raw binding under a metered database (or `db` itself). */
export function rawD1(db: D1Database): D1Database {
  const raw: unknown = Reflect.get(db, RAW_DB);
  return raw === undefined ? db : (raw as D1Database);
}

/**
 * Wrap a D1 binding. Returned object is a drop-in D1Database. An
 * already-metered binding is unwrapped first, so only `tally` counts the
 * work done through the result (exclusive layers, see header).
 */
export function meterD1(db: D1Database, tally: D1Tally): D1Database {
  return new Proxy(rawD1(db), {
    get(target, prop) {
      switch (prop) {
        case RAW_DB:
          return target;
        case "prepare":
          return (query: string): D1PreparedStatement => meterStatement(target.prepare(query), tally);
        case "batch":
          return (stmts: D1PreparedStatement[]): Promise<unknown> => meteredBatch(target, stmts, tally);
        case "exec":
          return async (query: string): Promise<unknown> => {
            const r = await target.exec(query);
            tally.queries += isRecord(r) ? Math.max(1, num(r.count)) : 1;
            return r;
          };
        case "withSession":
          return (...args: unknown[]): D1DatabaseSession => {
            const s = Reflect.apply(target.withSession, target, args) as D1DatabaseSession;
            return meterSession(s, tally);
          };
        default:
          return forward(target, prop);
      }
    },
  });
}

function isD1Like(v: unknown): v is D1Database {
  return isRecord(v) && typeof v.prepare === "function";
}

/** Env bindings that are D1 databases (all bill against the account). */
export const METERED_D1_BINDINGS = ["DB", "AUDIT_DB", "GEOIP_DB", "DNS_QUEUE_DB"] as const;

/**
 * Shallow env copy whose bound D1 databases are metered into `tally` —
 * exclusively: bindings already metered by an enclosing layer are re-wrapped
 * from their raw binding, so the enclosing tally stops seeing this work.
 */
export function meterEnv<E extends object>(env: E, tally: D1Tally): E {
  const out: E = { ...env };
  const rec = out as unknown as Record<string, unknown>;
  for (const key of METERED_D1_BINDINGS) {
    const binding = rec[key];
    if (isD1Like(binding)) rec[key] = meterD1(binding, tally);
  }
  return out;
}

function aeOf(env: object): AnalyticsEngineDataset | undefined {
  const ae = (env as { AE?: unknown }).AE;
  return isRecord(ae) && typeof ae.writeDataPoint === "function"
    ? (ae as unknown as AnalyticsEngineDataset)
    : undefined;
}

/**
 * Run `fn` with a metered env and record the tally under `endpoint` when it
 * settles (success or throw). The env's D1 bindings are metered EXCLUSIVELY
 * (see header): work `fn` hands to a nested withD1Meter / executeAgent is
 * counted in that layer's row, not in this one.
 *
 * With `ctx`, `fn` receives a waitUntil-tracking copy of it; reads issued
 * through this layer's env after `fn` returns (its waitUntil tail) are
 * recorded once that tail settles, as a second point under
 * `<endpoint>:bg`. The inline/`:bg` split is by time — a waitUntil promise's
 * reads before `fn` returns land in the inline point — but the two points
 * together are the layer's whole tally. Without `ctx`, reads after `fn`
 * returns are not recorded.
 *
 * Metering is skipped entirely — `fn` gets the original env and ctx — when
 * no Analytics Engine dataset is bound, since there is nowhere to record.
 * AE writes are synchronous fire-and-forget and non-fatal.
 */
export async function withD1Meter<R>(
  env: Env,
  endpoint: string,
  fn: (meteredEnv: Env, trackedCtx: ExecutionContext | undefined) => Promise<R>,
  ctx?: ExecutionContext,
): Promise<R> {
  if (!aeOf(env)) return fn(env, ctx);
  const tally = newTally();
  const tracked = ctx ? trackWaitUntil(ctx) : undefined;
  try {
    return await fn(meterEnv(env, tally), tracked?.ctx);
  } finally {
    const inline: D1Tally = { ...tally };
    recordD1Reads(env, endpoint, inline);
    if (ctx && tracked) {
      ctx.waitUntil(
        tracked.settled().then(() => {
          const bg: D1Tally = {
            rowsRead: tally.rowsRead - inline.rowsRead,
            rowsWritten: tally.rowsWritten - inline.rowsWritten,
            queries: tally.queries - inline.queries,
          };
          if (bg.queries > 0) recordD1Reads(env, `${endpoint}:bg`, bg);
        }),
      );
    }
  }
}

/** True for an ExecutionContext-shaped value (has a waitUntil function). */
export function isExecutionContextLike(v: unknown): v is ExecutionContext {
  return isRecord(v) && typeof v.waitUntil === "function";
}

/**
 * ExecutionContext wrapper that remembers every promise handed to
 * waitUntil so a caller can wait for the background tail of an invocation.
 */
export function trackWaitUntil(ctx: ExecutionContext): {
  ctx: ExecutionContext;
  settled: () => Promise<void>;
} {
  const pending: Promise<unknown>[] = [];
  const wrapped = new Proxy(ctx, {
    get(target, prop) {
      if (prop === "waitUntil") {
        return (p: Promise<unknown>): void => {
          pending.push(p);
          target.waitUntil(p);
        };
      }
      return forward(target, prop);
    },
  });
  const settled = async (): Promise<void> => {
    // Background work can itself call waitUntil — loop until stable.
    let seen = 0;
    while (seen < pending.length) {
      const batch = pending.slice(seen);
      seen = pending.length;
      await Promise.allSettled(batch);
    }
  };
  return { ctx: wrapped, settled };
}

/**
 * Meter one Workflow run. `swapEnv` installs the metered env on the
 * WorkflowEntrypoint (and restores the original afterwards); `body` gets a
 * step whose `do()` callbacks flush the tally delta to AE as each step
 * finishes. Per-step flushing matters because a Workflow instance can be
 * evicted between steps (sleep / hibernation) without `run()` ever
 * returning; replayed steps are served from the step cache and never re-run
 * their callback, so nothing is counted twice. Reads in `run()` outside a
 * step (re-executed on every replay, so genuinely repeated) are flushed at
 * the end. Each AE point is one step's (or the tail's) delta, so
 * `request_count` for a `workflow:` endpoint counts flushes, not runs.
 */
export async function runWithWorkflowMeter<E extends object, S extends object, R>(
  endpoint: string,
  env: E,
  step: S,
  swapEnv: (env: E) => void,
  body: (step: S) => Promise<R>,
): Promise<R> {
  const ae = aeOf(env);
  if (!ae) return body(step);
  const tally = newTally();
  const flushed = newTally();
  const flush = (): void => {
    const delta: D1Tally = {
      rowsRead: tally.rowsRead - flushed.rowsRead,
      rowsWritten: tally.rowsWritten - flushed.rowsWritten,
      queries: tally.queries - flushed.queries,
    };
    if (delta.queries === 0) return;
    flushed.rowsRead = tally.rowsRead;
    flushed.rowsWritten = tally.rowsWritten;
    flushed.queries = tally.queries;
    writeD1Attribution(ae, endpoint, delta);
  };
  const meteredStep = new Proxy(step, {
    get(target, prop) {
      if (prop === "do") {
        return (...args: unknown[]): unknown => {
          const cbIndex = args.length - 1;
          const cb = args[cbIndex];
          if (typeof cb === "function") {
            args[cbIndex] = async (): Promise<unknown> => {
              try {
                return await (cb as () => Promise<unknown>)();
              } finally {
                flush();
              }
            };
          }
          return Reflect.apply((target as { do: (...a: unknown[]) => unknown }).do, target, args);
        };
      }
      return forward(target, prop);
    },
  });
  swapEnv(meterEnv(env, tally));
  try {
    return await body(meteredStep);
  } finally {
    swapEnv(env);
    flush();
  }
}
