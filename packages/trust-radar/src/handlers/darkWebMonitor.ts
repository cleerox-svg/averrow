// Averrow — Dark-Web Mention Monitoring HTTP Handlers
// Mirrors the app-store / social-monitor conventions:
//   GET   /api/darkweb/overview              — cross-brand dashboard
//   GET   /api/darkweb/mentions/:brandId     — list mentions with filters
//   POST  /api/darkweb/scan/:brandId         — trigger immediate scan
//   PATCH /api/darkweb/:id                   — update classification / status

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import {
  runDarkWebMonitorForBrand,
  runDarkWebAIAssessmentBatch,
} from "../scanners/dark-web-monitor";
import { getDbContext, getReadSession, attachBookmark } from "../lib/db";
import { getCacheVersion, bumpCacheVersion } from "../lib/cache-version";
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

const VALID_CLASSIFICATIONS = [
  "confirmed",
  "suspicious",
  "false_positive",
  "resolved",
  "unknown",
] as const;

const VALID_STATUSES = [
  "active",
  "resolved",
  "false_positive",
  "investigating",
] as const;

// ─── Shared ownership guard ──────────────────────────────────────

async function assertBrandAccess(
  env: Env,
  brandId: string,
  userId: string,
): Promise<{ brand: { id: string; name: string; domain: string | null } } | { error: Response }> {
  const origin: string | null = null;
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
      error: json({ success: false, error: "Brand not in your monitored list" }, 403, origin),
    };
  }

  return { brand };
}

// ─── GET /api/darkweb/mentions ───────────────────────────────────
// Global mention list across all monitored brands. Powers the
// platform-standard table view on the ops Dark Web page. Mirrors
// the per-brand handler's shape but without the brand-scoping
// guard — auth alone is enough since dark web is staff-side.
//
// Aggregates are computed on the UNFILTERED active slice and
// returned alongside the page rows so the UI can render source-
// mix and severity-mix sidecars without a second round trip and
// without the cache key thrashing on every filter combination.

