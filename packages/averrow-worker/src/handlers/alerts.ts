/**
 * Unified Alerts API handlers (ops / staff surface).
 *
 * Endpoints:
 *   GET    /api/alerts             — list alerts (filtered, paginated, with brand join)
 *   GET    /api/alerts/stats       — severity/status breakdown
 *   GET    /api/alerts/triage-summary — bell-row counts + the top `new` alert
 *   GET    /api/alerts/:id         — single alert detail
 *   PATCH  /api/alerts/:id         — update status / assignment
 *   POST   /api/alerts/bulk-acknowledge — bulk acknowledge alerts
 *   POST   /api/alerts/bulk-takedown    — bulk create takedown requests from alerts
 *
 * PR-C (owner decision 2026-10-04): ops alerts are PLATFORM-WIDE for staff.
 * Alert rows carry the `user_id` of the tenant org member they were fanned
 * out to (lib/alert-fanout.ts), so the former `a.user_id = ?` pin meant staff
 * saw ~nothing. The only filter left is the org-scope brand filter
 * (`alertScopeFilter`): every staff role gets a null scope from getOrgScope
 * (isPlatformStaff, PR-F) and therefore sees every alert. Reads are gated by
 * requireStaff; mutations by requirePermission('edit_alerts') in
 * routes/dashboard.ts. Tenant alerts (/api/orgs/:orgId/alerts,
 * handlers/tenantData.ts) are unaffected.
 */

import { json } from "../lib/cors";
import { updateAlertStatus } from "../lib/alerts";
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import { audit } from "../lib/audit";
import { scopeCacheSegment, GLOBAL_SCOPE_SEGMENT } from "../lib/scope-cache-key";
import type { AlertStatus, Severity } from "../lib/alerts";
import type { Env } from "../types";
import type { OrgScope } from "../middleware/auth";

/**
 * Severity rank for ORDER BY. Severities are lowercase since migration 0120
 * (and CHECK-constrained lowercase since 0121); LOWER() keeps the rank right
 * for any straggler. Unknown values sort last.
 */
const SEVERITY_RANK_SQL = `CASE LOWER(a.severity)
             WHEN 'critical' THEN 1 WHEN 'high' THEN 2
             WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END`;

/**
 * Org-scope brand filter shared by every staff alert handler.
 *   - null/undefined scope (every staff role) → no filter: all alerts
 *   - scope with brand_ids                     → `a.brand_id IN (...)`
 *   - scope with no brands                     → null: caller answers empty / 404
 * Clients never reach these requireStaff routes; the scoped branch keeps the
 * handlers correct if one ever did.
 */
function alertScopeFilter(scope?: OrgScope | null): { where: string; params: unknown[] } | null {
  if (!scope) return { where: "1 = 1", params: [] };
  if (scope.brand_ids.length === 0) return null;
  const placeholders = scope.brand_ids.map(() => "?").join(", ");
  return { where: `a.brand_id IN (${placeholders})`, params: [...scope.brand_ids] };
}

const TRIAGE_CACHE_PREFIX = "alerts_triage:";
const STATS_CACHE_PREFIX = "alerts_stats:";
const ALERT_CACHE_TTL_SECONDS = 60;

/**
 * Drop the cached triage summary + stats for the caller's scope and for the
 * `global` segment (the one every staff caller reads), so the bell count and
 * stat tiles drop right after a mutation instead of up to 60s later.
 */
async function invalidateAlertCaches(env: Env, scope?: OrgScope | null): Promise<void> {
  const segments = new Set<string>([GLOBAL_SCOPE_SEGMENT, await scopeCacheSegment(scope)]);
  const deletes: Promise<void>[] = [];
  for (const seg of segments) {
    deletes.push(env.CACHE.delete(TRIAGE_CACHE_PREFIX + seg), env.CACHE.delete(STATS_CACHE_PREFIX + seg));
  }
  try {
    await Promise.all(deletes);
  } catch {
    /* KV failure: the 60s TTL still bounds staleness */
  }
}

/** Distinct, non-empty string ids from an untrusted body field (max 500). */
function parseAlertIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = Array.from(new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0)));
  return ids.length > 0 ? ids.slice(0, 500) : null;
}

