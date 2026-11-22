// Averrow — per-cluster database routing (Track B1b/B1c/B1d)
//
// The wave-1 telemetry cluster (agent_runs, agent_configs, agent_events,
// agent_activity_log, agent_approvals, feed_configs, feed_status,
// feed_pull_history, budget_ledger, budget_config, agent_budget_rollups)
// moves from the core DB to TELEMETRY_DB one caller FAMILY at a time. This
// file is the single place that decides which D1 database serves a family.
//
// Three families, each with its OWN route flag (Track B1d), so a deploy never
// moves a family by itself: each one is cut over with its own KV write, once
// its config is copied and its preflight passes
// (POST /api/internal/telemetry/route, lib/telemetry-cutover.ts):
//
//   agents  `db_route:telemetry`          agent_runs, agent_configs, agent_events,
//                                          agent_activity_log, agent_approvals (B1c)
//   feeds   `db_route:telemetry:feeds`    feed_configs, feed_status, feed_pull_history
//   budget  `db_route:telemetry:budget`   budget_ledger, budget_config, agent_budget_rollups
//
// Route flag (per family) ∈ {'core', 'telemetry'}:
//   - unset / any other value → core (default: nothing moves by accident)
//   - 'telemetry' but TELEMETRY_DB unbound (dev) → core
//   - read failure or a present-but-invalid value → the last value this
//     isolate read, else core. Falling back to core after a cut-over would
//     split writes across two DBs, so a KV blip keeps the known route instead.
//     LIMIT: a COLD isolate has no last value and serves core on a KV failure;
//     once a family is cut over, change its in-code default to 'telemetry'
//     (a follow-up of the cut-over) so cold isolates default to telemetry.
//   - callers must resolve a family ONCE per unit of work (run, feed pull, AI
//     call) and carry it: a flip mid-unit must not send the finalize to a
//     different DB than the INSERT.
// Each flag is cached in-isolate for 60 s, so a flip takes effect within a
// minute on every isolate (≤ 1 KV read per isolate per family per minute).
//
// The agents family keeps its original keys and API (telemetryStore,
// telemetryRouteState, resolveTelemetry, telemetryEverUsed); every family goes
// through familyStore / familyRouteState / resolveFamily / familyEverUsed.
// History readers go through lib/telemetry-read.ts (telemetry ∪ core). Direct
// `env.TELEMETRY_DB` use outside this file and lib/db-registry.ts is banned by
// test/db-access-ratchet.test.ts.

import type { Env } from "../types";
import { hasStore, storeBinding, StoreUnavailableError } from "./db-registry";

export type TelemetryRoute = "core" | "telemetry";

/** A group of wave-1 tables that is cut over (and rolled back) together. */
export type TelemetryFamily = "agents" | "feeds" | "budget";
export const TELEMETRY_FAMILIES: readonly TelemetryFamily[] = ["agents", "feeds", "budget"];

/** The tables each family moves. A D1 batch never mixes two families (test/telemetry-batch-isolation.test.ts). */
export const FAMILY_TABLES: Record<TelemetryFamily, readonly string[]> = {
  agents: ["agent_runs", "agent_configs", "agent_events", "agent_activity_log", "agent_approvals"],
  feeds: ["feed_configs", "feed_status", "feed_pull_history"],
  budget: ["budget_ledger", "budget_config", "agent_budget_rollups"],
};

/** The agents family's route flag (B1c; its key is unchanged). */
export const TELEMETRY_ROUTE_KV_KEY = "db_route:telemetry";
export const TELEMETRY_ROUTE_CACHE_MS = 60_000;

/** Route flag per family. Unset = core for that family, whatever the others say. */
export const FAMILY_ROUTE_KV_KEYS: Record<TelemetryFamily, string> = {
  agents: TELEMETRY_ROUTE_KV_KEY,
  feeds: "db_route:telemetry:feeds",
  budget: "db_route:telemetry:budget",
};