export async function handleListAllDarkWebMentions(
  request: Request,
  env: Env,
  _ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const source = url.searchParams.get("source");
    const classification = url.searchParams.get("classification");
    const severity = url.searchParams.get("severity");
    const matchType = url.searchParams.get("match_type");
    const status = url.searchParams.get("status") ?? "active";
    const brandId = url.searchParams.get("brand_id");
    const q = url.searchParams.get("q")?.trim();
    const sort = (url.searchParams.get("sort") ?? "last_seen").toLowerCase();
    const dirRaw = (url.searchParams.get("dir") ?? "desc").toLowerCase();
    const dir: "asc" | "desc" = dirRaw === "asc" ? "asc" : "desc";
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));

    const sortColumn = (() => {
      switch (sort) {
        case "first_seen": return "dwm.first_seen";
        case "posted_at":  return "COALESCE(dwm.posted_at, dwm.first_seen)";
        case "severity":   return "CASE dwm.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END";
        case "source":     return "dwm.source";
        case "brand":      return "b.name";
        default:           return "COALESCE(dwm.last_seen, dwm.first_seen)";
      }
    })();
    // For severity, DESC reads natural ("worst first") because CASE
    // assigns ascending integers; flip the SQL direction so DESC in
    // the UI means severity-descending.
    const sqlDir = sort === "severity"
      ? (dir === "asc" ? "DESC" : "ASC")
      : (dir === "asc" ? "ASC" : "DESC");

    // Cache key encodes ALL filters + sort + page. Default view (no
    // filters, status=active, page 0, default sort) gets a reduced
    // key so the most-loaded combo hits the same slot regardless of
    // user. 60s TTL — operators want freshness.
    const cacheVersion = await getCacheVersion(env, "darkweb");
    const isDefaultView = !source && !classification && !severity && !matchType
      && !brandId && !q && status === "active" && offset === 0 && limit === 50
      && sort === "last_seen" && dir === "desc";
    const cacheKey = isDefaultView
      ? `darkweb_all_mentions:v${cacheVersion}:default`
      : `darkweb_all_mentions:v${cacheVersion}:${status}:${source ?? ""}:${classification ?? ""}:${severity ?? ""}:${matchType ?? ""}:${brandId ?? ""}:${q ?? ""}:${sort}:${dir}:${limit}:${offset}`;

    const dbCtx = getDbContext(request);
    const session = getReadSession(env, dbCtx);

    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "darkweb_all_mentions", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const where: string[] = [];
    const params: unknown[] = [];
    if (status)         { where.push("dwm.status = ?");          params.push(status); }
    if (source)         { where.push("dwm.source = ?");          params.push(source); }
    if (classification) { where.push("dwm.classification = ?");  params.push(classification); }
    if (severity)       { where.push("dwm.severity = ?");        params.push(severity); }
    if (matchType)      { where.push("dwm.match_type = ?");      params.push(matchType); }
    if (brandId)        { where.push("dwm.brand_id = ?");        params.push(brandId); }
    if (q)              { where.push("(dwm.content_snippet LIKE ? OR dwm.source_channel LIKE ? OR b.name LIKE ?)");
                          const like = `%${q}%`;
                          params.push(like, like, like); }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const tally = newTally();

    // Page rows + filtered total + global aggregates in parallel.
    // Aggregates use only status=active so they stay cacheable and
    // give the UI a stable "what's on the dark web overall" picture
    // independent of the user's filter combo.
    const [rowsRes, countRow, aggRow, bySourceRes, bySeverityRes] = await Promise.all([
      session.prepare(`
        SELECT dwm.id, dwm.brand_id, dwm.source, dwm.source_url, dwm.source_channel,
               dwm.source_author, dwm.posted_at, dwm.content_snippet,
               dwm.matched_terms, dwm.match_type, dwm.classification,
               dwm.classified_by, dwm.classification_confidence,
               dwm.classification_reason, dwm.severity, dwm.status,
               dwm.first_seen, dwm.last_seen, dwm.ai_action,
               b.name AS brand_name, b.canonical_domain AS brand_domain
        FROM dark_web_mentions dwm
        LEFT JOIN brands b ON b.id = dwm.brand_id
        ${whereClause}
        ORDER BY ${sortColumn} ${sqlDir}, dwm.id
        LIMIT ? OFFSET ?
      `).bind(...params, limit, offset).all(),
      session.prepare(`
        SELECT COUNT(*) AS n
        FROM dark_web_mentions dwm
        LEFT JOIN brands b ON b.id = dwm.brand_id
        ${whereClause}
      `).bind(...params).first<{ n: number }>(),
      session.prepare(`
        SELECT
          COUNT(*) AS total_active,
          SUM(CASE WHEN classification = 'confirmed'  THEN 1 ELSE 0 END) AS confirmed_active,
          SUM(CASE WHEN classification = 'suspicious' THEN 1 ELSE 0 END) AS suspicious_active,
          SUM(CASE WHEN severity = 'CRITICAL'         THEN 1 ELSE 0 END) AS critical_active,
          SUM(CASE WHEN severity = 'HIGH'             THEN 1 ELSE 0 END) AS high_active,
          SUM(CASE WHEN severity = 'MEDIUM'           THEN 1 ELSE 0 END) AS medium_active,
          SUM(CASE WHEN severity = 'LOW'              THEN 1 ELSE 0 END) AS low_active
        FROM dark_web_mentions
        WHERE status = 'active'
      `).first<{
        total_active: number; confirmed_active: number; suspicious_active: number;
        critical_active: number; high_active: number; medium_active: number; low_active: number;
      }>(),
      session.prepare(`
        SELECT source, COUNT(*) AS n
        FROM dark_web_mentions
        WHERE status = 'active'
        GROUP BY source
        ORDER BY n DESC
      `).all<{ source: string; n: number }>(),
      session.prepare(`
        SELECT severity, COUNT(*) AS n
        FROM dark_web_mentions
        WHERE status = 'active'
        GROUP BY severity
      `).all<{ severity: string; n: number }>(),
    ]);

    addToTally(tally, rowsRes.meta);
    addToTally(tally, bySourceRes.meta);
    addToTally(tally, bySeverityRes.meta);
    tally.queries += 2; // countRow + aggRow from .first()
    recordD1Reads(env, "darkweb_all_mentions", tally);

    const responseBody = {
      success: true,
      data: {
        results: rowsRes.results,
        total: countRow?.n ?? 0,
        aggregates: {
          slice: aggRow ?? {
            total_active: 0, confirmed_active: 0, suspicious_active: 0,
            critical_active: 0, high_active: 0, medium_active: 0, low_active: 0,
          },
          by_source:   bySourceRes.results,
          by_severity: bySeverityRes.results,
        },
        applied: {
          source, classification, severity, match_type: matchType,
          status, brand_id: brandId, q, sort, dir, limit, offset,
        },
      },
    };

    await env.CACHE.put(cacheKey, JSON.stringify(responseBody), { expirationTtl: 60 });
    return attachBookmark(json(responseBody, 200, origin), session);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/darkweb/mentions/:brandId ──────────────────────────

