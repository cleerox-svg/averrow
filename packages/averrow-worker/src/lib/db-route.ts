// Averrow — per-cluster database routing (Track B1b)
//
// The wave-1 telemetry cluster (agent_runs, agent_configs, agent_events,
// agent_activity_log, agent_approvals, feed_configs, feed_status,
// feed_pull_history, budget_ledger, budget_config, agent_budget_rollups)
// moves from the core DB to TELEMETRY_DB one caller family at a time.
// `telemetryStore(env)` is the single place that decides which D1 database
// serves that cluster, so converting a family is "replace the core binding with
// await telemetryStore(env)" and the cut-over itself is one KV write.
//
// Route flag: KV `db_route:telemetry` ∈ {'core', 'telemetry'}.
//   - unset / any other value → core (default: nothing moves by accident)
//   - 'telemetry' but TELEMETRY_DB unbound (dev) → core
//   - read failure or a present-but-invalid value → the last value this
//     isolate read, else core. Falling back to core after a cut-over would
//     split writes across two DBs, so a KV blip keeps the known route instead.
//     LIMIT: a COLD isolate has no last value and serves core on a KV failure;
//     once the cluster is cut over, change the in-code default to 'telemetry'
//     (a follow-up of the cut-over) so cold isolates default to telemetry.
//   - callers must resolve the store ONCE per run/invocation and carry it
//     (e.g. on the agent_runs handle): a flip mid-run must not send the
//     finalize UPDATE to a different DB than the INSERT.
// The flag is cached in-isolate for 60 s, so a flip takes effect within a
// minute on every isolate (≤ 1 KV read per isolate per minute).
//
// Converted so far: the agent-runs family (agent_runs, agent_configs,
// agent_events, agent_activity_log, agent_approvals — Track B1c). Writers
// resolve the route ONCE per run / claim (resolveTelemetry below) and carry
// it; history readers go through lib/telemetry-read.ts (telemetry ∪ core).
// feed_* / budget_* are still on core. Direct `env.TELEMETRY_DB` use outside this file and
// lib/db-registry.ts is banned by test/db-access-ratchet.test.ts.

import type { Env } from "../types";
import { hasStore, storeBinding, StoreUnavailableError } from "./db-registry";

export type TelemetryRoute = "core" | "telemetry";

export const TELEMETRY_ROUTE_KV_KEY = "db_route:telemetry";
export const TELEMETRY_ROUTE_CACHE_MS = 60_000;

export interface TelemetryRouteState {
  /** The database the telemetry cluster is served from right now. */
  route: TelemetryRoute;
  /** The parsed KV flag; null when unset, invalid or never readable. */
  requested: TelemetryRoute | null;
  /** Whether TELEMETRY_DB is bound in this environment. */
  bound: boolean;
}

interface CachedFlag {
  requested: TelemetryRoute | null;
  expiresAt: number;
}

let cachedFlag: CachedFlag | null = null;

/** Test hook: forget the in-isolate flag cache (and the telemetry-used marker cache). */
export function resetTelemetryRouteCache(): void {
  cachedFlag = null;
  usedKnown = false;
  usedNegativeUntil = 0;
  usedRetryAfter = 0;
}

// ─── "Telemetry was used" marker (rollback safety) ────────────────
//
// The first time any isolate serves the route as 'telemetry' it writes this
// durable KV marker (no TTL). From then on, history reads and the
// agent_events consumer read BOTH DBs whenever TELEMETRY_DB is bound —
// whatever the current route — so flipping back to core never hides the rows
// written on telemetry meanwhile (FC would see every agent as stalled,
// /status would lose the interval, pending pivot events would never be
// consumed). Never clear it while TELEMETRY_DB is bound: there is no tool
// that copies telemetry's HISTORY rows back to core (copy-config
// direction=to_core covers only the two config tables), so clearing it
// would hide every run / event / activity row written while on telemetry.
export const TELEMETRY_USED_KV_KEY = "db_route:telemetry_used";
/** Per-isolate backoff after a failed marker write (KV down). */
export const TELEMETRY_USED_RETRY_MS = 30_000;
let usedKnown = false;
let usedNegativeUntil = 0;
let usedRetryAfter = 0;

async function markTelemetryUsed(env: Env, nowMs: number): Promise<void> {
  if (usedKnown || nowMs < usedRetryAfter) return;
  try {
    if ((await env.CACHE.get(TELEMETRY_USED_KV_KEY)) == null) {
      await env.CACHE.put(TELEMETRY_USED_KV_KEY, new Date(nowMs).toISOString());
    }
    usedKnown = true;
  } catch {
    // Back off, then retry on a later resolution; the route is unaffected.
    usedRetryAfter = nowMs + TELEMETRY_USED_RETRY_MS;
  }
}

