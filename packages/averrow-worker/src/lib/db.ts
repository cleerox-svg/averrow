/**
 * db.ts — D1 database access helpers for read replication and sharding readiness.
 *
 * Phase 0.5f introduces D1 Sessions API to route read queries to replicas
 * instead of the primary writer, reducing contention during agent mesh runs.
 *
 * These helpers are also the sharding integration point for Phase 0.7+.
 * When per-tenant database sharding ships, only the implementations here
 * change — call sites in handlers do not need to be updated again.
 */

import type { Env } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Request-scoped database context carried through each API handler invocation.
 *
 * bookmark: The x-d1-bookmark value from the inbound request, or null.
 *   Passing the client's last-seen bookmark to withSession() guarantees the
 *   replica serving this request is at least as up-to-date as the client's
 *   previous read. This prevents read-your-writes anomalies across page loads.
 *
 * orgId: Reserved for Phase 0.7+ per-tenant sharding. Today every call routes
 *   to env.DB regardless of orgId. When sharding ships, getReadSession and
 *   getWriteDb will use orgId to select the correct shard binding.
 */
export interface DbContext {
  bookmark: string | null;
  orgId?: string;
}

// ─── Context extraction ───────────────────────────────────────────────────────

/**
 * Build a DbContext from an inbound Request.
 *
 * Reads the x-d1-bookmark request header (set by the client from the last
 * x-d1-bookmark response header it received). Returns null if the header is
 * absent, which causes the Sessions API to use 'first-unconstrained' — any
 * replica is acceptable for the first query of this session.
 *
 * Called at the top of every read handler before constructing queries.
 *
 * @param request - The inbound Worker request
 * @param orgId   - Optional org identifier for future sharding routing
 */
export function getDbContext(request: Request, orgId?: string): DbContext {
  return {
    bookmark: request.headers.get('x-d1-bookmark'),
    orgId,
  };
}

// ─── Read access ─────────────────────────────────────────────────────────────

/**
 * Return a D1DatabaseSession for read queries.
 *
 * TODAY: Returns env.DB.withSession(bookmark ?? 'first-unconstrained').
 * The Sessions API guarantees sequential consistency within the session:
 * reads route to any replica that is at least as current as the bookmark,
 * keeping reads off the primary writer during agent mesh runs.
 *
 * FUTURE (Phase 0.7+): Will route to env[shardForOrg(ctx.orgId)].withSession(...)
 * when per-tenant database sharding is introduced. This is the only place
 * that routing logic needs to live.
 *
 * Called by: observatory.ts, brands.ts, providers.ts, operations.ts,
 *            threat-actors.ts, and any other read-heavy handler migrated
 *            in Phase 0.5f Prompts 2–5.
 *
 * @param env - Worker environment bindings
 * @param ctx - DbContext from getDbContext()
 */
export function getReadSession(env: Env, ctx: DbContext): D1DatabaseSession {
  // Sharding integration point — Phase 0.7+:
  // const db = ctx.orgId ? env[shardForOrg(ctx.orgId)] : env.DB;
  return env.DB.withSession(ctx.bookmark ?? 'first-unconstrained');
}

// ─── Write access ─────────────────────────────────────────────────────────────

/**
 * Return the D1Database for write queries.
 *
 * TODAY: Always returns env.DB (the primary writer). Write queries must always
 * hit the primary — never a replica — to avoid lost-update anomalies.
 *
 * FUTURE (Phase 0.7+): Will route to env[shardForOrg(ctx.orgId)] when
 * per-tenant sharding is introduced.
 *
 * Called by: any handler that issues INSERT / UPDATE / DELETE queries.
 *
 * @param env - Worker environment bindings
 * @param ctx - DbContext from getDbContext()
 */
export function getWriteDb(env: Env, ctx: DbContext): D1Database {
  // Sharding integration point — Phase 0.7+:
  // return ctx.orgId ? env[shardForOrg(ctx.orgId)] : env.DB;
  void ctx; // ctx is unused today; retained for the future signature
  return env.DB;
}

// ─── Agent access ─────────────────────────────────────────────────────────────

/**
 * Return the D1Database for agent, cron, and orchestrator code.
 *
 * Agents (sentinel, cartographer, nexus, analyst, observer, parity_checker,
 * cube_healer, navigator, etc.) process global threat intelligence that is not
 * partitioned by customer. They always hit the primary writer directly.
 *
 * This helper exists to make the distinction explicit and auditable: if a
 * future agent accidentally tries to call getReadSession or routes to a
 * per-customer shard, that is a bug. All agent code uses getAgentDb.
 *
 * @param env - Worker environment bindings
 */
export function getAgentDb(env: Env): D1Database {
  return env.DB;
}

// ─── Bookmark propagation ─────────────────────────────────────────────────────

/**
 * Attach the session bookmark to an outbound response.
 *
 * Reads session.getBookmark() and writes it into the x-d1-bookmark response
 * header. The client (React frontend) stores this value and echoes it back
 * as the x-d1-bookmark request header on the next API call, enabling
 * read-your-writes consistency across sequential page loads.
 *
 * If getBookmark() returns null (no query was executed on the session),
 * the header is not set and the response is returned unchanged.
 *
 * @param response - The outbound Response to annotate
 * @param session  - The D1DatabaseSession used to serve this request
 */
export function attachBookmark(
  response: Response,
  session: D1DatabaseSession,
): Response {
  const bookmark = session.getBookmark();
  if (bookmark !== null) {
    response.headers.set('x-d1-bookmark', bookmark);
  }
  return response;
}
