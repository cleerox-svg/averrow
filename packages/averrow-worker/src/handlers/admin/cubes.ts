// Averrow — Admin handlers: cubes
// Split from handlers/admin.ts (S3.4a). Behavior-preserving move.

import { z } from "zod";
import { json, corsHeaders } from "../../lib/cors";
import { audit } from "../../lib/audit";
import type { Env, UserRole, UserStatus } from "../../types";
import { runSyncAgent } from "../../lib/agentRunner";
import { adminClassifyAgent, type AdminClassifyOutput } from "../../agents/admin-classify";
import { callAnthropicJSON } from "../../lib/anthropic";
import { estimateCost } from "../../lib/budgetManager";
import { HOT_PATH_HAIKU } from "../../lib/ai-models";
import { enrichThreatsGeo, PRIVATE_IP_SQL_FILTER } from "../../lib/geoip";
import { fuzzyMatchBrand } from "../../lib/brandDetect";
import { cachedCount } from "../../lib/cached-count";
import { cachedValue } from "../../lib/cached-value";
import { getReadSession, getDbContext } from "../../lib/db";
import { computeFeedSeverity } from "../../lib/feed-severity";
import type { AuthContext } from "../../middleware/auth";
import { classifySaasTechnique } from "../../lib/saas-classifier";
import { BudgetManager, type BudgetStatus } from "../../lib/budgetManager";
import {
  buildGeoCubeForHour,
  buildProviderCubeForHour,
  buildBrandCubeForHour,
  buildStatusCubeForHour,
  buildArcsCubeForHour,
  countGeoCubeForHour,
  countProviderCubeForHour,
  countBrandCubeForHour,
  countStatusCubeForHour,
  countArcsCubeForHour,
} from "../../lib/cube-builder";


// ─── Cube Backfill (Phase 2 of OLAP rollout) ────────────────────────────────
//
// POST /api/admin/cube-backfill
//
// Query parameters:
//   - cube:        'geo' | 'provider' | 'both'   (required)
//   - days:        number 1..365                 (default 30)
//   - dry_run:     'true' | 'false'              (default 'false')
//   - resume_from: 'YYYY-MM-DD HH:00:00'         (optional; continues past this hour)
//
// Behavior:
//   1. Builds an oldest-first list of hour buckets covering the last `days` days,
//      stopping at the top of the current hour (partial hours excluded).
//   2. If resume_from is provided, skips all buckets <= resume_from so the caller
//      can continue an earlier run without double-processing.
//   3. For each hour: runs either the dry-run COUNT version or the real
//      INSERT OR REPLACE via cube-builder.ts, and streams one NDJSON line of
//      { hour, geo_rows, provider_rows, ms, error, dry_run }.
//   4. A single hour failing does NOT kill the stream — the error is reported
//      on that line and the loop continues.
//   5. If elapsed wall-clock crosses 25s, the loop stops and the summary line
//      carries `resume_from = <last successfully processed hour>` so the caller
//      can POST again with that value.
//   6. Final NDJSON line is the summary:
//        { done: bool, total_hours: N, total_rows: N, resume_from: str|null, ... }
//
// Auth: admin-gated via the same requireAdmin() middleware every other admin
// endpoint uses. Registration lives in routes/admin.ts.
//
// Phase 3 will wire cube refresh into Navigator; Phase 5 will swap Observatory
// reads over to the cube tables. Until then, nothing reads these tables.

