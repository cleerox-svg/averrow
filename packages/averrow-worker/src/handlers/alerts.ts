/**
 * Unified Alerts API handlers (ops / staff surface).
 *
 * Endpoints:
 *   GET    /api/alerts             — list alerts (filtered, paginated, with brand join)
 *   GET    /api/alerts/stats       — severity/status breakdown
 *   GET    /api/alerts/triage-summary — bell-row counts + the top `new` alert
 *   GET    /api/alerts/:id         — single alert detail
 *   PATCH  /api/alerts/:id         — update status / staff assignee / staff notes
 *   POST   /api/alerts/bulk-acknowledge — bulk acknowledge alerts (≤90 per call)
 *   POST   /api/alerts/bulk-takedown    — bulk create takedown requests (≤90 per call)
 *
 * PR-C (owner decision 2026-10-04): ops alerts are PLATFORM-WIDE for staff.
 * Alert rows carry the `user_id` of the tenant org member they were fanned
 * out to (lib/alert-fanout.ts), so the former `a.user_id = ?` pin meant staff
 * saw ~nothing. The only filter left is the org-scope filter
 * (`alertScopeFilter`): every staff role gets a null scope from getOrgScope
 * (isPlatformStaff, PR-F) and therefore sees every alert. Reads are gated by
 * requireStaff; mutations by requirePermission('edit_alerts') in
 * routes/dashboard.ts.
 *
 * Staff actions are visible to the customer, branded as Averrow (owner
 * decision 2026-10-04). Alerts are shared rows — the tenant app
 * (handlers/tenantData.ts) shows status, assigned_to and resolution_notes.
 *   - Status changes made here write the shared columns: the customer sees them.
 *   - Staff NEVER write `assigned_to` / `resolution_notes` (the customer's
 *     own assignee + notes). A staff claim goes to `staff_assigned_to`
 *     (validated: an active platform-staff user, or null) and staff notes to
 *     `staff_notes` (migration 0275). The tenant handlers strip every
 *     `staff_*` key and show "Averrow SOC" as the assignee when staff are
 *     handling the alert and the customer has no assignee of its own.
 */

import { json } from "../lib/cors";
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import { audit } from "../lib/audit";
import { scopeCacheSegment, GLOBAL_SCOPE_SEGMENT } from "../lib/scope-cache-key";
import { isPlatformStaff } from "../middleware/auth";
import { moduleKeyForTargetType } from "../lib/takedown-module-key";
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
 * Max alerts one bulk call touches, and max `alert_ids` it accepts. D1's
 * effective SQLITE_MAX_VARIABLE_NUMBER is 100 (see lib/dns-queue-reaper.ts);
 * 90 leaves head-room for the scope / LIMIT binds that ride along.
 * Brand-wide calls process at most this many and return `remaining` so the
 * UI can repeat.
 */
export const MAX_BULK_ALERTS = 90;

/** target_type every bulk-takedown draft is created with (see the KNOWN BUG
 *  note on handleBulkTakedown — it is not yet derived per alert type). */
const BULK_TAKEDOWN_TARGET_TYPE = "social_profile";

/** Staff note length cap (stored in alerts.staff_notes). */
export const MAX_STAFF_NOTES_LENGTH = 4000;

/** Notes are truncated to this length in audit rows. */
const AUDIT_NOTES_MAX = 500;

const VALID_STATUSES: AlertStatus[] = ["new", "acknowledged", "investigating", "resolved", "false_positive"];

/**
 * Org-scope filter shared by every staff alert handler.
 *   - null/undefined scope (every staff role) → no filter: all alerts
 *   - scope with brand_ids                     → the org's brands, and only
 *     brand-wide or that org's own org-private alerts (same predicate as
 *     the tenant routes, migration 0247)
 *   - scope with no brands                     → null: caller answers empty / 404
 * Clients never reach these requireStaff routes; the scoped branch keeps the
 * handlers correct (and no wider than the tenant view) if one ever did.
 */
