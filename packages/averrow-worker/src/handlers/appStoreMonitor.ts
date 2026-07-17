// Averrow — App Store Impersonation Monitoring HTTP Handlers
// Mirrors the lookalike-domains + social-monitor conventions:
//   GET   /api/appstore/overview                — cross-brand dashboard
//   GET   /api/appstore/monitor/:brandId        — list findings with filters
//   POST  /api/appstore/scan/:brandId           — trigger immediate scan
//   PATCH /api/appstore/:id                     — update classification / status
//   PATCH /api/brands/:brandId/official-apps    — edit allowlist

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import {
  runAppStoreMonitorForBrand,
  runAppStoreAIAssessmentBatch,
} from "../scanners/app-store-monitor";
import { getDbContext, getReadSession, attachBookmark } from "../lib/db";
import { getCacheVersion, bumpCacheVersion } from "../lib/cache-version";
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

const VALID_CLASSIFICATIONS = [
  "official",
  "legitimate",
  "suspicious",
  "impersonation",
  "unknown",
] as const;

const VALID_STATUSES = [
  "active",
  "resolved",
  "false_positive",
  "takedown_requested",
  "taken_down",
] as const;

// ─── Shared ownership guard ──────────────────────────────────────

async function assertBrandAccess(
  env: Env,
  brandId: string,
  userId: string,
): Promise<{ brand: { id: string; name: string; domain: string | null } } | { error: Response }> {
  const origin: string | null = null; // caller supplies origin via the response wrapper
  const brand = await env.DB.prepare(
    "SELECT id, name, canonical_domain AS domain FROM brands WHERE id = ?",
  ).bind(brandId).first<{ id: string; name: string; domain: string | null }>();

  if (!brand) {
    return { error: json({ success: false, error: "Brand not found" }, 404, origin) };
  }

  const ownership = await env.DB.prepare(
    "SELECT brand_id FROM monitored_brands WHERE brand_id = ?",
  ).bind(brandId).first();
  const userRow = await env.DB.prepare(
    "SELECT role FROM users WHERE id = ?",
  ).bind(userId).first<{ role: string }>();
  const isAdmin = userRow?.role === "admin" || userRow?.role === "super_admin";

  if (!ownership && !isAdmin) {
    return {
      error: json(
        { success: false, error: "Brand not in your monitored list" },
        403,
        origin,
      ),
    };
  }

  return { brand };
}

// ─── GET /api/appstore/monitor/:brandId ──────────────────────────

