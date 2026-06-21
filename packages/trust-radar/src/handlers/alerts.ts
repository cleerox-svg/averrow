/**
 * Unified Alerts API handlers.
 *
 * Endpoints:
 *   GET    /api/alerts             — list alerts (filtered, paginated, with brand join)
 *   GET    /api/alerts/stats       — severity/status breakdown
 *   GET    /api/alerts/:id         — single alert detail
 *   PATCH  /api/alerts/:id         — update status (acknowledge, resolve, etc.)
 *   POST   /api/alerts/bulk-acknowledge — bulk acknowledge alerts
 *   POST   /api/alerts/bulk-takedown    — bulk create takedown requests from alerts
 */

import { json } from "../lib/cors";
import { getAlerts, updateAlertStatus } from "../lib/alerts";
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import type { AlertStatus, Severity } from "../lib/alerts";
import type { Env } from "../types";
import type { OrgScope } from "../middleware/auth";

// GET /api/alerts
export async function handleListAlerts(request: Request, env: Env, userId: string, scope?: OrgScope | null): Promise<Response> {
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

    // Build WHERE clause
    let where = `WHERE a.user_id = ?`;
    const params: unknown[] = [userId];

    // Org scope filtering — only show alerts for org brands
    if (scope) {
      if (scope.brand_ids.length === 0) {
        return json({ success: true, data: [], total: 0 }, 200, origin);
      }
      const placeholders = scope.brand_ids.map(() => "?").join(", ");
      where += ` AND a.brand_id IN (${placeholders})`;
      params.push(...scope.brand_ids);
    }

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
           CASE a.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
                           WHEN 'MEDIUM' THEN 3 ELSE 4 END,
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
           CASE a.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
                           WHEN 'MEDIUM' THEN 3 ELSE 4 END,
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

/**
 * Ownership predicate shared by the by-id handlers (H2, 2026-06-10
 * audit). Mirrors handleListAlerts: alerts are owned per-user
 * (a.user_id = ?) and, for org-scoped callers, restricted to the
 * org's brand_ids. Returns null when the scope's brand list is empty
 * (caller should 404 — same outcome as the list returning []).
 */
function buildAlertOwnershipWhere(
  userId: string,
  scope?: OrgScope | null,
): { where: string; params: unknown[] } | null {
  let where = `a.user_id = ?`;
  const params: unknown[] = [userId];
  if (scope) {
    if (scope.brand_ids.length === 0) return null;
    const placeholders = scope.brand_ids.map(() => "?").join(", ");
    where += ` AND a.brand_id IN (${placeholders})`;
    params.push(...scope.brand_ids);
  }
  return { where, params };
}

// GET /api/alerts/:id
export async function handleGetAlert(request: Request, env: Env, alertId: string, userId: string, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const ownership = buildAlertOwnershipWhere(userId, scope);
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

    // H2: verify the caller owns the alert (same predicate as the list)
    // before mutating. updateAlertStatus itself stays id-keyed.
    const ownership = buildAlertOwnershipWhere(userId, scope);
    if (!ownership) {
      return json({ success: false, error: "Alert not found" }, 404, origin);
    }
    const owned = await env.DB.prepare(
      `SELECT a.id FROM alerts a WHERE a.id = ? AND ${ownership.where}`
    ).bind(alertId, ...ownership.params).first<{ id: string }>();
    if (!owned) {
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
export async function handleAlertStats(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const tally = newTally();
    const stats = await env.DB.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) as new_count,
        SUM(CASE WHEN status='acknowledged' THEN 1 ELSE 0 END) as acknowledged,
        SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN status='false_positive' THEN 1 ELSE 0 END) as dismissed,
        SUM(CASE WHEN status='false_positive' AND resolution_notes LIKE 'auto%' THEN 1 ELSE 0 END) as auto_dismissed,
        SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN severity='high' THEN 1 ELSE 0 END) as high,
        SUM(CASE WHEN severity='medium' THEN 1 ELSE 0 END) as medium,
        SUM(CASE WHEN severity='low' THEN 1 ELSE 0 END) as low
       FROM alerts WHERE user_id = ?`
    ).bind(userId).first<Record<string, number>>();
    tally.queries += 1;

    const byBrand = await env.DB.prepare(
      `SELECT a.brand_id, b.name as brand_name, b.canonical_domain as brand_domain,
              COUNT(*) as alert_count,
              SUM(CASE WHEN a.status='new' THEN 1 ELSE 0 END) as new_count
       FROM alerts a
       LEFT JOIN brands b ON b.id = a.brand_id
       WHERE a.user_id = ?
       GROUP BY a.brand_id
       ORDER BY alert_count DESC`
    ).bind(userId).all();
    addToTally(tally, byBrand.meta);

    recordD1Reads(env, "alerts_stats", tally);
    return json({
      success: true,
      data: {
        total: stats?.total ?? 0,
        new_count: stats?.new_count ?? 0,
        acknowledged: stats?.acknowledged ?? 0,
        resolved: stats?.resolved ?? 0,
        dismissed: stats?.dismissed ?? 0,
        critical: stats?.critical ?? 0,
        high: stats?.high ?? 0,
        medium: stats?.medium ?? 0,
        low: stats?.low ?? 0,
        by_brand: byBrand.results,
      },
    }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/alerts/bulk-acknowledge
export async function handleBulkAcknowledge(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { alert_ids?: string[]; brand_id?: string };

    if (body.brand_id) {
      // Acknowledge all new alerts for a brand
      const result = await env.DB.prepare(
        `UPDATE alerts SET status='acknowledged', acknowledged_at=datetime('now'), updated_at=datetime('now')
         WHERE brand_id = ? AND user_id = ? AND status='new'`
      ).bind(body.brand_id, userId).run();
      return json({ success: true, data: { updated: result.meta.changes ?? 0 } }, 200, origin);
    }

    if (!body.alert_ids || body.alert_ids.length === 0) {
      return json({ success: false, error: "Missing alert_ids or brand_id" }, 400, origin);
    }

    // Bulk acknowledge by IDs
    const placeholders = body.alert_ids.map(() => '?').join(',');
    const result = await env.DB.prepare(
      `UPDATE alerts SET status='acknowledged', acknowledged_at=datetime('now'), updated_at=datetime('now')
       WHERE id IN (${placeholders}) AND user_id = ? AND status='new'`
    ).bind(...body.alert_ids, userId).run();

    return json({ success: true, data: { updated: result.meta.changes ?? 0 } }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/alerts/bulk-takedown
export async function handleBulkTakedown(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { alert_ids?: string[]; brand_id?: string };

    // Resolve which alerts to process
    let alerts: { id: string; brand_id: string; title: string; summary: string; severity: string; source_id: string | null; brand_name: string | null; brand_domain: string | null }[];

    if (body.brand_id) {
      const rows = await env.DB.prepare(
        `SELECT a.id, a.brand_id, a.title, a.summary, a.severity, a.source_id,
                b.name as brand_name, b.canonical_domain as brand_domain
         FROM alerts a
         LEFT JOIN brands b ON b.id = a.brand_id
         WHERE a.brand_id = ? AND a.user_id = ? AND a.status IN ('new','acknowledged')`
      ).bind(body.brand_id, userId).all();
      alerts = rows.results as typeof alerts;
    } else if (body.alert_ids && body.alert_ids.length > 0) {
      const placeholders = body.alert_ids.map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT a.id, a.brand_id, a.title, a.summary, a.severity, a.source_id,
                b.name as brand_name, b.canonical_domain as brand_domain
         FROM alerts a
         LEFT JOIN brands b ON b.id = a.brand_id
         WHERE a.id IN (${placeholders}) AND a.user_id = ?`
      ).bind(...body.alert_ids, userId).all();
      alerts = rows.results as typeof alerts;
    } else {
      return json({ success: false, error: "Missing alert_ids or brand_id" }, 400, origin);
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

    return json({ success: true, data: { takedowns_created: created, alerts_acknowledged: alertIds.length } }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/alerts/triage-summary ─────────────────────────────────
//
// Lightweight count for the bell-dropdown "X alerts need triage" row.
// Q-D from the audit pinned the count to status='new' only — fresh
// things to look at, not the full open workload.
//
// Two counts:
//   new_count       — total alerts with status='new'
//   critical_count  — alerts with status='new' AND severity='critical'
//                     (drives the red dot indicator on the row)
//
// Cached in KV for 60s per user. Bell polls this on every dropdown
// open; the cache prevents bursts when the operator clicks around.
export async function handleAlertTriageSummary(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const cacheKey = `alerts_triage:${userId}`;

  try {
    // KV cache check — record an empty tally so cache hits still
    // surface as request volume in attribution.
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "alerts_triage", newTally());
      return json({ success: true, data: JSON.parse(cached) }, 200, origin);
    }

    // Single SQL with conditional aggregates — one round-trip vs two.
    const tally = newTally();
    const row = await env.DB.prepare(
      `SELECT
         COUNT(*) AS new_count,
         SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical_count
       FROM alerts
       WHERE user_id = ? AND status = 'new'`,
    ).bind(userId).first<{ new_count: number; critical_count: number }>();
    tally.queries += 1;

    const data = {
      new_count: row?.new_count ?? 0,
      critical_count: row?.critical_count ?? 0,
    };

    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 60 });
    recordD1Reads(env, "alerts_triage", tally);
    return json({ success: true, data }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
