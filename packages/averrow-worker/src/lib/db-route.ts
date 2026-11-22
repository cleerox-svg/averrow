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
//   - read failure → the last value this isolate read, else core. Falling
//     back to core after a cut-over would split writes across two DBs, so a
//     KV blip keeps the known route instead.
// The flag is cached in-isolate for 60 s, so a flip takes effect within a
// minute on every isolate (≤ 1 KV read per isolate per minute).
//
// Not used by any production caller yet: the per-family conversion PRs
// come next. Direct `env.TELEMETRY_DB` use outside this file and
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

/** Test hook: forget the in-isolate flag cache. */
export function resetTelemetryRouteCache(): void {
  cachedFlag = null;
}

export function parseTelemetryRoute(raw: unknown): TelemetryRoute | null {
  return raw === "core" || raw === "telemetry" ? raw : null;
}

async function readRequested(env: Env, nowMs: number): Promise<TelemetryRoute | null> {
  if (cachedFlag && nowMs < cachedFlag.expiresAt) return cachedFlag.requested;
  try {
    const raw = await env.CACHE.get(TELEMETRY_ROUTE_KV_KEY);
    const requested = parseTelemetryRoute(raw);
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
  return { route: requested === "telemetry" && bound ? "telemetry" : "core", requested, bound };
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