export interface TelemetryRouteState {
  /** The database the family is served from right now. */
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

interface FamilyCache {
  flag: CachedFlag | null;
  /** The KV read in progress, shared by concurrent resolutions. */
  inflight: Promise<TelemetryRoute | null> | null;
  usedKnown: boolean;
  usedNegativeUntil: number;
  usedRetryAfter: number;
}

const freshCache = (): FamilyCache => ({ flag: null, inflight: null, usedKnown: false, usedNegativeUntil: 0, usedRetryAfter: 0 });
const caches: Record<TelemetryFamily, FamilyCache> = { agents: freshCache(), feeds: freshCache(), budget: freshCache() };

/** Test hook: forget every family's in-isolate flag cache (and telemetry-used marker cache). */
export function resetTelemetryRouteCache(): void {
  for (const f of TELEMETRY_FAMILIES) caches[f] = freshCache();
}

// ─── "Telemetry was used" marker (rollback safety) ────────────────
//
// The first time any isolate serves a family's route as 'telemetry' it writes
// that family's durable KV marker (no TTL). From then on, history reads of the
// family (and, for agents, the agent_events consumer) read BOTH DBs whenever
// TELEMETRY_DB is bound — whatever the current route — so flipping back to
// core never hides the rows written on telemetry meanwhile (FC would see every
// agent as stalled, /status would lose the interval, pending pivot events
// would never be consumed, feed history and AI spend would drop). Never clear
// a marker while TELEMETRY_DB is bound: there is no tool that copies
// telemetry's HISTORY rows back to core (copy-config direction=to_core covers
// only the config tables), so clearing it would hide every row written while
// on telemetry.
export const TELEMETRY_USED_KV_KEY = "db_route:telemetry_used";
export const FAMILY_USED_KV_KEYS: Record<TelemetryFamily, string> = {
  agents: TELEMETRY_USED_KV_KEY,
  feeds: "db_route:telemetry_used:feeds",
  budget: "db_route:telemetry_used:budget",
};
/** Per-isolate backoff after a failed marker write (KV down). */
export const TELEMETRY_USED_RETRY_MS = 30_000;

async function markFamilyUsed(env: Env, family: TelemetryFamily, nowMs: number): Promise<void> {
  const c = caches[family];
  if (c.usedKnown || nowMs < c.usedRetryAfter) return;
  try {
    const key = FAMILY_USED_KV_KEYS[family];
    if ((await env.CACHE.get(key)) == null) {
      await env.CACHE.put(key, new Date(nowMs).toISOString());
    }
    c.usedKnown = true;
  } catch {
    // Back off, then retry on a later resolution; the route is unaffected.
    c.usedRetryAfter = nowMs + TELEMETRY_USED_RETRY_MS;
  }
}

/**
 * Whether the telemetry store has ever served this family's route (durable
 * marker). A positive answer is cached for the isolate's life, a negative one
 * for TELEMETRY_ROUTE_CACHE_MS. A KV failure answers true when bound — reading
 * both DBs is always safe, reading only core may hide rows.
 */
export async function familyEverUsed(env: Env, family: TelemetryFamily, nowMs: number = Date.now()): Promise<boolean> {
  const c = caches[family];
  if (c.usedKnown) return true;
  if (!hasStore(env, "telemetry")) return false;
  if (nowMs < c.usedNegativeUntil) return false;
  try {
    const v = await env.CACHE.get(FAMILY_USED_KV_KEYS[family]);
    if (v != null) {
      c.usedKnown = true;
      return true;
    }
    c.usedNegativeUntil = nowMs + TELEMETRY_ROUTE_CACHE_MS;
    return false;
  } catch {
    return true;
  }
}

/** The agents family's marker (B1c API). */
export function telemetryEverUsed(env: Env, nowMs: number = Date.now()): Promise<boolean> {
  return familyEverUsed(env, "agents", nowMs);
}

/** Tolerant parse: trims and lowercases, so 'Telemetry\n' still routes. */
export function parseTelemetryRoute(raw: unknown): TelemetryRoute | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v === "core" || v === "telemetry" ? v : null;
}

async function readRequested(env: Env, family: TelemetryFamily, nowMs: number): Promise<TelemetryRoute | null> {
  const c = caches[family];
  if (c.flag && nowMs < c.flag.expiresAt) return c.flag.requested;
  // Concurrent resolutions in one isolate (e.g. a handler's Promise.all)
  // share one KV read instead of each missing the cold cache.
  if (c.inflight) return c.inflight;
  const p = fetchRequested(env, family, nowMs);
  c.inflight = p;
  try {
    return await p;
  } finally {
    if (c.inflight === p) c.inflight = null;
  }
}

async function fetchRequested(env: Env, family: TelemetryFamily, nowMs: number): Promise<TelemetryRoute | null> {
  const c = caches[family];
  try {
    const raw = await env.CACHE.get(FAMILY_ROUTE_KV_KEYS[family]);
    const parsed = parseTelemetryRoute(raw);
    // A present-but-invalid value (typo) keeps the last known route rather
    // than silently reverting to core — same rule as a read failure.
    const requested = raw != null && parsed == null ? (c.flag?.requested ?? null) : parsed;
    c.flag = { requested, expiresAt: nowMs + TELEMETRY_ROUTE_CACHE_MS };
    return requested;
  } catch {
    // Keep the last known route (stale) rather than silently flipping back
    // to core; retry KV on the next minute.
    const requested = c.flag?.requested ?? null;
    c.flag = { requested, expiresAt: nowMs + TELEMETRY_ROUTE_CACHE_MS };
    return requested;
  }
}