/**
 * Whether the telemetry store has ever served the route (durable marker).
 * A positive answer is cached for the isolate's life, a negative one for
 * TELEMETRY_ROUTE_CACHE_MS. A KV failure answers true when bound — reading
 * both DBs is always safe, reading only core may hide rows.
 */
export async function telemetryEverUsed(env: Env, nowMs: number = Date.now()): Promise<boolean> {
  if (usedKnown) return true;
  if (!hasStore(env, "telemetry")) return false;
  if (nowMs < usedNegativeUntil) return false;
  try {
    const v = await env.CACHE.get(TELEMETRY_USED_KV_KEY);
    if (v != null) {
      usedKnown = true;
      return true;
    }
    usedNegativeUntil = nowMs + TELEMETRY_ROUTE_CACHE_MS;
    return false;
  } catch {
    return true;
  }
}

/** Tolerant parse: trims and lowercases, so 'Telemetry\n' still routes. */
export function parseTelemetryRoute(raw: unknown): TelemetryRoute | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v === "core" || v === "telemetry" ? v : null;
}

async function readRequested(env: Env, nowMs: number): Promise<TelemetryRoute | null> {
  if (cachedFlag && nowMs < cachedFlag.expiresAt) return cachedFlag.requested;
  try {
    const raw = await env.CACHE.get(TELEMETRY_ROUTE_KV_KEY);
    const parsed = parseTelemetryRoute(raw);
    // A present-but-invalid value (typo) keeps the last known route rather
    // than silently reverting to core — same rule as a read failure.
    const requested = raw != null && parsed == null ? (cachedFlag?.requested ?? null) : parsed;
    cachedFlag = { requested, expiresAt: nowMs + TELEMETRY_ROUTE_CACHE_MS };
    return requested;
  } catch {
    // Keep the last known route (stale) rather than silently flipping back
    // to core; retry KV on the next minute.
    const requested = cachedFlag?.requested ?? null;
    cachedFlag = { requested, expiresAt: nowMs + TELEMETRY_ROUTE_CACHE_MS };
    return requested;
  }
}

/** Which database serves the telemetry cluster, and why. Never throws. */
export async function telemetryRouteState(env: Env, nowMs: number = Date.now()): Promise<TelemetryRouteState> {
  const bound = hasStore(env, "telemetry");
  const requested = await readRequested(env, nowMs);
  const route: TelemetryRoute = requested === "telemetry" && bound ? "telemetry" : "core";
  if (route === "telemetry") await markTelemetryUsed(env, nowMs);
  return { route, requested, bound };
}

/**
 * The D1 binding for the telemetry cluster: TELEMETRY_DB when the route flag
 * says 'telemetry' and it is bound, else the core binding. Throws
 * StoreUnavailableError only if core itself is unbound.
 */
export async function telemetryStore(env: Env, nowMs: number = Date.now()): Promise<D1Database> {
  const { route } = await telemetryRouteState(env, nowMs);
  const db = storeBinding(env, route === "telemetry" ? "telemetry" : "core");
  if (!db) throw new StoreUnavailableError(route);
  return db;
}

// ─── Resolve once, carry for the run (Track B1c) ──────────────────

/**
 * A telemetry route resolved ONCE at the start of a run / claim and carried
 * to every later statement of that unit of work. Never call
 * telemetryStore() per statement inside a run: a run that straddles a flip
 * (cartographer ~8 min) must heartbeat and finalize on the DB its row was
 * inserted into, or the row is orphaned on the other DB.
 */
export interface TelemetryHandle {
  route: TelemetryRoute;
  db: D1Database;
}

/** The binding that serves a FIXED route (for a carried handle's route). */
export function telemetryDbFor(env: Env, route: TelemetryRoute): D1Database {
  const db = storeBinding(env, route === "telemetry" ? "telemetry" : "core");
  if (!db) throw new StoreUnavailableError(route);
  return db;
}

/** Resolve the route once; the returned handle is what a run carries. */
export async function resolveTelemetry(env: Env, nowMs: number = Date.now()): Promise<TelemetryHandle> {
  const { route } = await telemetryRouteState(env, nowMs);
  return { route, db: telemetryDbFor(env, route) };
}

/**
 * Every DB that can hold agent-runs family rows right now, core first:
 * core always, TELEMETRY_DB whenever it is bound (whatever the route — a
 * flip back to core must not strand rows written there). For sweepers that
 * act on each DB's own rows (the orphan reaper, the agent_events drain),
 * never for reads (use lib/telemetry-read.ts historyParts).
 */
export function telemetryFamilyDbs(env: Env): TelemetryHandle[] {
  const out: TelemetryHandle[] = [{ route: "core", db: telemetryDbFor(env, "core") }];
  if (hasStore(env, "telemetry")) out.push({ route: "telemetry", db: telemetryDbFor(env, "telemetry") });
  return out;
}