export async function handleListAppStoreListings(
  request: Request,
  env: Env,
  brandId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const access = await assertBrandAccess(env, brandId, userId);
    if ("error" in access) return access.error;

    const url = new URL(request.url);
    const store = url.searchParams.get("store");
    const classification = url.searchParams.get("classification");
    const severity = url.searchParams.get("severity");
    const status = url.searchParams.get("status") ?? "active";
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    // KV cache — page-load endpoint convention. Default view (page 1, limit
    // 50, no filters) shares a slot across users for the same brand.
    // Version-tagged so PATCH/POST writes can invalidate domain-wide.
    const cacheVersion = await getCacheVersion(env, "appstore");
    const isDefaultView = !store && !classification && !severity
      && status === "active" && offset === 0 && limit === 50;
    const cacheKey = isDefaultView
      ? `appstore_listings:v${cacheVersion}:${brandId}:default`
      : `appstore_listings:v${cacheVersion}:${brandId}:${status}:${store ?? ""}:${classification ?? ""}:${severity ?? ""}:${limit}:${offset}`;

    const dbCtx = getDbContext(request);
    const session = getReadSession(env, dbCtx);

    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "appstore_listings", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();

    let where = "WHERE brand_id = ?";
    const params: unknown[] = [brandId];

    if (store) { where += " AND store = ?"; params.push(store); }
    if (classification) { where += " AND classification = ?"; params.push(classification); }
    if (severity) { where += " AND severity = ?"; params.push(severity); }
    if (status) { where += " AND status = ?"; params.push(status); }

    const [rows, countRow, schedule] = await Promise.all([
      session.prepare(`
        SELECT * FROM app_store_listings
        ${where}
        ORDER BY
          CASE severity
            WHEN 'CRITICAL' THEN 1
            WHEN 'HIGH' THEN 2
            WHEN 'MEDIUM' THEN 3
            WHEN 'LOW' THEN 4
          END,
          classification = 'impersonation' DESC,
          classification = 'suspicious' DESC,
          created_at DESC
        LIMIT ? OFFSET ?
      `).bind(...params, limit, offset).all(),
      session.prepare(
        `SELECT COUNT(*) AS n FROM app_store_listings ${where}`,
      ).bind(...params).first<{ n: number }>(),
      session.prepare(
        "SELECT platform, last_checked, next_check, check_interval_hours, enabled FROM brand_monitor_schedule WHERE brand_id = ? AND monitor_type = 'appstore'",
      ).bind(brandId).all(),
    ]);

    addToTally(tally, rows.meta);
    addToTally(tally, schedule.meta);
    tally.queries += 1; // countRow .first()
    recordD1Reads(env, "appstore_listings", tally);

    const responseBody = {
      success: true,
      data: {
        brand: access.brand,
        results: rows.results,
        total: countRow?.n ?? 0,
        schedule: schedule.results,
      },
    };

    await env.CACHE.put(cacheKey, JSON.stringify(responseBody), { expirationTtl: 300 });
    return attachBookmark(json(responseBody, 200, origin), session);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/appstore/scan/:brandId ────────────────────────────

export async function handleTriggerAppStoreScan(
  request: Request,
  env: Env,
  brandId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const access = await assertBrandAccess(env, brandId, userId);
    if ("error" in access) return access.error;

    const brandRow = await env.DB.prepare(
      "SELECT id, name, canonical_domain AS domain, aliases, brand_keywords, official_apps FROM brands WHERE id = ?",
    ).bind(brandId).first<{
      id: string;
      name: string;
      domain: string | null;
      aliases: string | null;
      brand_keywords: string | null;
      official_apps: string | null;
    }>();

    if (!brandRow) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }

    const results = await runAppStoreMonitorForBrand(env, brandRow, {
      userId,
      triggeredBy: "manual",
    });

    // Advance the schedule so the cron doesn't immediately re-run this brand.
    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE brand_monitor_schedule
      SET last_checked = ?,
          next_check = datetime(?, '+' || check_interval_hours || ' hours')
      WHERE brand_id = ? AND monitor_type = 'appstore' AND platform = 'ios' AND enabled = 1
    `).bind(now, now, brandId).run();

    // Drain AI queue for this brand only so the caller sees AI verdicts in the response window.
    const ai = await runAppStoreAIAssessmentBatch(env, { brandId, limit: 10 });

    // Manual scan introduced new listings — invalidate the domain cache.
    await bumpCacheVersion(env, "appstore");

    await audit(env, {
      action: "app_store_scan_triggered",
      userId,
      resourceType: "brand",
      resourceId: brandId,
      details: {
        rows_returned: results.length,
        alerts_created: results.filter((r) => r.alert_id !== null).length,
        ai_processed: ai.processed,
        ai_upgraded: ai.upgraded,
      },
      request,
    });

    return json({
      success: true,
      data: {
        brand_id: brandId,
        brand_name: brandRow.name,
        results_count: results.length,
        alerts_created: results.filter((r) => r.alert_id !== null).length,
        ai_processed: ai.processed,
        ai_upgraded: ai.upgraded,
        results,
      },
    }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── PATCH /api/appstore/:id ─────────────────────────────────────

export async function handleUpdateAppStoreListing(
  request: Request,
  env: Env,
  listingId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const existing = await env.DB.prepare(
      "SELECT id, brand_id FROM app_store_listings WHERE id = ?",
    ).bind(listingId).first<{ id: string; brand_id: string }>();

    if (!existing) {
      return json({ success: false, error: "App store listing not found" }, 404, origin);
    }

    const access = await assertBrandAccess(env, existing.brand_id, userId);
    if ("error" in access) return access.error;

    const body = await request.json().catch(() => null) as {
      classification?: string;
      status?: string;
    } | null;

    if (!body) {
      return json({ success: false, error: "Request body is required" }, 400, origin);
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.classification !== undefined) {
      if (!VALID_CLASSIFICATIONS.includes(body.classification as typeof VALID_CLASSIFICATIONS[number])) {
        return json({
          success: false,
          error: `Invalid classification. Must be one of: ${VALID_CLASSIFICATIONS.join(", ")}`,
        }, 400, origin);
      }
      updates.push("classification = ?", "classified_by = 'manual'", "classification_confidence = 1.0");
      values.push(body.classification);
    }

    if (body.status !== undefined) {
      if (!VALID_STATUSES.includes(body.status as typeof VALID_STATUSES[number])) {
        return json({
          success: false,
          error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        }, 400, origin);
      }
      updates.push("status = ?");
      values.push(body.status);
      if (body.status === "resolved" || body.status === "false_positive") {
        updates.push("resolved_at = datetime('now')", "resolved_by = ?");
        values.push(userId);
      }
      if (body.status === "takedown_requested") {
        updates.push("takedown_requested_at = datetime('now')");
      }
      if (body.status === "taken_down") {
        updates.push("taken_down_at = datetime('now')");
      }
    }

    if (updates.length === 0) {
      return json({ success: false, error: "No valid fields to update" }, 400, origin);
    }

    updates.push("updated_at = datetime('now')");
    values.push(listingId);

    await env.DB.prepare(
      `UPDATE app_store_listings SET ${updates.join(", ")} WHERE id = ?`,
    ).bind(...values).run();

    // Invalidate domain-wide cache — overview + per-brand list both depend
    // on the listing's classification / status / severity. See cache-version.ts.
    await bumpCacheVersion(env, "appstore");

    const updated = await env.DB.prepare(
      "SELECT * FROM app_store_listings WHERE id = ?",
    ).bind(listingId).first();

    await audit(env, {
      action: "app_store_listing_update",
      userId,
      resourceType: "app_store_listing",
      resourceId: listingId,
      details: { classification: body.classification, status: body.status },
      request,
    });

    return json({ success: true, data: updated }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── PATCH /api/brands/:brandId/official-apps ────────────────────

interface OfficialAppInput {
  platform: string;
  app_id?: string;
  bundle_id?: string;
  developer_name?: string;
  developer_id?: string;
}

export async function handleUpdateOfficialApps(
  request: Request,
  env: Env,
  brandId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const access = await assertBrandAccess(env, brandId, userId);
    if ("error" in access) return access.error;

    const body = await request.json().catch(() => null) as {
      official_apps?: OfficialAppInput[];
    } | null;

    if (!body || !Array.isArray(body.official_apps)) {
      return json({
        success: false,
        error: "Body must be { official_apps: OfficialApp[] }",
      }, 400, origin);
    }

    // Normalize + validate each entry.
    const cleaned: OfficialAppInput[] = [];
    for (const raw of body.official_apps) {
      if (!raw || typeof raw !== "object") continue;
      const platform = typeof raw.platform === "string" ? raw.platform.trim().toLowerCase() : "";
      if (!platform) continue;
      if (!raw.app_id && !raw.bundle_id) continue; // need at least one identifier
      cleaned.push({
        platform,
        app_id: typeof raw.app_id === "string" ? raw.app_id.trim() : undefined,
        bundle_id: typeof raw.bundle_id === "string" ? raw.bundle_id.trim() : undefined,
        developer_name: typeof raw.developer_name === "string" ? raw.developer_name.trim() : undefined,
        developer_id: typeof raw.developer_id === "string" ? raw.developer_id.trim() : undefined,
      });
    }

    await env.DB.prepare(
      "UPDATE brands SET official_apps = ?, updated_at = datetime('now') WHERE id = ?",
    ).bind(JSON.stringify(cleaned), brandId).run();

    // Re-classify any existing rows whose bundle_id or app_id now match the allowlist —
    // flips previously-flagged entries back to 'official' without waiting for the next scan.
    for (const entry of cleaned) {
      if (entry.bundle_id) {
        await env.DB.prepare(`
          UPDATE app_store_listings
          SET classification = 'official',
              classified_by = 'system',
              classification_confidence = 1.0,
              classification_reason = 'Bundle ID allowlisted',
              severity = 'LOW',
              impersonation_score = 0,
              updated_at = datetime('now')
          WHERE brand_id = ? AND bundle_id = ? AND classified_by != 'manual'
        `).bind(brandId, entry.bundle_id).run();
      }
      if (entry.app_id) {
        await env.DB.prepare(`
          UPDATE app_store_listings
          SET classification = 'official',
              classified_by = 'system',
              classification_confidence = 1.0,
              classification_reason = 'App ID allowlisted',
              severity = 'LOW',
              impersonation_score = 0,
              updated_at = datetime('now')
          WHERE brand_id = ? AND store = ? AND app_id = ? AND classified_by != 'manual'
        `).bind(brandId, entry.platform, entry.app_id).run();
      }
    }

    // Allowlist edit may have re-classified many existing listings — invalidate
    // the cache so users immediately see the updated classifications.
    await bumpCacheVersion(env, "appstore");

    await audit(env, {
      action: "official_apps_update",
      userId,
      resourceType: "brand",
      resourceId: brandId,
      details: { count: cleaned.length },
      request,
    });

    return json({
      success: true,
      data: { brand_id: brandId, official_apps: cleaned },
    }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/appstore/overview ──────────────────────────────────
// Cross-brand dashboard: one row per monitored brand with per-severity
// counts of active findings, plus last/next scan timestamps. Mirrors
// the shape of handleSocialOverview so the UI can reuse patterns.
//
// Scope rules:
//   - super_admin / admin → see all monitored brands (platform-wide view)
//   - any other role with an org → see brands assigned to their org via org_brands
//   - any other role without an org → see nothing
//
// Replaces the legacy `monitored_brands.added_by = userId` filter, which only
// surfaced brands the logged-in user personally added. Bulk-seeded or
// org-assigned brands were invisible to non-admin users even when their org
// owned them. The org_brands join is the canonical multi-tenant scope used
// elsewhere in the codebase (see handlers/tenantData.ts).

export async function handleAppStoreOverview(
  request: Request,
  env: Env,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const isAdmin = ctx.role === "admin" || ctx.role === "super_admin";

    let scope: string;
    let scopeParams: unknown[];
    let scopeKey: string;

    if (isAdmin) {
      scope = `INNER JOIN monitored_brands mb ON mb.brand_id = b.id`;
      scopeParams = [];
      scopeKey = "admin";
    } else if (ctx.orgId) {
      scope = `INNER JOIN monitored_brands mb ON mb.brand_id = b.id
               INNER JOIN org_brands ob ON ob.brand_id = b.id AND ob.org_id = ?`;
      scopeParams = [ctx.orgId];
      scopeKey = `org:${ctx.orgId}`;
    } else {
      // Non-admin user without an org membership has no brands to show.
      return json({
        success: true,
        data: [],
        total: 0,
        totals: { total: 0, impersonation: 0, suspicious: 0, legitimate: 0, official: 0 },
      }, 200, origin);
    }

    // KV cache + read replica — page-load convention. Version-tagged for
    // PATCH/POST invalidation (see lib/cache-version.ts).
    const cacheVersion = await getCacheVersion(env, "appstore");
    const isDefaultView = limit === 50 && offset === 0;
    const cacheKey = isDefaultView
      ? `appstore_overview:v${cacheVersion}:${scopeKey}:default`
      : `appstore_overview:v${cacheVersion}:${scopeKey}:${limit}:${offset}`;

    const dbCtx = getDbContext(request);
    const session = getReadSession(env, dbCtx);

    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "appstore_overview", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();

    // Stage 1: brand list + count + cross-brand totals — all parallel.
    const [brands, total, totals] = await Promise.all([
      session.prepare(`
        SELECT b.id, b.name AS brand_name, b.canonical_domain AS domain,
               b.official_apps, b.first_seen AS created_at
        FROM brands b
        ${scope}
        ORDER BY b.name ASC
        LIMIT ? OFFSET ?
      `).bind(...scopeParams, limit, offset).all<{
        id: string;
        brand_name: string;
        domain: string | null;
        official_apps: string | null;
        created_at: string;
      }>(),
      session.prepare(
        `SELECT COUNT(*) AS n FROM brands b ${scope}`,
      ).bind(...scopeParams).first<{ n: number }>(),
      session.prepare(`
        SELECT
          SUM(CASE WHEN classification = 'impersonation' THEN 1 ELSE 0 END) AS impersonation,
          SUM(CASE WHEN classification = 'suspicious' THEN 1 ELSE 0 END) AS suspicious,
          SUM(CASE WHEN classification = 'legitimate' THEN 1 ELSE 0 END) AS legitimate,
          SUM(CASE WHEN classification = 'official' THEN 1 ELSE 0 END) AS official,
          COUNT(*) AS total
        FROM app_store_listings asl
        INNER JOIN brands b ON b.id = asl.brand_id
        ${scope}
        WHERE asl.status = 'active'
      `).bind(...scopeParams).first<{
        impersonation: number | null;
        suspicious: number | null;
        legitimate: number | null;
        official: number | null;
        total: number | null;
      }>(),
    ]);

    // Stage 2: per-brand stats from app_store_brand_summary + monitor
    // schedule. Two IN-list indexed reads instead of GROUP BY across the
    // raw listings table. Cube refreshed every 6h by cube_healer; the
    // 5-min KV cache absorbs staleness.
    const brandIds = brands.results.map(b => b.id);
    const placeholders = brandIds.map(() => "?").join(",");

    let summaryByBrand = new Map<string, {
      total_active: number; impersonation_active: number; suspicious_active: number;
      legitimate_active: number; official_active: number;
      critical_active: number; high_active: number;
    }>();
    let scheduleByBrand = new Map<string, { last_checked: string | null; next_check: string | null }>();

    if (brandIds.length > 0) {
      const [summaryRows, schedRows] = await Promise.all([
        session.prepare(`
          SELECT brand_id, total_active,
                 impersonation_active, suspicious_active, legitimate_active, official_active,
                 critical_active, high_active
          FROM app_store_brand_summary
          WHERE brand_id IN (${placeholders})
        `).bind(...brandIds).all<{
          brand_id: string;
          total_active: number; impersonation_active: number; suspicious_active: number;
          legitimate_active: number; official_active: number;
          critical_active: number; high_active: number;
        }>(),
        session.prepare(`
          SELECT brand_id, last_checked, next_check
          FROM brand_monitor_schedule
          WHERE brand_id IN (${placeholders})
            AND monitor_type = 'appstore'
            AND enabled = 1
        `).bind(...brandIds).all<{ brand_id: string; last_checked: string | null; next_check: string | null }>(),
      ]);

      addToTally(tally, summaryRows.meta);
      addToTally(tally, schedRows.meta);

      for (const r of summaryRows.results) summaryByBrand.set(r.brand_id, r);
      for (const r of schedRows.results) scheduleByBrand.set(r.brand_id, { last_checked: r.last_checked, next_check: r.next_check });
    }

    addToTally(tally, brands.meta);
    tally.queries += 2; // total + totals .first()
    recordD1Reads(env, "appstore_overview", tally);

    const brandsWithStats = brands.results.map((brand) => {
      const s = summaryByBrand.get(brand.id);
      const counts = {
        total: s?.total_active ?? 0,
        impersonation: s?.impersonation_active ?? 0,
        suspicious: s?.suspicious_active ?? 0,
        legitimate: s?.legitimate_active ?? 0,
        official: s?.official_active ?? 0,
        critical: s?.critical_active ?? 0,
        high: s?.high_active ?? 0,
      };
      const sched = scheduleByBrand.get(brand.id);
      return {
        ...brand,
        has_allowlist: Boolean(brand.official_apps && brand.official_apps !== "[]"),
        counts,
        last_checked: sched?.last_checked ?? null,
        next_check: sched?.next_check ?? null,
      };
    });

    const responseBody = {
      success: true,
      data: brandsWithStats,
      total: total?.n ?? 0,
      totals: {
        total: totals?.total ?? 0,
        impersonation: totals?.impersonation ?? 0,
        suspicious: totals?.suspicious ?? 0,
        legitimate: totals?.legitimate ?? 0,
        official: totals?.official ?? 0,
      },
    };

    await env.CACHE.put(cacheKey, JSON.stringify(responseBody), { expirationTtl: 300 });
    return attachBookmark(json(responseBody, 200, origin), session);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