function alertScopeFilter(scope?: OrgScope | null): { where: string; params: unknown[] } | null {
  if (!scope) return { where: "1 = 1", params: [] };
  if (scope.brand_ids.length === 0) return null;
  const placeholders = scope.brand_ids.map(() => "?").join(", ");
  return {
    where: `a.brand_id IN (${placeholders}) AND (a.org_id IS NULL OR a.org_id = ?)`,
    params: [...scope.brand_ids, scope.org_id],
  };
}

/**
 * SELECT + joins shared by the list and the detail. `a.*` includes the
 * staff columns (staff_assigned_to, staff_assigned_at, staff_notes —
 * migration 0275); the users joins resolve both the customer assignee and
 * the staff assignee. `withSaas=false` is the fallback for an environment
 * where the saas_techniques migration has not been applied.
 */
function staffAlertSelect(withSaas: boolean): string {
  const saasCols = withSaas
    ? `st.id          AS saas_technique_id,
                st.name        AS saas_technique_name,
                st.phase       AS saas_technique_phase,
                st.phase_label AS saas_technique_phase_label,
                st.severity    AS saas_technique_severity`
    : `NULL AS saas_technique_id,
                NULL AS saas_technique_name,
                NULL AS saas_technique_phase,
                NULL AS saas_technique_phase_label,
                NULL AS saas_technique_severity`;
  const saasJoins = withSaas
    ? `LEFT JOIN threats t
                ON t.id = a.source_id
               AND a.source_type = 'threat'
         LEFT JOIN saas_techniques st ON st.id = t.saas_technique_id`
    : "";
  return `SELECT a.*, b.name as brand_name, b.canonical_domain as brand_domain,
                u.name   AS assigned_to_name,
                u.email  AS assigned_to_email,
                su.name  AS staff_assigned_to_name,
                su.email AS staff_assigned_to_email,
                ${saasCols}
         FROM alerts a
         LEFT JOIN brands b ON b.id = a.brand_id
         LEFT JOIN users u ON u.id = a.assigned_to
         LEFT JOIN users su ON su.id = a.staff_assigned_to
         ${saasJoins}`;
}

const TRIAGE_CACHE_PREFIX = "alerts_triage:";
const STATS_CACHE_PREFIX = "alerts_stats:";
const ALERT_CACHE_TTL_SECONDS = 60;

/**
 * Drop the cached triage summary + stats for the caller's scope and for the
 * `global` segment (the one every staff caller reads), so the bell count and
 * stat tiles drop right after an ops mutation instead of up to 60s later.
 * Other alert writers (tenant actions, auto-triage, fan-out) don't call
 * this — the 60s TTL bounds staleness for those.
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

type AlertIdsParse =
  | { kind: "missing" }
  | { kind: "too_many"; count: number }
  | { kind: "ok"; ids: string[] };

/** Distinct, non-empty string ids from an untrusted body field (max MAX_BULK_ALERTS). */
function parseAlertIds(raw: unknown): AlertIdsParse {
  if (!Array.isArray(raw)) return { kind: "missing" };
  const ids = Array.from(new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0)));
  if (ids.length === 0) return { kind: "missing" };
  if (ids.length > MAX_BULK_ALERTS) return { kind: "too_many", count: ids.length };
  return { kind: "ok", ids };
}

function truncateForAudit(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.length > AUDIT_NOTES_MAX ? value.slice(0, AUDIT_NOTES_MAX) : value;
}