/** Snap a Date (treated as UTC) to the top of the hour and format as SQLite 'YYYY-MM-DD HH:00:00'. */
function toHourBucket(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:00:00`;
}

export async function handleCubeBackfill(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);

  // ── Parse + validate query params ──
  const cube = url.searchParams.get("cube");
  if (
    cube !== "geo" &&
    cube !== "provider" &&
    cube !== "brand" &&
    cube !== "status" &&
    cube !== "arcs" &&
    cube !== "both" &&
    cube !== "all"
  ) {
    return json({
      success: false,
      error: "cube query param is required and must be 'geo' | 'provider' | 'brand' | 'status' | 'arcs' | 'both' | 'all'",
    }, 400, origin);
  }
  const buildGeo = cube === "geo" || cube === "both" || cube === "all";
  const buildProvider = cube === "provider" || cube === "both" || cube === "all";
  const buildBrand = cube === "brand" || cube === "all";
  const buildStatus = cube === "status" || cube === "all";
  const buildArcs = cube === "arcs" || cube === "all";

  const daysRaw = parseInt(url.searchParams.get("days") ?? "30", 10);
  const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 365);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const resumeFrom = url.searchParams.get("resume_from");

  // ── Build oldest-first hour bucket list ──
  // Snap "now" to the top of the current hour, then walk back `days * 24` hours.
  // The current (partial) hour is NOT included — refresh of the live hour is
  // Phase 3's job, not backfill's.
  const nowSnapped = new Date();
  nowSnapped.setUTCMinutes(0, 0, 0);
  nowSnapped.setUTCMilliseconds(0);

  const totalHours = days * 24;
  const hours: string[] = [];
  for (let i = totalHours; i >= 1; i--) {
    const d = new Date(nowSnapped.getTime() - i * 3_600_000);
    hours.push(toHourBucket(d));
  }

  // Skip all buckets <= resume_from.
  let startIdx = 0;
  if (resumeFrom) {
    const idx = hours.findIndex(h => h > resumeFrom);
    startIdx = idx === -1 ? hours.length : idx;
  }

  const DEADLINE_MS = 25_000;
  const streamStart = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const enqueue = (obj: unknown): void => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      let processed = 0;
      let totalRows = 0;
      let nextResumeFrom: string | null = null;
      let lastSuccessfulHour: string | null = resumeFrom;

      try {
        for (let i = startIdx; i < hours.length; i++) {
          // Deadline check BEFORE starting a new hour so we never interrupt mid-build.
          if (Date.now() - streamStart > DEADLINE_MS) {
            nextResumeFrom = lastSuccessfulHour;
            break;
          }

          const hour = hours[i]!;
          const hourStart = Date.now();
          let geoRows = 0;
          let providerRows = 0;
          let brandRows = 0;
          let statusRows = 0;
          let arcsRows = 0;
          const errParts: string[] = [];

          try {
            if (dryRun) {
              if (buildGeo) {
                const r = await countGeoCubeForHour(env, hour);
                geoRows = r.groupedRows;
                if (r.error) errParts.push(`geo: ${r.error}`);
              }
              if (buildProvider) {
                const r = await countProviderCubeForHour(env, hour);
                providerRows = r.groupedRows;
                if (r.error) errParts.push(`provider: ${r.error}`);
              }
              if (buildBrand) {
                const r = await countBrandCubeForHour(env, hour);
                brandRows = r.groupedRows;
                if (r.error) errParts.push(`brand: ${r.error}`);
              }
              if (buildStatus) {
                const r = await countStatusCubeForHour(env, hour);
                statusRows = r.groupedRows;
                if (r.error) errParts.push(`status: ${r.error}`);
              }
              if (buildArcs) {
                const r = await countArcsCubeForHour(env, hour);
                arcsRows = r.groupedRows;
                if (r.error) errParts.push(`arcs: ${r.error}`);
              }
            } else {
              if (buildGeo) {
                const r = await buildGeoCubeForHour(env, hour);
                geoRows = r.rowsWritten;
                if (r.error) errParts.push(`geo: ${r.error}`);
              }
              if (buildProvider) {
                const r = await buildProviderCubeForHour(env, hour);
                providerRows = r.rowsWritten;
                if (r.error) errParts.push(`provider: ${r.error}`);
              }
              if (buildBrand) {
                const r = await buildBrandCubeForHour(env, hour);
                brandRows = r.rowsWritten;
                if (r.error) errParts.push(`brand: ${r.error}`);
              }
              if (buildStatus) {
                const r = await buildStatusCubeForHour(env, hour);
                statusRows = r.rowsWritten;
                if (r.error) errParts.push(`status: ${r.error}`);
              }
              if (buildArcs) {
                const r = await buildArcsCubeForHour(env, hour);
                arcsRows = r.rowsWritten;
                if (r.error) errParts.push(`arcs: ${r.error}`);
              }
            }
          } catch (err) {
            errParts.push(err instanceof Error ? err.message : String(err));
          }

          const errMsg = errParts.length > 0 ? errParts.join("; ") : null;
          totalRows += geoRows + providerRows + brandRows + statusRows + arcsRows;
          processed++;
          // Advance cursor regardless of error so we don't infinite-loop on a single
          // poison hour. The error is surfaced per-line so operators can see it.
          lastSuccessfulHour = hour;

          enqueue({
            hour,
            geo_rows: geoRows,
            provider_rows: providerRows,
            brand_rows: brandRows,
            status_rows: statusRows,
            arcs_rows: arcsRows,
            ms: Date.now() - hourStart,
            error: errMsg,
            dry_run: dryRun,
          });
        }

        // Summary line.
        enqueue({
          done: nextResumeFrom === null,
          total_hours: processed,
          total_rows: totalRows,
          resume_from: nextResumeFrom,
          dry_run: dryRun,
          cube,
          window_days: days,
        });
      } catch (err) {
        // Catastrophic stream failure — emit one final error line and close cleanly.
        enqueue({
          done: false,
          error: err instanceof Error ? err.message : String(err),
          total_hours: processed,
          total_rows: totalRows,
          resume_from: lastSuccessfulHour,
          dry_run: dryRun,
          cube,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      ...corsHeaders(origin, env),
    },
  });
}
