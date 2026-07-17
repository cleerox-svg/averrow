// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Tenant Data Endpoints (org-scoped, data-isolated)

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import { emitOrgEvent } from "../lib/org-events";
import { cachedValue } from "../lib/cached-value";
import type { Env, MonitoringConfigBody } from "../types";
import type { AuthContext } from "../middleware/auth";

// ─── Helpers ─────────────────────────────────────────────────

const ORG_ROLE_HIERARCHY: Record<string, number> = {
  viewer: 1, analyst: 2, admin: 3, owner: 4,
};

function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

function canPerformHITL(ctx: AuthContext): boolean {
  if (ctx.role === "super_admin") return true;
  return (ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0) >= (ORG_ROLE_HIERARCHY["analyst"] ?? 2);
}

function isOrgAdmin(ctx: AuthContext): boolean {
  if (ctx.role === "super_admin") return true;
  return (ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0) >= 3;
}

// ─── GET /api/orgs/:orgId/dashboard ──────────────────────────

export async function handleTenantDashboard(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    // Brands with rich data
    const brandsResult = await env.DB.prepare(`
      SELECT b.id, b.name, b.canonical_domain, b.sector, b.threat_count,
             b.exposure_score, b.email_security_grade, b.social_risk_score,
             b.last_social_scan, b.last_threat_seen, ob.is_primary,
             b.active_threat_count AS active_threats,
             COALESCE(sp_all.cnt, 0) AS social_profiles_count,
             COALESCE(sp_imp.cnt, 0) AS impersonation_count
      FROM org_brands ob
      JOIN brands b ON b.id = ob.brand_id
      LEFT JOIN (SELECT brand_id, COUNT(*) AS cnt FROM social_profiles WHERE status = 'active' GROUP BY brand_id) sp_all ON sp_all.brand_id = b.id
      LEFT JOIN (SELECT brand_id, COUNT(*) AS cnt FROM social_profiles WHERE classification = 'impersonation' AND status = 'active' GROUP BY brand_id) sp_imp ON sp_imp.brand_id = b.id
      WHERE ob.org_id = ?
      ORDER BY b.threat_count DESC
      LIMIT 200
    `).bind(orgId).all();

    const brands = brandsResult.results || [];

    // Aggregate stats
    let totalActiveThreats = 0;
    let totalSocialProfiles = 0;
    let totalImpersonation = 0;
    let exposureSum = 0;
    let exposureCount = 0;

    for (const b of brands as Array<Record<string, unknown>>) {
      totalActiveThreats += Number(b.active_threats) || 0;
      totalSocialProfiles += Number(b.social_profiles_count) || 0;
      totalImpersonation += Number(b.impersonation_count) || 0;
      if (b.exposure_score != null) {
        exposureSum += Number(b.exposure_score);
        exposureCount++;
      }
    }

    // Open alerts count
    const alertCountResult = await env.DB.prepare(`
      SELECT COUNT(*) AS cnt FROM alerts a
      JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
      WHERE a.status IN ('new', 'acknowledged', 'investigating')
    `).bind(orgId).first<{ cnt: number }>();

    // Recent alerts (top 5) — diversified across alert_type so one noisy
    // category (e.g. campaign_impacts_brand) can't crowd out the rest.
    // Take the 2 most recent of each type, then pick top 5 by severity + recency.
    const recentAlertsResult = await env.DB.prepare(`
      WITH ranked AS (
        SELECT a.id, a.title, a.severity, a.alert_type, a.status, a.created_at,
               b.name AS brand_name,
               ROW_NUMBER() OVER (PARTITION BY a.alert_type ORDER BY a.created_at DESC) AS type_rank
        FROM alerts a
        JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
        JOIN brands b ON b.id = a.brand_id
        WHERE a.status IN ('new', 'acknowledged', 'investigating')
      )
      SELECT id, title, severity, alert_type, status, created_at, brand_name
      FROM ranked
      WHERE type_rank <= 2
      ORDER BY
        CASE LOWER(severity) WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        created_at DESC
      LIMIT 5
    `).bind(orgId).all();

    // 7-day threat trend
    const trendResult = await env.DB.prepare(`
      SELECT date(t.created_at) AS date, COUNT(*) AS count
      FROM threats t
      JOIN org_brands ob ON ob.brand_id = t.target_brand_id AND ob.org_id = ?
      WHERE t.created_at >= datetime('now', '-7 days')
      GROUP BY date(t.created_at)
      ORDER BY date ASC
    `).bind(orgId).all();

    return json({
      success: true,
      data: {
        total_brands: brands.length,
        total_active_threats: totalActiveThreats,
        total_alerts_open: alertCountResult?.cnt ?? 0,
        total_social_profiles: totalSocialProfiles,
        total_impersonation_alerts: totalImpersonation,
        avg_exposure_score: exposureCount > 0 ? Math.round(exposureSum / exposureCount) : null,
        brands,
        recent_alerts: recentAlertsResult.results || [],
        threat_trend: trendResult.results || [],
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/orgs/:orgId/alerts ─────────────────────────────

export async function handleTenantAlerts(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const severity = url.searchParams.get("severity");
    const brandId = url.searchParams.get("brand_id");
    const alertType = url.searchParams.get("alert_type");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 100);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    // Build dynamic WHERE clause
    const conditions: string[] = ["1=1"];
    const bindings: unknown[] = [orgId];

    if (status) { conditions.push("a.status = ?"); bindings.push(status); }
    if (severity) { conditions.push("a.severity = ?"); bindings.push(severity); }
    if (brandId) { conditions.push("a.brand_id = ?"); bindings.push(brandId); }
    if (alertType) { conditions.push("a.alert_type = ?"); bindings.push(alertType); }

    const whereClause = conditions.join(" AND ");

    // Get filtered alerts
    const alertsResult = await env.DB.prepare(`
      SELECT a.*, b.name AS brand_name, b.canonical_domain AS brand_domain
      FROM alerts a
      JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
      JOIN brands b ON b.id = a.brand_id
      WHERE ${whereClause}
      ORDER BY
        CASE LOWER(a.severity) WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        a.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...bindings, limit, offset).all();

    // Total count for pagination
    const countResult = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM alerts a
      JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
      WHERE ${whereClause}
    `).bind(...bindings).first<{ total: number }>();

    // Severity breakdown for filter bar
    const severityBreakdown = await env.DB.prepare(`
      SELECT a.severity, COUNT(*) AS count
      FROM alerts a
      JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
      WHERE ${whereClause}
      GROUP BY a.severity
    `).bind(...bindings).all();

    // Resolve assignee display names (cheap second query) so the queue can
    // show ownership without the client holding a member directory.
    const rawAlerts = (alertsResult.results || []) as Array<Record<string, unknown>>;
    const assigneeIds = [...new Set(
      rawAlerts.map((a) => a.assigned_to).filter((x): x is string => typeof x === "string" && !!x),
    )];
    const nameById: Record<string, string> = {};
    if (assigneeIds.length > 0) {
      const ph = assigneeIds.map(() => "?").join(",");
      const us = await env.DB.prepare(
        `SELECT id, COALESCE(display_name, name, email) AS name FROM users WHERE id IN (${ph})`,
      ).bind(...assigneeIds).all<{ id: string; name: string }>();
      for (const u of us.results ?? []) nameById[u.id] = u.name;
    }
    const data = rawAlerts.map((a) => ({
      ...a,
      assigned_to_name: a.assigned_to ? (nameById[a.assigned_to as string] ?? null) : null,
    }));

    return json({
      success: true,
      data,
      total: countResult?.total ?? 0,
      severity_breakdown: severityBreakdown.results || [],
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/orgs/:orgId/alerts/:alertId ────────────────────
//
// Single-signal detail for the Intelligence Card
// (TENANT_ANALYST_UX_RESEARCH_2026-06 §5.3). Same columns + brand JOIN
// as the list, plus assignee-name resolution, scoped to the org's
// owned brands via org_brands. Deep-linkable so the card survives a
// hard refresh / direct nav without the list in cache.
export async function handleTenantAlertDetail(
  request: Request,
  env: Env,
  orgId: string,
  alertId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    const alert = await env.DB.prepare(`
      SELECT a.*, b.name AS brand_name, b.canonical_domain AS brand_domain
      FROM alerts a
      JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
      JOIN brands b ON b.id = a.brand_id
      WHERE a.id = ?
    `).bind(orgId, alertId).first<Record<string, unknown>>();

    if (!alert) {
      return json({ success: false, error: "Signal not found" }, 404, origin);
    }

    let assignedToName: string | null = null;
    if (alert.assigned_to && typeof alert.assigned_to === "string") {
      const u = await env.DB.prepare(
        "SELECT COALESCE(display_name, name, email) AS name FROM users WHERE id = ?",
      ).bind(alert.assigned_to).first<{ name: string }>();
      assignedToName = u?.name ?? null;
    }

    return json({
      success: true,
      data: { ...alert, assigned_to_name: assignedToName },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/orgs/:orgId/audit-log ──────────────────────────
//
// Tenant-facing who/what/when of automation + human actions on the org
// (TENANT_ANALYST_UX_RESEARCH_2026-06 §5.5 — trust/defensibility). Audit
// rows live in the separate AUDIT_DB and have no org_id column; org-scoped
// actions stash org_id inside the details JSON, so we filter on
// json_extract(details,'$.org_id'). Actor display names are resolved from
// the main DB. ip_address / user_agent are intentionally NOT exposed.
export async function handleTenantAuditLog(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);
  if (!canPerformHITL(ctx)) {
    return json({ success: false, error: "Requires org role: analyst or higher" }, 403, origin);
  }

  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 100);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const rows = await env.AUDIT_DB.prepare(`
      SELECT id, timestamp, user_id, action, resource_type, resource_id, details, outcome
      FROM audit_log
      WHERE json_extract(details, '$.org_id') = ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).bind(orgId, limit, offset).all<{
      id: string; timestamp: string; user_id: string | null;
      action: string; resource_type: string | null; resource_id: string | null;
      details: string | null; outcome: string;
    }>();

    const countRow = await env.AUDIT_DB.prepare(`
      SELECT COUNT(*) AS total FROM audit_log WHERE json_extract(details, '$.org_id') = ?
    `).bind(orgId).first<{ total: number }>();

    const entries = rows.results ?? [];

    // Resolve actor display names from the main DB (cross-DB, so a second query).
    const userIds = [...new Set(entries.map((e) => e.user_id).filter((id): id is string => !!id))];
    const nameById: Record<string, string> = {};
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      const users = await env.DB.prepare(
        `SELECT id, COALESCE(display_name, name, email) AS name FROM users WHERE id IN (${placeholders})`,
      ).bind(...userIds).all<{ id: string; name: string }>();
      for (const u of users.results ?? []) nameById[u.id] = u.name;
    }

    const data = entries.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      actor: e.user_id ? (nameById[e.user_id] ?? e.user_id) : null,
      action: e.action,
      resource_type: e.resource_type,
      outcome: e.outcome,
      details: e.details,
    }));

    return json({ success: true, data, total: countRow?.total ?? 0 }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/orgs/:orgId/threats ────────────────────────────
//
// Org-wide threat browser. Lists individual threat records across
// every brand the org owns (joined through org_brands), with optional
// brand / status / severity / type filters, free-text domain search,
// pagination, and faceted breakdowns. Modeled on handleTenantAlerts.
//
// This is the surface that finally exposes the production threats-table
// volume to tenant users: the dashboard's per-brand counts now have a
// records view to drill into. Defaults to status='active'.

export async function handleTenantOrgThreats(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const severity = url.searchParams.get("severity");
    const threatType = url.searchParams.get("threat_type") ?? url.searchParams.get("type");
    const brandId = url.searchParams.get("brand_id");
    const country = url.searchParams.get("country");
    const q = url.searchParams.get("q");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 100);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    // Whitelisted server-side sort (column key -> SQL expression). Severity
    // ranks critical highest so dir=desc puts critical first.
    const SORT_COLUMNS: Record<string, string> = {
      severity:   "CASE t.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END",
      last_seen:  "t.last_seen", first_seen: "t.first_seen", brand: "b.name",
      type: "t.threat_type", status: "t.status", confidence: "t.confidence_score",
      target: "t.malicious_domain", source: "t.source_feed", country: "t.country_code",
    };
    const sortParam = url.searchParams.get("sort") ?? "severity";
    const dir = (url.searchParams.get("dir") ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const sortCol = SORT_COLUMNS[sortParam] ?? SORT_COLUMNS.severity;

    // org_id is bindings[0] — consumed by the org_brands JOIN in every query.
    const conditions: string[] = ["1=1"];
    const bindings: unknown[] = [orgId];

    // Default to active threats; status=all opts into every status.
    if (status && status !== "all") {
      conditions.push("t.status = ?");
      bindings.push(status);
    } else if (!status) {
      conditions.push("t.status = ?");
      bindings.push("active");
    }
    if (severity)   { conditions.push("t.severity = ?");        bindings.push(severity); }
    if (threatType) { conditions.push("t.threat_type = ?");     bindings.push(threatType); }
    if (brandId)    { conditions.push("t.target_brand_id = ?"); bindings.push(brandId); }
    if (country)    { conditions.push("t.country_code = ?");    bindings.push(country); }
    if (q)          { conditions.push("(t.malicious_domain LIKE ? OR t.malicious_url LIKE ? OR t.ip_address LIKE ?)"); bindings.push(`%${q}%`, `%${q}%`, `%${q}%`); }

    const whereClause = conditions.join(" AND ");

    const compute = async () => {
      // Rows page — curated evidence/infra/correlation columns so the
      // shared table's detail drawer can answer "why this verdict".
      const threatsResult = await env.DB.prepare(`
        SELECT t.id, t.threat_type, t.malicious_domain, t.malicious_url,
               t.target_brand_id, t.source_feed, t.severity, t.status,
               t.confidence_score, t.country_code, t.ip_address,
               t.asn, t.registrar, t.registration_date,
               t.campaign_id, t.cluster_id, t.saas_technique_id,
               t.vt_checked, t.vt_malicious, t.vt_reputation,
               t.gsb_checked, t.gsb_flagged, t.gsb_threat_type,
               t.surbl_checked, t.surbl_listed,
               t.greynoise_checked, t.greynoise_classification,
               t.seclookup_checked, t.seclookup_risk_score,
               t.abuseipdb_checked, t.abuseipdb_score, t.abuseipdb_reports,
               t.first_seen, t.last_seen,
               hp.name AS hosting_provider, st.name AS saas_technique_name,
               b.name AS brand_name, b.canonical_domain AS brand_domain
        FROM threats t
        JOIN org_brands ob ON ob.brand_id = t.target_brand_id AND ob.org_id = ?
        JOIN brands b ON b.id = t.target_brand_id
        LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
        LEFT JOIN saas_techniques st ON st.id = t.saas_technique_id
        WHERE ${whereClause}
        ORDER BY ${sortCol} ${dir}, t.last_seen DESC
        LIMIT ? OFFSET ?
      `).bind(...bindings, limit, offset).all();

      const countResult = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM threats t
        JOIN org_brands ob ON ob.brand_id = t.target_brand_id AND ob.org_id = ?
        WHERE ${whereClause}
      `).bind(...bindings).first<{ total: number }>();

      const severityBreakdown = await env.DB.prepare(`
        SELECT t.severity, COUNT(*) AS count
        FROM threats t
        JOIN org_brands ob ON ob.brand_id = t.target_brand_id AND ob.org_id = ?
        WHERE ${whereClause}
        GROUP BY t.severity
      `).bind(...bindings).all();

      const typeBreakdown = await env.DB.prepare(`
        SELECT t.threat_type, COUNT(*) AS count
        FROM threats t
        JOIN org_brands ob ON ob.brand_id = t.target_brand_id AND ob.org_id = ?
        WHERE ${whereClause}
        GROUP BY t.threat_type
      `).bind(...bindings).all();

      return {
        data: threatsResult.results || [],
        total: countResult?.total ?? 0,
        severity_breakdown: severityBreakdown.results || [],
        type_breakdown: typeBreakdown.results || [],
      };
    };

    // Cache only the default shape (no filters, page 1, default sort).
    const isDefaultPage =
      !status && !severity && !threatType && !brandId && !country && !q &&
      offset === 0 && limit === 50 && sortParam === "severity" && dir === "DESC";
    const result = isDefaultPage
      ? await cachedValue(env, `tenant.threats.${orgId}`, 90, compute)
      : await compute();

    return json({
      success: true,
      data: result.data,
      total: result.total,
      severity_breakdown: result.severity_breakdown,
      type_breakdown: result.type_breakdown,
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/orgs/:orgId/threats/:threatId ──────────────────
//
// Single threat record — the enrichment/infrastructure backing for a
// threat-sourced signal's Intelligence Card (DNS/WHOIS/certs +
// reputation evidence). Same curated columns as the list, org-scoped
// through org_brands. The Card calls this only when an alert carries
// source_type='threat'.
export async function handleTenantThreatDetail(
  request: Request,
  env: Env,
  orgId: string,
  threatId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    const threat = await env.DB.prepare(`
      SELECT t.id, t.threat_type, t.malicious_domain, t.malicious_url,
             t.target_brand_id, t.source_feed, t.severity, t.status,
             t.confidence_score, t.country_code, t.ip_address,
             t.asn, t.registrar, t.registration_date,
             t.campaign_id, t.cluster_id, t.saas_technique_id,
             t.vt_checked, t.vt_malicious, t.vt_reputation,
             t.gsb_checked, t.gsb_flagged, t.gsb_threat_type,
             t.surbl_checked, t.surbl_listed,
             t.greynoise_checked, t.greynoise_classification,
             t.seclookup_checked, t.seclookup_risk_score,
             t.abuseipdb_checked, t.abuseipdb_score, t.abuseipdb_reports,
             t.first_seen, t.last_seen,
             hp.name AS hosting_provider, st.name AS saas_technique_name,
             b.name AS brand_name, b.canonical_domain AS brand_domain
      FROM threats t
      JOIN org_brands ob ON ob.brand_id = t.target_brand_id AND ob.org_id = ?
      JOIN brands b ON b.id = t.target_brand_id
      LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
      LEFT JOIN saas_techniques st ON st.id = t.saas_technique_id
      WHERE t.id = ?
    `).bind(orgId, threatId).first<Record<string, unknown>>();

    if (!threat) {
      return json({ success: false, error: "Threat not found" }, 404, origin);
    }

    return json({ success: true, data: threat }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── PATCH /api/orgs/:orgId/alerts/:alertId ──────────────────

export async function handleTenantUpdateAlert(
  request: Request,
  env: Env,
  orgId: string,
  alertId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  // Require analyst+ org role for HITL actions
  if (!canPerformHITL(ctx)) {
    return json({ success: false, error: "Requires org role: analyst or higher" }, 403, origin);
  }

  try {
    const body = await request.json() as { status?: string; notes?: string; assigned_to?: string | null };
    const hasStatus = typeof body.status === "string";
    const hasAssignee = Object.prototype.hasOwnProperty.call(body, "assigned_to");

    if (!hasStatus && !hasAssignee) {
      return json({ success: false, error: "Provide a status and/or an assignee" }, 400, origin);
    }

    const validStatuses = ["acknowledged", "investigating", "resolved", "false_positive"];
    if (hasStatus && !validStatuses.includes(body.status as string)) {
      return json({ success: false, error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` }, 400, origin);
    }

    // Verify alert belongs to an org brand
    const alert = await env.DB.prepare(`
      SELECT a.id, a.status AS current_status
      FROM alerts a
      JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
      WHERE a.id = ?
    `).bind(orgId, alertId).first<{ id: string; current_status: string }>();

    if (!alert) {
      return json({ success: false, error: "Alert not found or not accessible" }, 404, origin);
    }

    // Validate the assignee (when assigning to a user, not unassigning) — must
    // be an active member of this org.
    if (hasAssignee && body.assigned_to != null) {
      const member = await env.DB.prepare(
        "SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ? AND status = 'active'",
      ).bind(orgId, body.assigned_to).first();
      if (!member) {
        return json({ success: false, error: "Assignee must be an active member of this organization" }, 400, origin);
      }
    }

    // Update alert
    const now = new Date().toISOString();
    const updates: string[] = ["updated_at = ?"];
    const updateBindings: unknown[] = [now];

    if (hasStatus) {
      updates.push("status = ?");
      updateBindings.push(body.status);
      if (body.status === "acknowledged") {
        updates.push("acknowledged_at = ?");
        updateBindings.push(now);
      } else if (body.status === "resolved" || body.status === "false_positive") {
        updates.push("resolved_at = ?");
        updateBindings.push(now);
        if (body.notes) {
          updates.push("resolution_notes = ?");
          updateBindings.push(body.notes);
        }
      }
    }

    if (hasAssignee) {
      updates.push("assigned_to = ?");
      updateBindings.push(body.assigned_to ?? null);
      updates.push("assigned_at = ?");
      updateBindings.push(body.assigned_to ? now : null);
    }

    await env.DB.prepare(`
      UPDATE alerts SET ${updates.join(", ")} WHERE id = ?
    `).bind(...updateBindings, alertId).run();

    // Audit trail
    await audit(env, {
      action: "tenant_alert_update",
      userId: ctx.userId,
      resourceType: "alert",
      resourceId: alertId,
      details: {
        org_id: orgId,
        org_role: ctx.orgRole,
        previous_status: alert.current_status,
        new_status: hasStatus ? body.status : null,
        notes: body.notes ?? null,
        assigned_to: hasAssignee ? (body.assigned_to ?? null) : undefined,
      },
      outcome: "success",
      request,
    });

    // Fire webhook only when the status actually changed.
    if (hasStatus) {
      emitOrgEvent(env, Number(orgId), "alert.status_changed", {
        alert_id: alertId,
        previous_status: alert.current_status,
        new_status: body.status,
        updated_by: ctx.userId,
        notes: body.notes ?? null,
      }).catch(() => {});
    }

    const message = hasStatus
      ? `Alert ${body.status}`
      : (body.assigned_to ? "Alert assigned" : "Alert unassigned");
    return json({ success: true, message }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/orgs/:orgId/alerts/bulk ───────────────────────
//
// Bulk triage: apply a status transition and/or an assignee to many signals
// in one request (TENANT_ANALYST_UX_RESEARCH_2026-06 #12). Analyst+. Only
// alerts that belong to the org's brands are touched; the rest are silently
// skipped. One UPDATE, one audit row.
export async function handleTenantBulkUpdateAlerts(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);
  if (!canPerformHITL(ctx)) {
    return json({ success: false, error: "Requires org role: analyst or higher" }, 403, origin);
  }

  try {
    const body = await request.json() as { alert_ids?: unknown; status?: string; notes?: string; assigned_to?: string | null };
    const ids = Array.isArray(body.alert_ids)
      ? body.alert_ids.filter((x): x is string => typeof x === "string")
      : [];
    if (ids.length === 0) return json({ success: false, error: "alert_ids required" }, 400, origin);
    if (ids.length > 200) return json({ success: false, error: "Too many alerts (max 200 per call)" }, 400, origin);

    const hasStatus = typeof body.status === "string";
    const hasAssignee = Object.prototype.hasOwnProperty.call(body, "assigned_to");
    if (!hasStatus && !hasAssignee) {
      return json({ success: false, error: "Provide a status and/or an assignee" }, 400, origin);
    }
    const validStatuses = ["acknowledged", "investigating", "resolved", "false_positive"];
    if (hasStatus && !validStatuses.includes(body.status as string)) {
      return json({ success: false, error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` }, 400, origin);
    }
    if (hasAssignee && body.assigned_to != null) {
      const member = await env.DB.prepare(
        "SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ? AND status = 'active'",
      ).bind(orgId, body.assigned_to).first();
      if (!member) {
        return json({ success: false, error: "Assignee must be an active member of this organization" }, 400, origin);
      }
    }

    // Restrict to alerts actually owned by this org.
    const ph = ids.map(() => "?").join(",");
    const owned = await env.DB.prepare(`
      SELECT a.id FROM alerts a
      JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
      WHERE a.id IN (${ph})
    `).bind(orgId, ...ids).all<{ id: string }>();
    const ownedIds = (owned.results ?? []).map((r) => r.id);
    if (ownedIds.length === 0) {
      return json({ success: true, data: { updated: 0 } }, 200, origin);
    }

    const now = new Date().toISOString();
    const updates: string[] = ["updated_at = ?"];
    const binds: unknown[] = [now];
    if (hasStatus) {
      updates.push("status = ?");
      binds.push(body.status);
      if (body.status === "acknowledged") {
        updates.push("acknowledged_at = ?");
        binds.push(now);
      } else if (body.status === "resolved" || body.status === "false_positive") {
        updates.push("resolved_at = ?");
        binds.push(now);
        if (body.notes) {
          updates.push("resolution_notes = ?");
          binds.push(body.notes);
        }
      }
    }
    if (hasAssignee) {
      updates.push("assigned_to = ?");
      binds.push(body.assigned_to ?? null);
      updates.push("assigned_at = ?");
      binds.push(body.assigned_to ? now : null);
    }

    const oph = ownedIds.map(() => "?").join(",");
    await env.DB.prepare(`
      UPDATE alerts SET ${updates.join(", ")} WHERE id IN (${oph})
    `).bind(...binds, ...ownedIds).run();

    await audit(env, {
      action: "tenant_alert_bulk_update",
      userId: ctx.userId,
      resourceType: "alert",
      details: {
        org_id: orgId,
        org_role: ctx.orgRole,
        count: ownedIds.length,
        new_status: hasStatus ? body.status : null,
        assigned_to: hasAssignee ? (body.assigned_to ?? null) : undefined,
      },
      outcome: "success",
      request,
    });

    return json({ success: true, data: { updated: ownedIds.length } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/orgs/:orgId/brands/:brandId ────────────────────

export async function handleTenantBrandDetail(
  request: Request,
  env: Env,
  orgId: string,
  brandId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    // Get brand (only if assigned to org)
    const brand = await env.DB.prepare(`
      SELECT b.*, ob.is_primary, ob.monitoring_config_json
      FROM brands b
      JOIN org_brands ob ON ob.brand_id = b.id AND ob.org_id = ?
      WHERE b.id = ?
    `).bind(orgId, brandId).first();

    if (!brand) {
      return json({ success: false, error: "Brand not found or not assigned to your organization" }, 404, origin);
    }

    // Active threats (top 5)
    const threatsResult = await env.DB.prepare(`
      SELECT id, threat_type, malicious_domain, malicious_url, status, severity, confidence_score, first_seen, last_seen
      FROM threats
      WHERE target_brand_id = ? AND status = 'active'
      ORDER BY
        CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        last_seen DESC
      LIMIT 5
    `).bind(brandId).all();

    const activeThreatsCount = await env.DB.prepare(`
      SELECT COUNT(*) AS cnt FROM threats WHERE target_brand_id = ? AND status = 'active'
    `).bind(brandId).first<{ cnt: number }>();

    // Social profiles
    const socialResult = await env.DB.prepare(`
      SELECT id, platform, handle, display_name, classification, confidence_score, status, last_scanned
      FROM social_profiles
      WHERE brand_id = ? AND status = 'active'
      ORDER BY classification DESC, confidence_score DESC
    `).bind(brandId).all();

    // Recent alerts for this brand
    const alertsResult = await env.DB.prepare(`
      SELECT id, title, severity, alert_type, status, created_at, summary
      FROM alerts
      WHERE brand_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).bind(brandId).all();

    return json({
      success: true,
      data: {
        brand,
        active_threats_count: activeThreatsCount?.cnt ?? 0,
        top_threats: threatsResult.results || [],
        social_profiles: socialResult.results || [],
        recent_alerts: alertsResult.results || [],
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/orgs/:orgId/brands/:brandId/threats ────────────

export async function handleTenantBrandThreats(
  request: Request,
  env: Env,
  orgId: string,
  brandId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    // Verify brand belongs to org
    const orgBrand = await env.DB.prepare(
      "SELECT 1 FROM org_brands WHERE org_id = ? AND brand_id = ?"
    ).bind(orgId, brandId).first();

    if (!orgBrand) {
      return json({ success: false, error: "Brand not assigned to your organization" }, 404, origin);
    }

    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 100);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    let statusFilter = "";
    const bindings: unknown[] = [brandId];
    if (status) {
      statusFilter = " AND status = ?";
      bindings.push(status);
    }

    const threats = await env.DB.prepare(`
      SELECT * FROM threats
      WHERE target_brand_id = ?${statusFilter}
      ORDER BY
        CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        last_seen DESC
      LIMIT ? OFFSET ?
    `).bind(...bindings, limit, offset).all();

    const countResult = await env.DB.prepare(`
      SELECT COUNT(*) AS total FROM threats WHERE target_brand_id = ?${statusFilter}
    `).bind(...bindings).first<{ total: number }>();

    return json({
      success: true,
      data: threats.results || [],
      total: countResult?.total ?? 0,
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/orgs/:orgId/brands/:brandId/social-profiles ────

export async function handleTenantBrandSocialProfiles(
  request: Request,
  env: Env,
  orgId: string,
  brandId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    // Verify brand belongs to org
    const orgBrand = await env.DB.prepare(
      "SELECT 1 FROM org_brands WHERE org_id = ? AND brand_id = ?"
    ).bind(orgId, brandId).first();

    if (!orgBrand) {
      return json({ success: false, error: "Brand not assigned to your organization" }, 404, origin);
    }

    const profiles = await env.DB.prepare(`
      SELECT id, platform, handle, display_name, url, classification,
             confidence_score, status, follower_count, post_count,
             account_created_at, last_scanned, notes
      FROM social_profiles
      WHERE brand_id = ?
      ORDER BY
        CASE classification WHEN 'impersonation' THEN 1 WHEN 'suspicious' THEN 2 WHEN 'parody' THEN 3 ELSE 4 END,
        confidence_score DESC
    `).bind(brandId).all();

    return json({
      success: true,
      data: profiles.results || [],
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/orgs/:orgId/brands/:brandId/monitoring-config ──

const DEFAULT_MONITORING_CONFIG = {
  alert_severity_filter: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
  auto_acknowledge_low_days: 0,
  social_platforms_monitored: ["twitter", "linkedin", "instagram"],
  email_notifications: true,
  email_notification_threshold: "HIGH",
  weekly_digest: false,
  custom_keywords: [] as string[],
  excluded_domains: [] as string[],
};

export async function handleGetMonitoringConfig(
  request: Request,
  env: Env,
  orgId: string,
  brandId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    const row = await env.DB.prepare(
      "SELECT monitoring_config_json FROM org_brands WHERE org_id = ? AND brand_id = ?"
    ).bind(orgId, brandId).first<{ monitoring_config_json: string | null }>();

    if (!row) {
      return json({ success: false, error: "Brand not assigned to your organization" }, 404, origin);
    }

    let config = { ...DEFAULT_MONITORING_CONFIG };
    if (row.monitoring_config_json) {
      try {
        config = { ...config, ...JSON.parse(row.monitoring_config_json) };
      } catch { /* use defaults */ }
    }

    return json({ success: true, data: config }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── PATCH /api/orgs/:orgId/brands/:brandId/monitoring-config

export async function handleUpdateMonitoringConfig(
  request: Request,
  env: Env,
  orgId: string,
  brandId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  if (!canPerformHITL(ctx)) {
    return json({ success: false, error: "Requires org role: analyst or higher" }, 403, origin);
  }

  try {
    const body = await request.json() as MonitoringConfigBody;

    // Verify brand belongs to org
    const row = await env.DB.prepare(
      "SELECT monitoring_config_json FROM org_brands WHERE org_id = ? AND brand_id = ?"
    ).bind(orgId, brandId).first<{ monitoring_config_json: string | null }>();

    if (!row) {
      return json({ success: false, error: "Brand not assigned to your organization" }, 404, origin);
    }

    // Merge existing config with updates
    let existing = { ...DEFAULT_MONITORING_CONFIG };
    if (row.monitoring_config_json) {
      try {
        existing = { ...existing, ...JSON.parse(row.monitoring_config_json) };
      } catch { /* use defaults */ }
    }

    const updated = { ...existing };
    if (body.alert_severity_filter) updated.alert_severity_filter = body.alert_severity_filter;
    if (body.auto_acknowledge_low_days != null) updated.auto_acknowledge_low_days = body.auto_acknowledge_low_days;
    if (body.social_platforms_monitored) updated.social_platforms_monitored = body.social_platforms_monitored;
    if (body.email_notifications != null) updated.email_notifications = body.email_notifications;
    if (body.email_notification_threshold) updated.email_notification_threshold = body.email_notification_threshold;
    if (body.weekly_digest != null) updated.weekly_digest = body.weekly_digest;
    if (body.custom_keywords) updated.custom_keywords = body.custom_keywords;
    if (body.excluded_domains) updated.excluded_domains = body.excluded_domains;

    await env.DB.prepare(
      "UPDATE org_brands SET monitoring_config_json = ? WHERE org_id = ? AND brand_id = ?"
    ).bind(JSON.stringify(updated), orgId, brandId).run();

    await audit(env, {
      action: "monitoring_config_update",
      userId: ctx.userId,
      resourceType: "org_brand",
      resourceId: `${orgId}:${brandId}`,
      details: { org_id: orgId, brand_id: brandId },
      outcome: "success",
      request,
    });

    return json({ success: true, data: updated, message: "Monitoring config saved" }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