export async function handleListDarkWebMentions(
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
    const source = url.searchParams.get("source");
    const classification = url.searchParams.get("classification");
    const severity = url.searchParams.get("severity");
    const matchType = url.searchParams.get("match_type");
    const status = url.searchParams.get("status") ?? "active";
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    // KV cache — page-load endpoint convention (CLAUDE.md §8). Reduced-
    // dimension key for default views (no filters, page 1) so the typical
    // brand-detail page load hits the same cache slot regardless of user.
    // Cache version baked into the key so PATCH/POST writes can invalidate
    // by bumping `cache_version:darkweb`.
    const cacheVersion = await getCacheVersion(env, "darkweb");
    const isDefaultView = !source && !classification && !severity && !matchType
      && status === "active" && offset === 0 && limit === 50;
    const cacheKey = isDefaultView
      ? `darkweb_mentions:v${cacheVersion}:${brandId}:default`
      : `darkweb_mentions:v${cacheVersion}:${brandId}:${status}:${source ?? ""}:${classification ?? ""}:${severity ?? ""}:${matchType ?? ""}:${limit}:${offset}`;

    const dbCtx = getDbContext(request);
    const session = getReadSession(env, dbCtx);

    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      // Cache hit — record zero D1 reads so AE attribution reflects
      // actual database load, not request volume.
      recordD1Reads(env, "darkweb_mentions", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    let where = "WHERE brand_id = ?";
    const params: unknown[] = [brandId];

    if (source) { where += " AND source = ?"; params.push(source); }
    if (classification) { where += " AND classification = ?"; params.push(classification); }
    if (severity) { where += " AND severity = ?"; params.push(severity); }
    if (matchType) { where += " AND match_type = ?"; params.push(matchType); }
    if (status) { where += " AND status = ?"; params.push(status); }

    const tally = newTally();

    // Parallelize the three reads — independent queries, no need to serialize.
    const [rows, countRow, schedule] = await Promise.all([
      session.prepare(`
        SELECT * FROM dark_web_mentions
        ${where}
        ORDER BY
          CASE severity
            WHEN 'CRITICAL' THEN 1
            WHEN 'HIGH' THEN 2
            WHEN 'MEDIUM' THEN 3
            WHEN 'LOW' THEN 4
          END,
          classification = 'confirmed' DESC,
          classification = 'suspicious' DESC,
          COALESCE(last_seen, first_seen) DESC
        LIMIT ? OFFSET ?
      `).bind(...params, limit, offset).all(),
      session.prepare(
        `SELECT COUNT(*) AS n FROM dark_web_mentions ${where}`,
      ).bind(...params).first<{ n: number }>(),
      session.prepare(
        "SELECT platform, last_checked, next_check, check_interval_hours, enabled FROM brand_monitor_schedule WHERE brand_id = ? AND monitor_type = 'darkweb'",
      ).bind(brandId).all(),
    ]);

    addToTally(tally, rows.meta);
    addToTally(tally, schedule.meta);
    // countRow comes from .first() which doesn't expose meta directly;
    // count is small (1-2 rows read) and approximated as 1 for the tally.
    tally.queries += 1;
    recordD1Reads(env, "darkweb_mentions", tally);

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

// ─── POST /api/darkweb/scan/:brandId ─────────────────────────────

export async function handleTriggerDarkWebScan(
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
      "SELECT id, name, canonical_domain AS domain, aliases, executive_names FROM brands WHERE id = ?",
    ).bind(brandId).first<{
      id: string;
      name: string;
      domain: string | null;
      aliases: string | null;
      executive_names: string | null;
    }>();

    if (!brandRow) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }

    const results = await runDarkWebMonitorForBrand(env, brandRow, {
      userId,
      triggeredBy: "manual",
    });

    // Advance the schedule so the cron doesn't immediately re-run this brand.
    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE brand_monitor_schedule
      SET last_checked = ?,
          next_check = datetime(?, '+' || check_interval_hours || ' hours')
      WHERE brand_id = ? AND monitor_type = 'darkweb' AND enabled = 1
    `).bind(now, now, brandId).run();

    // Drain AI queue for this brand so the caller sees verdicts in the response.
    const ai = await runDarkWebAIAssessmentBatch(env, { brandId, limit: 10 });

    // Manual scan introduced new mentions — invalidate the domain cache.
    await bumpCacheVersion(env, "darkweb");

    await audit(env, {
      action: "dark_web_scan_triggered",
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

// ─── PATCH /api/darkweb/:id ──────────────────────────────────────

export async function handleUpdateDarkWebMention(
  request: Request,
  env: Env,
  mentionId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const existing = await env.DB.prepare(
      "SELECT id, brand_id FROM dark_web_mentions WHERE id = ?",
    ).bind(mentionId).first<{ id: string; brand_id: string }>();

    if (!existing) {
      return json({ success: false, error: "Dark-web mention not found" }, 404, origin);
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
    }

    if (updates.length === 0) {
      return json({ success: false, error: "No valid fields to update" }, 400, origin);
    }

    updates.push("updated_at = datetime('now')");
    values.push(mentionId);

    await env.DB.prepare(
      `UPDATE dark_web_mentions SET ${updates.join(", ")} WHERE id = ?`,
    ).bind(...values).run();

    // Invalidate cached dark-web responses — overview + brand list both
    // depend on the mention's classification / status / severity, so any
    // PATCH bumps the domain-wide version. See lib/cache-version.ts.
    await bumpCacheVersion(env, "darkweb");

    const updated = await env.DB.prepare(
      "SELECT * FROM dark_web_mentions WHERE id = ?",
    ).bind(mentionId).first();

    await audit(env, {
      action: "dark_web_mention_update",
      userId,
      resourceType: "dark_web_mention",
      resourceId: mentionId,
      details: { classification: body.classification, status: body.status },
      request,
    });

    return json({ success: true, data: updated }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/darkweb/overview ───────────────────────────────────
// Scope rules match handleAppStoreOverview — see the comment block there.

export async function handleDarkWebOverview(
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
      return json({
        success: true,
        data: [],
        total: 0,
        totals: { total: 0, confirmed: 0, suspicious: 0, critical: 0, high: 0 },
      }, 200, origin);
    }

    // KV cache — page-load convention. Default view (page 1, limit 50) gets
    // a tighter key so all admins / all members of the same org share a slot.
    // Version-tagged for PATCH/POST invalidation (see lib/cache-version.ts).
    const cacheVersion = await getCacheVersion(env, "darkweb");
    const isDefaultView = limit === 50 && offset === 0;
    const cacheKey = isDefaultView
      ? `darkweb_overview:v${cacheVersion}:${scopeKey}:default`
      : `darkweb_overview:v${cacheVersion}:${scopeKey}:${limit}:${offset}`;

    const dbCtx = getDbContext(request);
    const session = getReadSession(env, dbCtx);

    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "darkweb_overview", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();

    // Stage 1: list brands + total count + cross-brand totals — three
    // independent reads, run in parallel.
    const [brands, total, totals] = await Promise.all([
      session.prepare(`
        SELECT b.id, b.name AS brand_name, b.canonical_domain AS domain,
               b.executive_names, b.first_seen AS created_at
        FROM brands b
        ${scope}
        ORDER BY b.name ASC
        LIMIT ? OFFSET ?
      `).bind(...scopeParams, limit, offset).all<{
        id: string;
        brand_name: string;
        domain: string | null;
        executive_names: string | null;
        created_at: string;
      }>(),
      session.prepare(
        `SELECT COUNT(*) AS n FROM brands b ${scope}`,
      ).bind(...scopeParams).first<{ n: number }>(),
      session.prepare(`
        SELECT
          SUM(CASE WHEN classification = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
          SUM(CASE WHEN classification = 'suspicious' THEN 1 ELSE 0 END) AS suspicious,
          SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) AS critical,
          SUM(CASE WHEN severity = 'HIGH' THEN 1 ELSE 0 END) AS high,
          COUNT(*) AS total
        FROM dark_web_mentions dwm
        INNER JOIN brands b ON b.id = dwm.brand_id
        ${scope}
        WHERE dwm.status = 'active'
      `).bind(...scopeParams).first<{
        confirmed: number | null;
        suspicious: number | null;
        critical: number | null;
        high: number | null;
        total: number | null;
      }>(),
    ]);

    // Stage 2: per-brand stats from the dark_web_brand_summary cube +
    // monitor schedule. Two IN-list reads instead of GROUP BY against the
    // raw mentions table. Cube is rebuilt every 6h by cube_healer; the
    // 5-min KV cache above absorbs short-term staleness. For 50 brands,
    // this drops the previous 2 × N (100 sub-requests) plus the GROUP BY
    // scan over all active mentions to ~2 small indexed reads.
    const brandIds = brands.results.map(b => b.id);
    const placeholders = brandIds.map(() => "?").join(",");

    let summaryByBrand = new Map<string, {
      total_active: number; confirmed_active: number; suspicious_active: number;
      critical_active: number; high_active: number; medium_active: number; low_active: number;
    }>();
    let scheduleByBrand = new Map<string, { last_checked: string | null; next_check: string | null }>();

    if (brandIds.length > 0) {
      const [summaryRows, schedRows] = await Promise.all([
        session.prepare(`
          SELECT brand_id, total_active,
                 confirmed_active, suspicious_active,
                 critical_active, high_active, medium_active, low_active
          FROM dark_web_brand_summary
          WHERE brand_id IN (${placeholders})
        `).bind(...brandIds).all<{
          brand_id: string;
          total_active: number; confirmed_active: number; suspicious_active: number;
          critical_active: number; high_active: number; medium_active: number; low_active: number;
        }>(),
        session.prepare(`
          SELECT brand_id, last_checked, next_check
          FROM brand_monitor_schedule
          WHERE brand_id IN (${placeholders})
            AND monitor_type = 'darkweb'
            AND enabled = 1
        `).bind(...brandIds).all<{ brand_id: string; last_checked: string | null; next_check: string | null }>(),
      ]);

      addToTally(tally, summaryRows.meta);
      addToTally(tally, schedRows.meta);

      for (const r of summaryRows.results) summaryByBrand.set(r.brand_id, r);
      for (const r of schedRows.results) scheduleByBrand.set(r.brand_id, { last_checked: r.last_checked, next_check: r.next_check });
    }

    addToTally(tally, brands.meta);
    // total + totals come from .first() — count both as 1 query each
    tally.queries += 2;
    recordD1Reads(env, "darkweb_overview", tally);

    const brandsWithStats = brands.results.map((brand) => {
      const s = summaryByBrand.get(brand.id);
      const counts = {
        total: s?.total_active ?? 0,
        confirmed: s?.confirmed_active ?? 0,
        suspicious: s?.suspicious_active ?? 0,
        critical: s?.critical_active ?? 0,
        high: s?.high_active ?? 0,
        medium: s?.medium_active ?? 0,
        low: s?.low_active ?? 0,
      };
      const sched = scheduleByBrand.get(brand.id);
      return {
        ...brand,
        has_executives: Boolean(brand.executive_names && brand.executive_names !== "[]"),
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
        confirmed: totals?.confirmed ?? 0,
        suspicious: totals?.suspicious ?? 0,
        critical: totals?.critical ?? 0,
        high: totals?.high ?? 0,
      },
    };

    await env.CACHE.put(cacheKey, JSON.stringify(responseBody), { expirationTtl: 300 });
    return attachBookmark(json(responseBody, 200, origin), session);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