/** Shared body parsing for both bulk endpoints. */
function parseBulkTarget(body: { alert_ids?: unknown; brand_id?: unknown }):
  | { ok: true; brandId: string | null; alertIds: string[] | null }
  | { ok: false; error: string } {
  const brandId = typeof body.brand_id === "string" && body.brand_id ? body.brand_id : null;
  if (brandId) return { ok: true, brandId, alertIds: null };
  const parsed = parseAlertIds(body.alert_ids);
  if (parsed.kind === "missing") return { ok: false, error: "Missing alert_ids or brand_id" };
  if (parsed.kind === "too_many") {
    return { ok: false, error: `Too many alert_ids (${parsed.count}); at most ${MAX_BULK_ALERTS} per call` };
  }
  return { ok: true, brandId: null, alertIds: parsed.ids };
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
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    // Build WHERE clause — platform-wide for staff (PR-C); org-scope filter
    // only when a scope is present.
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

    // Paginated rows with brand + assignee joins + SaaS technique (joined via
    // threat). Falls back without the SaaS join if that migration is absent.
    const tail = `${where}
         ORDER BY
           ${SEVERITY_RANK_SQL},
           a.created_at DESC
         LIMIT ? OFFSET ?`;
    let rows: D1Result;
    try {
      rows = await env.DB.prepare(`${staffAlertSelect(true)} ${tail}`)
        .bind(...params, Math.min(200, limit), offset).all();
    } catch {
      rows = await env.DB.prepare(`${staffAlertSelect(false)} ${tail}`)
        .bind(...params, Math.min(200, limit), offset).all();
    }
    addToTally(tally, rows.meta);

    recordD1Reads(env, "alerts_list", tally);
    return json({ success: true, data: rows.results, total }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/alerts/:id — same columns + joins as the list, so a deep-linked
// alert shows its owner, staff owner and SaaS technique.
export async function handleGetAlert(request: Request, env: Env, alertId: string, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const ownership = alertScopeFilter(scope);
    if (!ownership) {
      return json({ success: false, error: "Alert not found" }, 404, origin);
    }

    const tail = `WHERE a.id = ? AND ${ownership.where}`;
    let row: Record<string, unknown> | null;
    try {
      row = await env.DB.prepare(`${staffAlertSelect(true)} ${tail}`)
        .bind(alertId, ...ownership.params).first<Record<string, unknown>>();
    } catch {
      row = await env.DB.prepare(`${staffAlertSelect(false)} ${tail}`)
        .bind(alertId, ...ownership.params).first<Record<string, unknown>>();
    }

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
//
// Body (at least one field):
//   status             — AlertStatus; shared column, visible to the customer
//   staff_assigned_to  — users.id of an ACTIVE platform-staff user, or null
//                        to release the staff claim. Never touches the
//                        customer's own `assigned_to`.
//   notes              — internal staff note (string ≤ 4000, or null to
//                        clear) → alerts.staff_notes. Never written to the
//                        customer-visible resolution_notes.
// `assigned_to` is rejected (400): it is the customer's own assignee.
export async function handleUpdateAlert(request: Request, env: Env, alertId: string, userId: string, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as Record<string, unknown>;
    const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;

    if (has("assigned_to")) {
      return json({
        success: false,
        error: "assigned_to is the customer's own assignee and cannot be set by staff; use staff_assigned_to",
      }, 400, origin);
    }

    const status = has("status") ? body.status : undefined;
    const hasStaffAssignee = has("staff_assigned_to");
    const hasNotes = has("notes");

    if (status === undefined && !hasStaffAssignee && !hasNotes) {
      return json({ success: false, error: "Missing field: status, staff_assigned_to or notes" }, 400, origin);
    }

    if (status !== undefined && (typeof status !== "string" || !VALID_STATUSES.includes(status as AlertStatus))) {
      return json({ success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` }, 400, origin);
    }

    let notes: string | null = null;
    if (hasNotes) {
      if (body.notes !== null && typeof body.notes !== "string") {
        return json({ success: false, error: "notes must be a string or null" }, 400, origin);
      }
      notes = typeof body.notes === "string" && body.notes.length > 0 ? body.notes : null;
      if (notes && notes.length > MAX_STAFF_NOTES_LENGTH) {
        return json({ success: false, error: `notes must be at most ${MAX_STAFF_NOTES_LENGTH} characters` }, 400, origin);
      }
    }

    let staffAssignee: string | null = null;
    if (hasStaffAssignee) {
      const raw = body.staff_assigned_to;
      if (raw !== null && (typeof raw !== "string" || raw.length === 0)) {
        return json({ success: false, error: "staff_assigned_to must be a user id or null" }, 400, origin);
      }
      staffAssignee = typeof raw === "string" ? raw : null;
      if (staffAssignee) {
        // Only Averrow staff can hold a staff claim. users.role (not the
        // JWT) is the stored role; isPlatformStaff is the same predicate
        // requireStaff admits.
        const u = await env.DB.prepare(
          "SELECT role, status FROM users WHERE id = ?",
        ).bind(staffAssignee).first<{ role: string | null; status: string | null }>();
        if (!u || u.status !== "active" || !isPlatformStaff(u.role)) {
          return json({ success: false, error: "staff_assigned_to must be an active Averrow staff user" }, 400, origin);
        }
      }
    }

    // Same scope predicate as the list (platform-wide for staff, PR-C).
    // Also reads the prior state for the audit trail.
    const ownership = alertScopeFilter(scope);
    if (!ownership) {
      return json({ success: false, error: "Alert not found" }, 404, origin);
    }
    const prior = await env.DB.prepare(
      `SELECT a.id, a.status, a.staff_assigned_to FROM alerts a WHERE a.id = ? AND ${ownership.where}`
    ).bind(alertId, ...ownership.params).first<{ id: string; status: string | null; staff_assigned_to: string | null }>();
    if (!prior) {
      return json({ success: false, error: "Alert not found" }, 404, origin);
    }

    // One UPDATE. SET fragments are fixed SQL; every value is bound.
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (status !== undefined) {
      sets.push("status = ?");
      binds.push(status);
      if (status === "acknowledged") {
        sets.push("acknowledged_at = datetime('now')");
      } else if (status === "resolved" || status === "false_positive") {
        sets.push("resolved_at = datetime('now')");
      }
    }
    if (hasStaffAssignee) {
      sets.push("staff_assigned_to = ?");
      binds.push(staffAssignee);
      sets.push(staffAssignee ? "staff_assigned_at = datetime('now')" : "staff_assigned_at = NULL");
    }
    if (hasNotes) {
      sets.push("staff_notes = ?");
      binds.push(notes);
    }
    sets.push("updated_at = datetime('now')");

    const result = await env.DB.prepare(
      `UPDATE alerts SET ${sets.join(", ")} WHERE id = ?`
    ).bind(...binds, alertId).run();
    if ((result.meta.changes ?? 0) === 0) {
      return json({ success: false, error: "Alert not found" }, 404, origin);
    }

    await invalidateAlertCaches(env, scope);

    // Who-acted trail: alerts has no acknowledged_by / resolved_by columns,
    // so the actor is recorded in AUDIT_DB. No org_id in details, so the
    // tenant audit-log view (json_extract(details,'$.org_id')) never shows
    // staff notes.
    await audit(env, {
      action: "alert_update",
      userId,
      resourceType: "alert",
      resourceId: String(alertId),
      details: {
        previous_status: prior.status,
        new_status: status ?? null,
        ...(hasNotes ? { staff_notes: truncateForAudit(notes) } : {}),
        ...(hasStaffAssignee
          ? {
              previous_staff_assigned_to: prior.staff_assigned_to == null ? null : String(prior.staff_assigned_to),
              staff_assigned_to: staffAssignee,
            }
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
// `auto_dismissed` = false_positive rows whose resolution_notes carry the
// `auto:` stamp written by rule triage (lib/alert-triage.ts) and the AI
// judge (lib/alert-ai-judge.ts). Staff notes go to staff_notes, so they
// can't inflate it.
//
// PR-C: platform-wide for staff, so the answer is identical for every staff
// caller — cached 60s per scope segment (`alerts_stats:global` for staff)
// and dropped by invalidateAlertCaches on any ops alert mutation.
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
    let stats: Record<string, number | null> | null = null;
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
      ).bind(...scopeFilter.params).first<Record<string, number | null>>();
      tally.queries += 1;
    }

    // SUM over zero rows is NULL — normalise every field to a number.
    const n = (k: string): number => stats?.[k] ?? 0;
    const data = {
      total: n("total"),
      new_count: n("new_count"),
      acknowledged: n("acknowledged"),
      resolved: n("resolved"),
      dismissed: n("dismissed"),
      auto_dismissed: n("auto_dismissed"),
      critical: n("critical"),
      high: n("high"),
      medium: n("medium"),
      low: n("low"),
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
//
// Body: { alert_ids: string[] (≤90) } or { brand_id }. Only status='new'
// alerts move. A brand-wide call acknowledges at most MAX_BULK_ALERTS (most
// severe, newest first) and returns `remaining` (still-new alerts for the
// brand) so the UI can repeat until 0. The pick + UPDATE is one statement;
// RETURNING gives the exact ids for the audit row.
export async function handleBulkAcknowledge(request: Request, env: Env, userId: string, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { alert_ids?: unknown; brand_id?: unknown };
    const parsed = parseBulkTarget(body);
    if (!parsed.ok) {
      return json({ success: false, error: parsed.error }, 400, origin);
    }
    const { brandId, alertIds } = parsed;

    const scopeFilter = alertScopeFilter(scope);
    if (!scopeFilter) {
      return json({ success: true, data: { updated: 0, alert_ids: [], remaining: 0 } }, 200, origin);
    }

    // Platform-wide for staff (PR-C): no user_id pin, only the scope filter.
    const target = brandId
      ? { where: `a.brand_id = ?`, params: [brandId] as unknown[] }
      : { where: `a.id IN (${alertIds!.map(() => "?").join(",")})`, params: alertIds as unknown[] };

    const result = await env.DB.prepare(
      `UPDATE alerts
          SET status = 'acknowledged', acknowledged_at = datetime('now'), updated_at = datetime('now')
        WHERE status = 'new'
          AND id IN (
            SELECT a.id FROM alerts a
             WHERE ${target.where} AND ${scopeFilter.where} AND a.status = 'new'
             ORDER BY ${SEVERITY_RANK_SQL}, a.created_at DESC
             LIMIT ?
          )
        RETURNING id`
    ).bind(...target.params, ...scopeFilter.params, MAX_BULK_ALERTS).all<{ id: string }>();
    const updatedIds = (result.results ?? []).map((r) => String(r.id));
    const updated = updatedIds.length;

    let remaining = 0;
    if (brandId) {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM alerts a WHERE a.brand_id = ? AND ${scopeFilter.where} AND a.status = 'new'`
      ).bind(brandId, ...scopeFilter.params).first<{ n: number }>();
      remaining = r?.n ?? 0;
    }

    if (updated > 0) await invalidateAlertCaches(env, scope);
    await audit(env, {
      action: "alert_bulk_acknowledge",
      userId,
      resourceType: "alert",
      resourceId: brandId ? `brand:${brandId}` : undefined,
      details: {
        brand_id: brandId,
        requested_ids: alertIds,
        affected_ids: updatedIds,
        updated,
        remaining,
      },
      outcome: "success",
      request,
    });

    return json({ success: true, data: { updated, alert_ids: updatedIds, remaining } }, 200, origin);
  } catch (err) {
    console.error('[alerts]', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/alerts/bulk-takedown
//
// Body: { alert_ids: string[] (≤90) } or { brand_id }. Only alerts with
// status 'new' or 'acknowledged' that don't already have a takedown
// (takedown_requests.source_type='alert' AND source_id=alert id) are
// eligible — never resolved / false_positive / investigating. At most
// MAX_BULK_ALERTS per call; brand-wide calls return `remaining`.
//
// Each takedown inherits the alert's org_id (NULL for a brand-wide alert), so
// a takedown spawned from an org-private alert (e.g. exec impersonation) stays
// with that org and a co-monitoring org can't modify it.
//
// The takedown INSERTs and the acknowledge UPDATE run in ONE env.DB.batch
// (a single D1 transaction): either every takedown lands and its alert is
// acknowledged, or nothing changes. Each INSERT re-checks status + "no
// takedown yet" itself, so an alert resolved or taken down between the
// pick and the batch is skipped rather than double-processed.
//
// KNOWN BUG (pre-existing, deliberately unchanged here): target_type and
// target_platform are hardcoded to 'social_profile' / 'tiktok' and
// target_value is the alert TITLE, whatever the alert type. Needs a
// per-alert-type mapping (domain/url for phishing, platform from details
// for social) before these drafts are submittable as-is.
export async function handleBulkTakedown(request: Request, env: Env, userId: string, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { alert_ids?: unknown; brand_id?: unknown };
    const parsed = parseBulkTarget(body);
    if (!parsed.ok) {
      return json({ success: false, error: parsed.error }, 400, origin);
    }
    const { brandId, alertIds: requestedIds } = parsed;

    const scopeFilter = alertScopeFilter(scope);
    if (!scopeFilter) {
      return json({ success: false, error: "No eligible alerts found" }, 404, origin);
    }

    const target = brandId
      ? { where: `a.brand_id = ?`, params: [brandId] as unknown[] }
      : { where: `a.id IN (${requestedIds!.map(() => "?").join(",")})`, params: requestedIds as unknown[] };
    const eligible = `a.status IN ('new', 'acknowledged')
           AND NOT EXISTS (
             SELECT 1 FROM takedown_requests tr
              WHERE tr.source_type = 'alert' AND tr.source_id = a.id
           )`;

    const picked = await env.DB.prepare(
      `SELECT a.id FROM alerts a
        WHERE ${target.where} AND ${scopeFilter.where} AND ${eligible}
        ORDER BY ${SEVERITY_RANK_SQL}, a.created_at DESC
        LIMIT ?`
    ).bind(...target.params, ...scopeFilter.params, MAX_BULK_ALERTS).all<{ id: string }>();
    const candidateIds = (picked.results ?? []).map((r) => String(r.id));

    if (candidateIds.length === 0) {
      return json({ success: false, error: "No eligible alerts found" }, 404, origin);
    }

    // module_key comes from the same shared target_type mapping every other
    // writer uses; without it no send path (Phase G, staff mark-submitted,
    // staff hand-submit) will ever accept the draft.
    const bulkModuleKey = moduleKeyForTargetType(BULK_TAKEDOWN_TARGET_TYPE);
    const inserts = candidateIds.map((alertId) =>
      env.DB.prepare(
        `INSERT INTO takedown_requests (id, org_id, brand_id, module_key, target_type, target_value, target_platform, evidence_summary, severity, priority_score, source_type, source_id, status, created_at, updated_at)
         SELECT ?, a.org_id, a.brand_id, ?, ?, a.title, 'tiktok', a.summary, a.severity, 50, 'alert', a.id, 'draft', datetime('now'), datetime('now')
           FROM alerts a
          WHERE a.id = ? AND ${eligible}`
      ).bind(crypto.randomUUID(), bulkModuleKey, BULK_TAKEDOWN_TARGET_TYPE, alertId),
    );
    const ack = env.DB.prepare(
      `UPDATE alerts SET status = 'acknowledged', acknowledged_at = datetime('now'), updated_at = datetime('now')
        WHERE status = 'new' AND id IN (${candidateIds.map(() => "?").join(",")})`
    ).bind(...candidateIds);

    const results = await env.DB.batch([...inserts, ack]);
    const takedownIds: string[] = [];
    candidateIds.forEach((id, i) => {
      if ((results[i]?.meta?.changes ?? 0) > 0) takedownIds.push(id);
    });
    const acknowledged = results[candidateIds.length]?.meta?.changes ?? 0;

    let remaining = 0;
    if (brandId) {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM alerts a WHERE a.brand_id = ? AND ${scopeFilter.where} AND ${eligible}`
      ).bind(brandId, ...scopeFilter.params).first<{ n: number }>();
      remaining = r?.n ?? 0;
    }

    await invalidateAlertCaches(env, scope);
    await audit(env, {
      action: "alert_bulk_takedown",
      userId,
      resourceType: "alert",
      resourceId: brandId ? `brand:${brandId}` : undefined,
      details: {
        brand_id: brandId,
        requested_ids: requestedIds,
        affected_ids: takedownIds,
        takedowns_created: takedownIds.length,
        alerts_acknowledged: acknowledged,
        remaining,
      },
      outcome: "success",
      request,
    });

    return json({
      success: true,
      data: {
        takedowns_created: takedownIds.length,
        alerts_acknowledged: acknowledged,
        alert_ids: takedownIds,
        remaining,
      },
    }, 200, origin);
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
// staff caller); an ops alert mutation (/api/alerts*) drops it via
// invalidateAlertCaches. Other writers (tenant actions, auto-triage, alert
// fan-out) don't invalidate — the 60s TTL bounds staleness for those.
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
