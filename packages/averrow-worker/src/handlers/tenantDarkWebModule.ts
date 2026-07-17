// Averrow — Dark Web Monitoring tenant module surface
//
// Mirrors handlers/tenantAppStoreModule.ts for the dark_web_mentions
// table. Two endpoints:
//
//   GET /api/orgs/:orgId/modules/dark-web
//     Per-brand summary across sources (pastebin, telegram, hibp,
//     flare, darkowl, …).
//
//   GET /api/orgs/:orgId/modules/dark-web/brands/:brandId
//     Per-brand drill-down: mentions with classification +
//     severity, ordered by severity → classification → recency.
//
// Phase B sprint 5.

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import { requireModule, ModuleNotEntitledError } from "../lib/entitlements";

function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

interface DarkWebBrandSummary {
  brand_id:                string;
  brand_name:              string;
  canonical_domain:        string;
  mentions_total:          number;
  mentions_confirmed:      number;
  mentions_suspicious:     number;
  mentions_unknown:        number;
  mentions_false_positive: number;
  mentions_high_critical:  number;
  sources_covered:         number;   // distinct sources for this brand's mentions
}

// ─── GET /api/orgs/:orgId/modules/dark-web ──────────────────────

export async function handleGetDarkWebModuleSummary(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "dark_web");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Dark Web Monitoring isn't enabled for your organization. Contact support@averrow.com.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  // 5-min KV cache. Invalidated implicitly on the same cadence as
  // the staff darkweb handler (which uses cache_version:darkweb).
  // The data this page renders is hourly/6-hourly in nature (scans
  // run on the dark_web_monitor cron) so a 5-min TTL is operator-
  // imperceptible and absorbs the cost of repeated tenant page loads.
  const cacheKey = `tenant:dark_web:summary:v2:${orgIdNum}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  // Single GROUP BY against the brand×mention join — replaces the
  // previous 7 correlated subqueries per brand row (N brands ×
  // 7 = 7N sub-requests) with one indexed scan. dwm.brand_id is
  // indexed (idx_dark_web_mentions_brand) so the LEFT JOIN walks
  // mentions cheaply per brand and aggregates in one pass.
  const result = await env.DB.prepare(
    `SELECT
       b.id AS brand_id,
       b.name AS brand_name,
       b.canonical_domain,
       COALESCE(SUM(CASE WHEN dwm.status = 'active' THEN 1 ELSE 0 END), 0) AS mentions_total,
       COALESCE(SUM(CASE WHEN dwm.status = 'active' AND dwm.classification = 'confirmed' THEN 1 ELSE 0 END), 0) AS mentions_confirmed,
       COALESCE(SUM(CASE WHEN dwm.status = 'active' AND dwm.classification = 'suspicious' THEN 1 ELSE 0 END), 0) AS mentions_suspicious,
       COALESCE(SUM(CASE WHEN dwm.status = 'active' AND dwm.classification = 'unknown' THEN 1 ELSE 0 END), 0) AS mentions_unknown,
       COALESCE(SUM(CASE WHEN dwm.classification = 'false_positive' THEN 1 ELSE 0 END), 0) AS mentions_false_positive,
       COALESCE(SUM(CASE WHEN dwm.status = 'active' AND LOWER(dwm.severity) IN ('high','critical') THEN 1 ELSE 0 END), 0) AS mentions_high_critical,
       COUNT(DISTINCT CASE WHEN dwm.status = 'active' THEN dwm.source END) AS sources_covered
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     LEFT JOIN dark_web_mentions dwm ON dwm.brand_id = b.id
     WHERE ob.org_id = ?
     GROUP BY b.id, b.name, b.canonical_domain, ob.is_primary
     ORDER BY ob.is_primary DESC, b.name`,
  ).bind(orgIdNum).all<DarkWebBrandSummary>();

  const brands = result.results ?? [];

  const totals = brands.reduce((acc, b) => ({
    mentions_total:          acc.mentions_total          + b.mentions_total,
    mentions_confirmed:      acc.mentions_confirmed      + b.mentions_confirmed,
    mentions_suspicious:     acc.mentions_suspicious     + b.mentions_suspicious,
    mentions_unknown:        acc.mentions_unknown        + b.mentions_unknown,
    mentions_false_positive: acc.mentions_false_positive + b.mentions_false_positive,
    mentions_high_critical:  acc.mentions_high_critical  + b.mentions_high_critical,
  }), {
    mentions_total: 0, mentions_confirmed: 0, mentions_suspicious: 0,
    mentions_unknown: 0, mentions_false_positive: 0, mentions_high_critical: 0,
  });

  const body = {
    success: true,
    data: { org_id: orgIdNum, brands, totals },
  };
  await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 300 });
  return json(body, 200, origin);
}

// ─── GET /api/orgs/:orgId/modules/dark-web/mentions ─────────────
// Org-scoped flat mention list across all the org's brands.
// Powers the platform-standard table layout on the customer-facing
// Dark Web page. Mirrors the ops handleListAllDarkWebMentions in
// shape; adds an `AND brand_id IN (org's brands)` clause so a
// tenant only sees their own findings.

interface OrgDarkWebMentionRow {
  id:                       string;
  brand_id:                 string;
  source:                   string;
  source_url:               string;
  source_channel:           string | null;
  source_author:            string | null;
  posted_at:                string | null;
  content_snippet:          string | null;
  matched_terms:            string | null;
  match_type:               string | null;
  classification:           string;
  classified_by:            string | null;
  classification_confidence: number | null;
  classification_reason:    string | null;
  ai_action:                string | null;
  severity:                 string;
  status:                   string;
  first_seen:               string;
  last_seen:                string | null;
  brand_name:               string | null;
  brand_domain:             string | null;
}

export async function handleGetOrgDarkWebMentions(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "dark_web");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Dark Web Monitoring isn't enabled for your organization.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  const url = new URL(request.url);
  const source         = url.searchParams.get("source");
  const classification = url.searchParams.get("classification");
  const severity       = url.searchParams.get("severity");
  const matchType      = url.searchParams.get("match_type");
  const status         = url.searchParams.get("status") ?? "active";
  const brandId        = url.searchParams.get("brand_id");
  const q              = url.searchParams.get("q")?.trim();
  const sort           = (url.searchParams.get("sort") ?? "last_seen").toLowerCase();
  const dirRaw         = (url.searchParams.get("dir") ?? "desc").toLowerCase();
  const dir: "asc" | "desc" = dirRaw === "asc" ? "asc" : "desc";
  const limit          = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
  const offset         = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));

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
  const sqlDir = sort === "severity"
    ? (dir === "asc" ? "DESC" : "ASC")
    : (dir === "asc" ? "ASC" : "DESC");

  // KV cache scoped to org. Default view gets a reduced key so
  // repeat tenant loads hit the same slot regardless of user.
  const isDefaultView = !source && !classification && !severity && !matchType
    && !brandId && !q && status === "active" && offset === 0 && limit === 50
    && sort === "last_seen" && dir === "desc";
  const cacheKey = isDefaultView
    ? `tenant:dark_web:mentions:v2:${orgIdNum}:default`
    : `tenant:dark_web:mentions:v2:${orgIdNum}:${status}:${source ?? ""}:${classification ?? ""}:${severity ?? ""}:${matchType ?? ""}:${brandId ?? ""}:${q ?? ""}:${sort}:${dir}:${limit}:${offset}`;

  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  const filters: string[] = [
    `dwm.brand_id IN (SELECT brand_id FROM org_brands WHERE org_id = ?)`,
  ];
  const params: unknown[] = [orgIdNum];

  if (status)         { filters.push("dwm.status = ?");         params.push(status); }
  if (source)         { filters.push("dwm.source = ?");         params.push(source); }
  if (classification) { filters.push("dwm.classification = ?"); params.push(classification); }
  if (severity)       { filters.push("dwm.severity = ?");       params.push(severity); }
  if (matchType)      { filters.push("dwm.match_type = ?");     params.push(matchType); }
  if (brandId)        { filters.push("dwm.brand_id = ?");       params.push(brandId); }
  if (q) {
    filters.push("(dwm.content_snippet LIKE ? OR dwm.source_channel LIKE ? OR b.name LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const whereClause = `WHERE ${filters.join(" AND ")}`;

  // Aggregates: scope to org's active mentions, independent of
  // filter combo so the UI sidecars stay stable across filters.
  const [rowsRes, countRow, aggRow, bySourceRes, bySeverityRes] = await Promise.all([
    env.DB.prepare(`
      SELECT dwm.id, dwm.brand_id, dwm.source, dwm.source_url, dwm.source_channel,
             dwm.source_author, dwm.posted_at, dwm.content_snippet,
             dwm.matched_terms, dwm.match_type, dwm.classification,
             dwm.classified_by, dwm.classification_confidence,
             dwm.classification_reason, dwm.ai_action,
             dwm.severity, dwm.status, dwm.first_seen, dwm.last_seen,
             b.name AS brand_name, b.canonical_domain AS brand_domain
      FROM dark_web_mentions dwm
      LEFT JOIN brands b ON b.id = dwm.brand_id
      ${whereClause}
      ORDER BY ${sortColumn} ${sqlDir}, dwm.id
      LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all<OrgDarkWebMentionRow>(),
    env.DB.prepare(`
      SELECT COUNT(*) AS n
      FROM dark_web_mentions dwm
      LEFT JOIN brands b ON b.id = dwm.brand_id
      ${whereClause}
    `).bind(...params).first<{ n: number }>(),
    env.DB.prepare(`
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
        AND brand_id IN (SELECT brand_id FROM org_brands WHERE org_id = ?)
    `).bind(orgIdNum).first<{
      total_active: number; confirmed_active: number; suspicious_active: number;
      critical_active: number; high_active: number; medium_active: number; low_active: number;
    }>(),
    env.DB.prepare(`
      SELECT source, COUNT(*) AS n
      FROM dark_web_mentions
      WHERE status = 'active'
        AND brand_id IN (SELECT brand_id FROM org_brands WHERE org_id = ?)
      GROUP BY source
      ORDER BY n DESC
    `).bind(orgIdNum).all<{ source: string; n: number }>(),
    env.DB.prepare(`
      SELECT severity, COUNT(*) AS n
      FROM dark_web_mentions
      WHERE status = 'active'
        AND brand_id IN (SELECT brand_id FROM org_brands WHERE org_id = ?)
      GROUP BY severity
    `).bind(orgIdNum).all<{ severity: string; n: number }>(),
  ]);

  const body = {
    success: true,
    data: {
      org_id: orgIdNum,
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

  await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 60 });
  return json(body, 200, origin);
}

// ─── GET /api/orgs/:orgId/modules/dark-web/brands/:brandId ──────

export interface DarkWebMentionRow {
  id:                       string;
  brand_id:                 string;
  source:                   string;
  source_url:               string;
  source_channel:           string | null;
  source_author:            string | null;
  posted_at:                string | null;
  content_snippet:          string | null;
  matched_terms:            string | null;
  match_type:               string | null;
  classification:           string;
  classified_by:            string | null;
  classification_confidence: number | null;
  classification_reason:    string | null;
  ai_assessment:            string | null;
  ai_action:                string | null;
  severity:                 string;
  status:                   string;
  first_seen:               string;
  last_seen:                string | null;
}

export async function handleGetBrandDarkWebFindings(
  request: Request,
  env:     Env,
  orgId:   string,
  brandId: string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "dark_web");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Dark Web Monitoring isn't enabled for your organization.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  // Brand-ownership check via org_brands. super_admin bypasses.
  let brandOk: { id: string } | null = null;
  if (ctx.role === "super_admin") {
    brandOk = await env.DB.prepare(
      "SELECT id FROM brands WHERE id = ?",
    ).bind(brandId).first<{ id: string }>();
  } else {
    brandOk = await env.DB.prepare(
      `SELECT b.id FROM brands b
       JOIN org_brands ob ON ob.brand_id = b.id
       WHERE b.id = ? AND ob.org_id = ?`,
    ).bind(brandId, orgIdNum).first<{ id: string }>();
  }
  if (!brandOk) {
    return json({ success: false, error: "Brand not found" }, 404, origin);
  }

  const FINDINGS_LIMIT = 100;
  const mentions = await env.DB.prepare(
    `SELECT id, brand_id, source, source_url, source_channel, source_author,
            posted_at, content_snippet, matched_terms, match_type,
            classification, classified_by, classification_confidence,
            classification_reason, ai_assessment, ai_action,
            severity, status, first_seen, last_seen
     FROM dark_web_mentions
     WHERE brand_id = ? AND status != 'resolved'
     ORDER BY
       CASE LOWER(severity) WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
       CASE classification
         WHEN 'confirmed'      THEN 1
         WHEN 'suspicious'     THEN 2
         WHEN 'unknown'        THEN 3
         WHEN 'false_positive' THEN 4
         ELSE 5
       END,
       COALESCE(posted_at, first_seen) DESC
     LIMIT ?`,
  ).bind(brandId, FINDINGS_LIMIT).all<DarkWebMentionRow>();

  return json({
    success: true,
    data: {
      brand_id:  brandId,
      mentions:  mentions.results,
      page_size: FINDINGS_LIMIT,
    },
  }, 200, origin);
}
