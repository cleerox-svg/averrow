// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Tenant Data Endpoints (org-scoped, data-isolated)

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import { deliverWebhook } from "../lib/webhooks";
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
             COALESCE(t_active.cnt, 0) AS active_threats,
             COALESCE(sp_all.cnt, 0) AS social_profiles_count,
             COALESCE(sp_imp.cnt, 0) AS impersonation_count
      FROM org_brands ob
      JOIN brands b ON b.id = ob.brand_id
      LEFT JOIN (SELECT target_brand_id, COUNT(*) AS cnt FROM threats WHERE status = 'active' GROUP BY target_brand_id) t_active ON t_active.target_brand_id = b.id
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

    // Recent alerts (last 5)
    const recentAlertsResult = await env.DB.prepare(`
      SELECT a.id, a.title, a.severity, a.alert_type, a.status, a.created_at,
             b.name AS brand_name
      FROM alerts a
      JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
      JOIN brands b ON b.id = a.brand_id
      WHERE a.status IN ('new', 'acknowledged', 'investigating')
      ORDER BY a.created_at DESC
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

    return json({
      success: true,
      data: alertsResult.results || [],
      total: countResult?.total ?? 0,
      severity_breakdown: severityBreakdown.results || [],
    }, 200, origin);
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
    const body = await request.json() as { status?: string; notes?: string };

    if (!body.status) {
      return json({ success: false, error: "Missing required field: status" }, 400, origin);
    }

    const validStatuses = ["acknowledged", "investigating", "resolved", "false_positive"];
    if (!validStatuses.includes(body.status)) {
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

    // Update alert
    const now = new Date().toISOString();
    const updates: string[] = ["status = ?", "updated_at = ?"];
    const updateBindings: unknown[] = [body.status, now];

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
        new_status: body.status,
        notes: body.notes ?? null,
      },
      outcome: "success",
      request,
    });

    // Fire webhook: alert.status_changed
    deliverWebhook(env, Number(orgId), "alert.status_changed", {
      alert_id: alertId,
      previous_status: alert.current_status,
      new_status: body.status,
      updated_by: ctx.userId,
      notes: body.notes ?? null,
    }).catch(() => {});

    return json({ success: true, message: `Alert ${body.status}` }, 200, origin);
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
