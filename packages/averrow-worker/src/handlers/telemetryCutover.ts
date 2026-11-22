// Averrow — /api/internal/telemetry/* (Track B1c/B1d cut-over tools).
//
// Called by index.ts AFTER the AVERROW_INTERNAL_SECRET check. Every
// authorized non-dry-run call to a mutating tool — the route flip (refused
// flips included), copy-config and backfill — writes exactly one audit_log
// row (actor 'internal', user_id NULL; same pattern as
// /api/internal/cubes/backfill): telemetry_route.flip,
// telemetry_copy_config, telemetry_backfill. Errors are audited as
// outcome 'failure' before being returned / rethrown. Dry runs and reads
// (GET route, preflight) are not audited.

import type { Env } from "../types";
import { audit } from "../lib/audit";
import {
  BackfillConflictError,
  BackfillPrerequisiteError,
  TelemetryUnboundError,
  backfillTelemetryHistory,
  copyTelemetryConfig,
  parseBackfillParams,
  parseCopyConfigParams,
  parseFamily,
  parseSetRouteParams,
  setTelemetryRoute,
  telemetryPreflight,
  telemetryRoutes,
} from "../lib/telemetry-cutover";

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500);

const isKnownConflict = (err: unknown): boolean =>
  err instanceof TelemetryUnboundError || err instanceof BackfillConflictError || err instanceof BackfillPrerequisiteError;

function conflict(err: unknown): Response {
  return Response.json({ success: false, error: errMsg(err) }, { status: 409 });
}

export async function handleTelemetryCutover(request: Request, env: Env, url: URL): Promise<Response> {
  const sp = url.searchParams;

  if (url.pathname === "/api/internal/telemetry/route") {
    if (request.method === "GET") {
      return Response.json({ success: true, data: await telemetryRoutes(env) });
    }
    const rp = parseSetRouteParams(sp);
    if (!rp.ok) return Response.json({ success: false, error: rp.error }, { status: 400 });
    const flipped = await setTelemetryRoute(env, rp.params);
    if (!rp.params.dryRun) {
      await audit(env, {
        action: "telemetry_route.flip",
        userId: null,
        resourceType: "telemetry_route",
        resourceId: rp.params.family,
        outcome: flipped.written ? "success" : "failure",
        details: {
          actor: "internal",
          family: rp.params.family,
          from: flipped.from,
          to: rp.params.to,
          expect_from: rp.params.expectFrom ?? null,
          force: rp.params.force,
          dry_run: false,
          allowed: flipped.allowed,
          written: flipped.written,
          refused_reasons_count: flipped.refused_reasons.length,
        },
        request,
      });
    }
    // A refused flip is a 409 with the reasons; a dry run that would pass is 200.
    return Response.json(
      { success: flipped.allowed, data: flipped, ...(flipped.allowed ? {} : { error: flipped.refused_reasons.join("; ") }) },
      { status: flipped.allowed ? 200 : 409 },
    );
  }

  if (url.pathname === "/api/internal/telemetry/preflight") {
    const fam = parseFamily(sp);
    if (!fam.ok) return Response.json({ success: false, error: fam.error }, { status: 400 });
    try {
      return Response.json({ success: true, data: await telemetryPreflight(env, fam.family) });
    } catch (err) {
      if (isKnownConflict(err)) return conflict(err);
      throw err;
    }
  }

  if (url.pathname === "/api/internal/telemetry/copy-config") {
    // Same convention as backfill / cluster-retirement: a DRY RUN unless dry_run=0.
    const cp = parseCopyConfigParams(sp);
    if (!cp.ok) return Response.json({ success: false, error: cp.error }, { status: 400 });
    const base = { actor: "internal", family: cp.params.family, mode: cp.params.mode, direction: cp.params.direction, force: cp.params.force, dry_run: cp.params.dryRun };
    try {
      const result = await copyTelemetryConfig(env, cp.params);
      if (!cp.params.dryRun) {
        await audit(env, {
          action: "telemetry_copy_config",
          userId: null,
          resourceType: "telemetry_config",
          resourceId: cp.params.family,
          outcome: "success",
          details: {
            ...base,
            tables: result.tables.map((t) => ({
              table: t.table,
              inserted: t.inserted,
              updated: t.updated,
              missing_on_target: t.missing_on_target,
              differing: t.differing,
              skipped_target_newer: t.skipped_target_newer,
              skipped_unpause_needs_force: t.skipped_unpause_needs_force,
            })),
          },
          request,
        });
      }
      return Response.json({ success: true, data: result });
    } catch (err) {
      if (!cp.params.dryRun) {
        await audit(env, { action: "telemetry_copy_config", userId: null, resourceType: "telemetry_config", resourceId: cp.params.family, outcome: "failure", details: { ...base, error: errMsg(err) }, request });
      }
      if (isKnownConflict(err)) return conflict(err);
      throw err;
    }
  }

  // /api/internal/telemetry/backfill
  const parsed = parseBackfillParams(sp);
  if (!parsed.ok) return Response.json({ success: false, error: parsed.error }, { status: 400 });
  const base = { actor: "internal", table: parsed.params.table, days: parsed.params.days, dry_run: parsed.params.dryRun };
  try {
    const result = await backfillTelemetryHistory(env, parsed.params);
    if (!parsed.params.dryRun) {
      await audit(env, {
        action: "telemetry_backfill",
        userId: null,
        resourceType: "telemetry_history",
        resourceId: parsed.params.table,
        outcome: "success",
        details: {
          ...base,
          family: result.family,
          from: result.from,
          until: result.until,
          scanned: result.scanned,
          inserted: result.inserted,
          cursor_rowid: result.cursor_rowid,
          copied_total: result.copied_total,
          done: result.done,
        },
        request,
      });
    }
    return Response.json({ success: true, data: result });
  } catch (err) {
    if (!parsed.params.dryRun) {
      await audit(env, { action: "telemetry_backfill", userId: null, resourceType: "telemetry_history", resourceId: parsed.params.table, outcome: "failure", details: { ...base, error: errMsg(err) }, request });
    }
    if (isKnownConflict(err)) return conflict(err);
    throw err;
  }
}
