// Averrow — Admin handlers: brands
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


// ─── POST /api/admin/brand-scores/recompute-all ─────────────────
// Triggers the daily Brand Health + Brand Exposure batch on demand.
// Useful (a) right after deploy to populate the new scores without
// waiting for the 00:00 UTC cron, (b) after schema/weight changes,
// (c) for spot-fixing if the daily job failed silently.
//
// Scores monitored+customer tier brands only; tracked tier is
// scored on-demand via per-brand recompute.

export async function handleRecomputeBrandScores(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { computeBrandScoresBatch } = await import('../../lib/brand-scoring');
    const summary = await computeBrandScoresBatch(env);
    return json({
      success: true,
      data: {
        ...summary,
        message: `Scored ${summary.scored} of ${summary.scanned} brands in ${summary.duration_ms}ms (${summary.errors} errors)`,
      },
    }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "Recompute failed",
    }, 500, origin);
  }
}

// ─── GET /api/admin/brands — Admin brand management ─────────────

export async function handleAdminListBrands(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(200, parseInt(url.searchParams.get("limit") ?? "100", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const search = url.searchParams.get("q");
    const source = url.searchParams.get("source");
    const sort = url.searchParams.get("sort") ?? "threat_count";

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (search) { conditions.push("(b.name LIKE ? OR b.canonical_domain LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
    if (source) { conditions.push("b.source = ?"); params.push(source); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const sortColumn = sort === "name" ? "b.name ASC" :
      sort === "created" ? "b.first_seen DESC" :
      sort === "threats" ? "threat_count DESC" : "threat_count DESC";

    params.push(limit, offset);

    const rows = await env.DB.prepare(`
      SELECT b.id, b.name, b.canonical_domain, b.sector, b.source, b.first_seen,
             COUNT(t.id) AS threat_count,
             SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS active_threats,
             (SELECT COUNT(*) FROM monitored_brands mb WHERE mb.brand_id = b.id) AS is_monitored
      FROM brands b
      LEFT JOIN threats t ON t.target_brand_id = b.id
      ${where}
      GROUP BY b.id
      ORDER BY ${sortColumn}
      LIMIT ? OFFSET ?
    `).bind(...params).all();

    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM brands b ${where}`)
      .bind(...params.slice(0, -2)).first<{ n: number }>();

    // Source breakdown
    const sources = await env.DB.prepare(
      "SELECT COALESCE(source, 'manual') AS source, COUNT(*) AS count FROM brands GROUP BY source"
    ).all<{ source: string; count: number }>();

    return json({
      success: true,
      data: rows.results,
      total: total?.n ?? 0,
      sources: sources.results,
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/admin/brands/bulk-monitor — Bulk add to monitoring ─

export async function handleBulkMonitor(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => null) as { brand_ids?: string[] } | null;
    if (!body?.brand_ids?.length) return json({ success: false, error: "brand_ids required" }, 400, origin);

    const ids = body.brand_ids.slice(0, 100); // cap at 100
    let added = 0;

    const stmts = ids.map(id =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO monitored_brands (brand_id, tenant_id, added_by, status)
         VALUES (?, '__internal__', ?, 'active')`
      ).bind(id, userId)
    );

    // Batch in groups of 50
    for (let i = 0; i < stmts.length; i += 50) {
      const batch = stmts.slice(i, i + 50);
      const results = await env.DB.batch(batch);
      added += results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    }

    return json({ success: true, data: { requested: ids.length, added } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── DELETE /api/admin/brands/bulk — Bulk delete brands ──────────

export async function handleBulkDeleteBrands(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => null) as { brand_ids?: string[] } | null;
    if (!body?.brand_ids?.length) return json({ success: false, error: "brand_ids required" }, 400, origin);

    const ids = body.brand_ids.slice(0, 100);
    let deleted = 0;

    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const placeholders = batch.map(() => "?").join(",");
      const result = await env.DB.prepare(
        `DELETE FROM brands WHERE id IN (${placeholders})`
      ).bind(...batch).run();
      deleted += result.meta?.changes ?? 0;

      // Also clean up monitored_brands
      await env.DB.prepare(
        `DELETE FROM monitored_brands WHERE brand_id IN (${placeholders})`
      ).bind(...batch).run();
    }

    await audit(env, { action: "brands_bulk_delete", userId, resourceType: "brand", resourceId: ids.join(","), details: { count: deleted }, request });
    return json({ success: true, data: { deleted } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