/** Which database serves a family, and why. Never throws. */
export async function familyRouteState(env: Env, family: TelemetryFamily, nowMs: number = Date.now()): Promise<TelemetryRouteState> {
  const bound = hasStore(env, "telemetry");
  const requested = await readRequested(env, family, nowMs);
  const route: TelemetryRoute = requested === "telemetry" && bound ? "telemetry" : "core";
  if (route === "telemetry") await markFamilyUsed(env, family, nowMs);
  return { route, requested, bound };
}

/** The agents family's route state (B1c API). */
export function telemetryRouteState(env: Env, nowMs: number = Date.now()): Promise<TelemetryRouteState> {
  return familyRouteState(env, "agents", nowMs);
}

/** The binding that serves a FIXED route (for a carried handle's route). */
export function telemetryDbFor(env: Env, route: TelemetryRoute): D1Database {
  const db = storeBinding(env, route === "telemetry" ? "telemetry" : "core");
  if (!db) throw new StoreUnavailableError(route);
  return db;
}

/**
 * The D1 binding for a family: TELEMETRY_DB when its route flag says
 * 'telemetry' and it is bound, else the core binding. Throws
 * StoreUnavailableError only if core itself is unbound. For the config /
 * state tables, which are read and written on the routed store only. Inside a
 * unit of work, resolve once with resolveFamily instead.
 */
export async function familyStore(env: Env, family: TelemetryFamily, nowMs: number = Date.now()): Promise<D1Database> {
  const { route } = await familyRouteState(env, family, nowMs);
  return telemetryDbFor(env, route);
}

/** The agents family's store (B1c API). */
export function telemetryStore(env: Env, nowMs: number = Date.now()): Promise<D1Database> {
  return familyStore(env, "agents", nowMs);
}

/**
 * A family's routed store for a READ that a core read session may serve:
 * `coreRead` (a read session / replica) when the route is core — exactly the
 * pre-cut-over read — else TELEMETRY_DB.
 */
export async function familyReadDb(
  env: Env,
  family: TelemetryFamily,
  coreRead: Pick<D1Database, "prepare">,
  nowMs: number = Date.now(),
): Promise<Pick<D1Database, "prepare">> {
  const { route } = await familyRouteState(env, family, nowMs);
  return route === "telemetry" ? telemetryDbFor(env, "telemetry") : coreRead;
}

// ─── Resolve once, carry for the unit of work (Track B1c/B1d) ─────

/**
 * A route resolved ONCE at the start of a run / claim / feed pull / AI call
 * and carried to every later statement of that unit of work. Never call
 * familyStore() per statement inside a unit: one that straddles a flip
 * (cartographer ~8 min, a taxii pull ~10 min) must finalize on the DB its row
 * was inserted into, or the row is orphaned on the other DB.
 */
export interface TelemetryHandle {
  route: TelemetryRoute;
  db: D1Database;
}

/** Resolve a family's route once; the returned handle is what a unit carries. */
export async function resolveFamily(env: Env, family: TelemetryFamily, nowMs: number = Date.now()): Promise<TelemetryHandle> {
  const { route } = await familyRouteState(env, family, nowMs);
  return { route, db: telemetryDbFor(env, route) };
}

/** Resolve the agents family once (B1c API). */
export function resolveTelemetry(env: Env, nowMs: number = Date.now()): Promise<TelemetryHandle> {
  return resolveFamily(env, "agents", nowMs);
}

/**
 * Every DB that can hold wave-1 rows right now, core first: core always,
 * TELEMETRY_DB whenever it is bound (whatever any route — a flip back to core
 * must not strand rows written there). For sweepers that act on each DB's own
 * rows (the orphan reapers, the agent_events drain), never for reads (use
 * lib/telemetry-read.ts historyParts). Family-agnostic.
 */
export function telemetryFamilyDbs(env: Env): TelemetryHandle[] {
  const out: TelemetryHandle[] = [{ route: "core", db: telemetryDbFor(env, "core") }];
  if (hasStore(env, "telemetry")) out.push({ route: "telemetry", db: telemetryDbFor(env, "telemetry") });
  return out;
}

/** Which family a wave-1 table belongs to (null = a core table). */
export function familyOfTable(table: string): TelemetryFamily | null {
  for (const f of TELEMETRY_FAMILIES) if (FAMILY_TABLES[f].includes(table)) return f;
  return null;
}