// GET /api/alerts
export async function handleListAlerts(request: Request, env: Env, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") as AlertStatus | null;
    const severity = url.searchParams.get("severity") as Severity | null;
    const alertType = url.searchParams.get("alert_type");
    const brandId = url.searchParams.get("brand_id");
    const search = url.searchParams.get("search");
    const groupBy = url.searchParams.get("group_by");
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    // Build WHERE clause — platform-wide for staff (PR-C); org-scope brand
    // filter only when a scope is present.
    const scopeFilter = alertScopeFilter(scope);
    if (!scopeFilter) {
      return json({ success: true, data: [], total: 0 }, 200, origin);
    }
    let where = `WHERE ${scopeFilter.where}`;
    const params: unknown[] = [...scopeFilter.params];

    if (status) {
      where += ` AND a.status = ?`;
      params.push(status);
    }
    if (severity) {
      where += ` AND a.severity = ?`;
      params.push(severity);
    }
    if (alertType) {
      where += ` AND a.alert_type = ?`;
      params.push(alertType);
    }
    if (brandId) {
      where += ` AND a.brand_id = ?`;
      params.push(brandId);
    }
    if (search) {
      where += ` AND (a.title LIKE ? OR a.summary LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    const tally = newTally();

    // Count
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM alerts a ${where}`
    ).bind(...params).first<{ c: number }>();
    const total = countRow?.c ?? 0;
    // .first() doesn't expose meta — count the query without rows.
    tally.queries += 1;

    // Get paginated results with brand join + SaaS technique (joined via threat).
    // Wrapped in try/catch so alerts keep loading if the saas_techniques
    // migration has not been applied yet.
    let rows: D1Result;
    try {
      rows = await env.DB.prepare(
        `SELECT a.*, b.name as brand_name, b.canonical_domain as brand_domain,
                u.name  AS assigned_to_name,
                u.email AS assigned_to_email,
                st.id          AS saas_technique_id,
                st.name        AS saas_technique_name,
                st.phase       AS saas_technique_phase,
                st.phase_label AS saas_technique_phase_label,
                st.severity    AS saas_technique_severity
         FROM alerts a
         LEFT JOIN brands b ON b.id = a.brand_id
         LEFT JOIN users u ON u.id = a.assigned_to
         LEFT JOIN threats t
                ON t.id = a.source_id
               AND a.source_type = 'threat'
         LEFT JOIN saas_techniques st ON st.id = t.saas_technique_id
         ${where}
         ORDER BY
           ${SEVERITY_RANK_SQL},
           a.created_at DESC
         LIMIT ? OFFSET ?`
      ).bind(...params, Math.min(200, limit), offset).all();
      addToTally(tally, rows.meta);
    } catch {
      rows = await env.DB.prepare(
        `SELECT a.*, b.name as brand_name, b.canonical_domain as brand_domain,
                u.name  AS assigned_to_name,
                u.email AS assigned_to_email,
                NULL AS saas_technique_id,
                NULL AS saas_technique_name,
                NULL AS saas_technique_phase,
                NULL AS saas_technique_phase_label,
                NULL AS saas_technique_severity
         FROM alerts a
         LEFT JOIN brands b ON b.id = a.brand_id
         LEFT JOIN users u ON u.id = a.assigned_to
         ${where}
         ORDER BY
           ${SEVERITY_RANK_SQL},
           a.created_at DESC
         LIMIT ? OFFSET ?`
      ).bind(...params, Math.min(200, limit), offset).all();
      addToTally(tally, rows.meta);
    }

    recordD1Reads(env, "alerts_list", tally);
    return json({ success: true, data: rows.results, total }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/alerts/:id
export async function handleGetAlert(request: Request, env: Env, alertId: string, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const ownership = alertScopeFilter(scope);
    if (!ownership) {
      return json({ success: false, error: "Alert not found" }, 404, origin);
    }

    const row = await env.DB.prepare(
      `SELECT a.*, b.name as brand_name, b.canonical_domain as brand_domain
       FROM alerts a
       LEFT JOIN brands b ON b.id = a.brand_id
       WHERE a.id = ? AND ${ownership.where}`
    ).bind(alertId, ...ownership.params).first();

    if (!row) {
      return json({ success: false, error: "Alert not found" }, 404, origin);
    }

    return json({ success: true, data: row }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// PATCH /api/alerts/:id
export async function handleUpdateAlert(request: Request, env: Env, alertId: string, userId: string, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { status?: AlertStatus; notes?: string; assigned_to?: string | null };
    const hasAssignee = Object.prototype.hasOwnProperty.call(body, 'assigned_to');

    // A request must change at least one of status or assignment.
    if (!body.status && !hasAssignee) {
      return json({ success: false, error: "Missing field: status or assigned_to" }, 400, origin);
    }

    if (body.status) {
      const validStatuses: AlertStatus[] = ['new', 'acknowledged', 'investigating', 'resolved', 'false_positive'];
      if (!validStatuses.includes(body.status)) {
        return json({ success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, 400, origin);
      }
    }

    // Same scope predicate as the list (platform-wide for staff, PR-C).
    // Also reads the prior state for the audit trail. updateAlertStatus
    // itself stays id-keyed.
    const ownership = alertScopeFilter(scope);
    if (!ownership) {
      return json({ success: false, error: "Alert not found" }, 404, origin);
    }
    const prior = await env.DB.prepare(
      `SELECT a.id, a.status, a.assigned_to FROM alerts a WHERE a.id = ? AND ${ownership.where}`
    ).bind(alertId, ...ownership.params).first<{ id: string; status: string | null; assigned_to: string | null }>();
    if (!prior) {
      return json({ success: false, error: "Alert not found" }, 404, origin);
    }

    if (body.status) {
      const updated = await updateAlertStatus(env.DB, alertId, body.status, body.notes);
      if (!updated) {
        return json({ success: false, error: "Alert not found" }, 404, origin);
      }
    }

    // Assignment (W9 ownership). assigned_to is a users.id, or null to
    // unassign; assigned_at stamps when a claim was made.
    if (hasAssignee) {
      const assignee = body.assigned_to ? String(body.assigned_to) : null;
      await env.DB.prepare(
        `UPDATE alerts SET assigned_to = ?, assigned_at = ${assignee ? "datetime('now')" : 'NULL'}, updated_at = datetime('now') WHERE id = ?`
      ).bind(assignee, alertId).run();
    }

    await invalidateAlertCaches(env, scope);

    // Who-acted trail: alerts has no acknowledged_by / resolved_by columns,
    // so the actor is recorded in AUDIT_DB (same pattern as the tenant
    // tenant_alert_update audit in handlers/tenantData.ts).
    await audit(env, {
      action: "alert_update",
      userId,
      resourceType: "alert",
      resourceId: alertId,
      details: {
        previous_status: prior.status,
        new_status: body.status ?? null,
        notes: body.notes ?? null,
        ...(hasAssignee
          ? { previous_assigned_to: prior.assigned_to, assigned_to: body.assigned_to ?? null }
          : {}),
      },
      outcome: "success",
      request,
    });

    return json({ success: true }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/alerts/stats
//
// Severity comparisons are LOWERCASE (post-migration 0120). The
// previous version checked `severity='CRITICAL'` etc. which always
// returned 0 after the migration normalized rows to lowercase —
// the by-severity breakdown was silently broken.
//
// PR-C: platform-wide for staff, so the answer is identical for every staff
// caller — cached 60s per scope segment (`alerts_stats:global` for staff)
// and dropped by invalidateAlertCaches on any alert mutation.
export async function handleAlertStats(request: Request, env: Env, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const scopeFilter = alertScopeFilter(scope);
    const cacheKey = STATS_CACHE_PREFIX + (await scopeCacheSegment(scope));
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "alerts_stats", newTally());
      return json({ success: true, data: JSON.parse(cached) }, 200, origin);
    }

    const tally = newTally();
    let stats: Record<string, number> | null = null;
    let byBrand: unknown[] = [];
    if (scopeFilter) {
      stats = await env.DB.prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN a.status='new' THEN 1 ELSE 0 END) as new_count,
          SUM(CASE WHEN a.status='acknowledged' THEN 1 ELSE 0 END) as acknowledged,
          SUM(CASE WHEN a.status='resolved' THEN 1 ELSE 0 END) as resolved,
          SUM(CASE WHEN a.status='false_positive' THEN 1 ELSE 0 END) as dismissed,
          SUM(CASE WHEN a.status='false_positive' AND a.resolution_notes LIKE 'auto%' THEN 1 ELSE 0 END) as auto_dismissed,
          SUM(CASE WHEN a.severity='critical' THEN 1 ELSE 0 END) as critical,
          SUM(CASE WHEN a.severity='high' THEN 1 ELSE 0 END) as high,
          SUM(CASE WHEN a.severity='medium' THEN 1 ELSE 0 END) as medium,
          SUM(CASE WHEN a.severity='low' THEN 1 ELSE 0 END) as low
         FROM alerts a WHERE ${scopeFilter.where}`
      ).bind(...scopeFilter.params).first<Record<string, number>>();
      tally.queries += 1;

      const byBrandRes = await env.DB.prepare(
        `SELECT a.brand_id, b.name as brand_name, b.canonical_domain as brand_domain,
                COUNT(*) as alert_count,
                SUM(CASE WHEN a.status='new' THEN 1 ELSE 0 END) as new_count
         FROM alerts a
         LEFT JOIN brands b ON b.id = a.brand_id
         WHERE ${scopeFilter.where}
         GROUP BY a.brand_id
         ORDER BY alert_count DESC`
      ).bind(...scopeFilter.params).all();
      addToTally(tally, byBrandRes.meta);
      byBrand = byBrandRes.results;
    }

    const data = {
      total: stats?.total ?? 0,
      new_count: stats?.new_count ?? 0,
      acknowledged: stats?.acknowledged ?? 0,
      resolved: stats?.resolved ?? 0,
      dismissed: stats?.dismissed ?? 0,
      critical: stats?.critical ?? 0,
      high: stats?.high ?? 0,
      medium: stats?.medium ?? 0,
      low: stats?.low ?? 0,
      by_brand: byBrand,
    };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: ALERT_CACHE_TTL_SECONDS });
    recordD1Reads(env, "alerts_stats", tally);
    return json({ success: true, data }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/alerts/bulk-acknowledge
export async function handleBulkAcknowledge(request: Request, env: Env, userId: string, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { alert_ids?: unknown; brand_id?: unknown };
    const brandId = typeof body.brand_id === "string" && body.brand_id ? body.brand_id : null;
    const alertIds = brandId ? null : parseAlertIds(body.alert_ids);
    if (!brandId && !alertIds) {
      return json({ success: false, error: "Missing alert_ids or brand_id" }, 400, origin);
    }

    const scopeFilter = alertScopeFilter(scope);
    if (!scopeFilter) {
      return json({ success: true, data: { updated: 0 } }, 200, origin);
    }

    // Platform-wide for staff (PR-C): no user_id pin, only the scope filter.
    // `a` alias so the shared scope predicate applies unchanged.
    let target: string;
    let targetParams: unknown[];
    if (brandId) {
      target = `a.brand_id = ?`;
      targetParams = [brandId];
    } else {
      target = `a.id IN (${alertIds!.map(() => "?").join(",")})`;
      targetParams = alertIds!;
    }

    const result = await env.DB.prepare(
      `UPDATE alerts AS a SET status='acknowledged', acknowledged_at=datetime('now'), updated_at=datetime('now')
       WHERE ${target} AND ${scopeFilter.where} AND a.status='new'`
    ).bind(...targetParams, ...scopeFilter.params).run();
    const updated = result.meta.changes ?? 0;

    if (updated > 0) await invalidateAlertCaches(env, scope);
    await audit(env, {
      action: "alert_bulk_acknowledge",
      userId,
      resourceType: "alert",
      resourceId: brandId ? `brand:${brandId}` : undefined,
      details: { brand_id: brandId, alert_ids: alertIds, updated },
      outcome: "success",
      request,
    });

    return json({ success: true, data: { updated } }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/alerts/bulk-takedown
export async function handleBulkTakedown(request: Request, env: Env, userId: string, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { alert_ids?: unknown; brand_id?: unknown };
    const brandId = typeof body.brand_id === "string" && body.brand_id ? body.brand_id : null;
    const requestedIds = brandId ? null : parseAlertIds(body.alert_ids);
    if (!brandId && !requestedIds) {
      return json({ success: false, error: "Missing alert_ids or brand_id" }, 400, origin);
    }

    // Resolve which alerts to process — platform-wide for staff (PR-C).
    let alerts: { id: string; brand_id: string; title: string; summary: string; severity: string; source_id: string | null; brand_name: string | null; brand_domain: string | null }[] = [];
    const scopeFilter = alertScopeFilter(scope);

    if (scopeFilter && brandId) {
      const rows = await env.DB.prepare(
        `SELECT a.id, a.brand_id, a.title, a.summary, a.severity, a.source_id,
                b.name as brand_name, b.canonical_domain as brand_domain
         FROM alerts a
         LEFT JOIN brands b ON b.id = a.brand_id
         WHERE a.brand_id = ? AND ${scopeFilter.where} AND a.status IN ('new','acknowledged')`
      ).bind(brandId, ...scopeFilter.params).all();
      alerts = rows.results as typeof alerts;
    } else if (scopeFilter && requestedIds) {
      const placeholders = requestedIds.map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT a.id, a.brand_id, a.title, a.summary, a.severity, a.source_id,
                b.name as brand_name, b.canonical_domain as brand_domain
         FROM alerts a
         LEFT JOIN brands b ON b.id = a.brand_id
         WHERE a.id IN (${placeholders}) AND ${scopeFilter.where}`
      ).bind(...requestedIds, ...scopeFilter.params).all();
      alerts = rows.results as typeof alerts;
    }

    if (alerts.length === 0) {
      return json({ success: false, error: "No eligible alerts found" }, 404, origin);
    }

    // Create takedown requests for each alert
    let created = 0;
    for (const alert of alerts) {
      const takedownId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO takedown_requests (id, brand_id, target_type, target_value, target_platform, evidence_summary, severity, priority_score, source_type, status, created_at, updated_at)
         VALUES (?, ?, 'social_profile', ?, 'tiktok', ?, ?, 50, 'alert', 'draft', datetime('now'), datetime('now'))
         ON CONFLICT DO NOTHING`
      ).bind(
        takedownId,
        alert.brand_id,
        alert.title,
        alert.summary,
        alert.severity,
      ).run();
      created++;
    }

    // Acknowledge the alerts
    const alertIds = alerts.map(a => a.id);
    if (alertIds.length > 0) {
      const placeholders = alertIds.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE alerts SET status='acknowledged', acknowledged_at=datetime('now'), updated_at=datetime('now')
         WHERE id IN (${placeholders})`
      ).bind(...alertIds).run();
    }

    await invalidateAlertCaches(env, scope);
    await audit(env, {
      action: "alert_bulk_takedown",
      userId,
      resourceType: "alert",
      resourceId: brandId ? `brand:${brandId}` : undefined,
      details: { brand_id: brandId, alert_ids: alertIds, takedowns_created: created },
      outcome: "success",
      request,
    });

    return json({ success: true, data: { takedowns_created: created, alerts_acknowledged: alertIds.length } }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/alerts/triage-summary ─────────────────────────────────
//
// Bell-dropdown "X alerts need triage" row. Q-D from the audit pinned the
// count to status='new' only — fresh things to look at, not the full open
// workload. Platform-wide for staff (PR-C).
//
//   new_count       — alerts with status='new' in scope
//   critical_count  — status='new' AND severity='critical' (red dot). With the
//                     global scope this is the same predicate as
//                     /api/intel/critical-banner's open_critical_alerts count.
//   top             — the most severe, then newest, status='new' alert in
//                     scope (null when there are none)
//
// Cached in KV for 60s per scope segment (`alerts_triage:global` for every
// staff caller); any alert mutation drops it via invalidateAlertCaches.
export interface AlertTriageTop {
  id: string;
  title: string;
  severity: string;
  brand_id: string;
  brand_name: string | null;
  alert_type: string;
  created_at: string | null;
}

export interface AlertTriageSummary {
  new_count: number;
  critical_count: number;
  top: AlertTriageTop | null;
}

export async function handleAlertTriageSummary(
  request: Request,
  env: Env,
  scope?: OrgScope | null,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const cacheKey = TRIAGE_CACHE_PREFIX + (await scopeCacheSegment(scope));
    // KV cache check — record an empty tally so cache hits still
    // surface as request volume in attribution.
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "alerts_triage", newTally());
      return json({ success: true, data: JSON.parse(cached) }, 200, origin);
    }

    const tally = newTally();
    const data: AlertTriageSummary = { new_count: 0, critical_count: 0, top: null };
    const scopeFilter = alertScopeFilter(scope);
    if (scopeFilter) {
      const [counts, top] = await Promise.all([
        env.DB.prepare(
          `SELECT
             COUNT(*) AS new_count,
             SUM(CASE WHEN LOWER(a.severity) = 'critical' THEN 1 ELSE 0 END) AS critical_count
           FROM alerts a
           WHERE a.status = 'new' AND ${scopeFilter.where}`,
        ).bind(...scopeFilter.params).first<{ new_count: number; critical_count: number | null }>(),
        env.DB.prepare(
          `SELECT a.id, a.title, a.severity, a.brand_id, b.name AS brand_name,
                  a.alert_type, a.created_at
           FROM alerts a
           LEFT JOIN brands b ON b.id = a.brand_id
           WHERE a.status = 'new' AND ${scopeFilter.where}
           ORDER BY ${SEVERITY_RANK_SQL}, a.created_at DESC
           LIMIT 1`,
        ).bind(...scopeFilter.params).first<AlertTriageTop>(),
      ]);
      tally.queries += 2;
      data.new_count = counts?.new_count ?? 0;
      data.critical_count = counts?.critical_count ?? 0;
      data.top = top
        ? {
            id: top.id,
            title: top.title,
            severity: top.severity,
            brand_id: top.brand_id,
            brand_name: top.brand_name ?? null,
            alert_type: top.alert_type,
            created_at: top.created_at ?? null,
          }
        : null;
    }

    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: ALERT_CACHE_TTL_SECONDS });
    recordD1Reads(env, "alerts_triage", tally);
    return json({ success: true, data }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
