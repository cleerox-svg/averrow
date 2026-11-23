/**
 * Data access — agent_outputs (Track B1 wave 2).
 *
 * agent_outputs belongs to the AGENTS telemetry family (lib/db-route.ts
 * FAMILY_TABLES, flag `db_route:telemetry`). Writes go FORWARD to the routed
 * store; history stays where it was written until the backfill copies it, so
 * every read is a telemetry ∪ core union (lib/telemetry-read.ts historyParts
 * + unionRows / unionFirst / unionGrouped / unionAggregateFirst). Rows are
 * append-only — no writer UPDATEs one — so a row is final on either DB and a
 * backfilled copy is identical to its core original.
 *
 * Rules for callers:
 *   - A write inside an agent run uses the run's route (AgentContext.telemetryRoute,
 *     set by executeAgent) through agentOutputsDbForRun, so a run's outputs
 *     land on the same DB as its agent_runs row.
 *   - A standalone write (a feed pull, an error handler) resolves the route
 *     once at the call site: agentOutputsStore(env).
 *   - Never JOIN agent_outputs to a core table in SQL, and never batch it with
 *     a core table (test/telemetry-batch-isolation.test.ts).
 *   - Never read agent_outputs from one DB only: a reader that does would miss
 *     every row written on the other side of the flip.
 */

import type { Env } from "../types";
import { telemetryDbFor, telemetryStore, type TelemetryRoute } from "../lib/db-route";

/** The DB a standalone agent_outputs write goes to (agents family, resolved now). */
export function agentOutputsStore(env: Env): Promise<D1Database> {
  return telemetryStore(env);
}

/**
 * The DB for an agent_outputs write that belongs to a run: the route the run
 * resolved at start when known (executeAgent / a workflow's init step), else
 * the route resolved now.
 */
export async function agentOutputsDbForRun(env: Env, route: TelemetryRoute | null | undefined): Promise<D1Database> {
  return route ? telemetryDbFor(env, route) : telemetryStore(env);
}
