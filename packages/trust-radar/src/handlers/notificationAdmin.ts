/**
 * Notification Center — super-admin admin endpoints.
 *
 * NX5 (RESTRUCTURE_SPEC.md § NOTIFICATIONS RESTRUCTURE). Powers the
 * `/v2/notifications/admin` page in averrow-ops. Three responsibilities:
 *
 *   1. Activity stats — what's firing, to whom, at what severity, in
 *      the last 24h. Lets the operator answer "is the notification
 *      system healthy?" without reading the table by hand.
 *
 *   2. Per-type mutes — silence a specific event type for N hours
 *      during an incident. Producers continue firing; recipient
 *      resolution checks the mute and skips delivery. Hard expiry
 *      via `muted_until`; the mute self-clears, no cron needed.
 *
 *   3. Active mutes list — surface what's currently silenced so
 *      operators don't forget.
 *
 * All endpoints require super_admin (gated at the route layer in
 * src/routes/admin.ts). Mute writes are audited via the `created_by`
 * column on `notification_type_mutes`.
 */

import { json } from "../lib/cors";
import type { Env } from "../types";

// ─── Activity stats ─────────────────────────────────────────────────

// GET /api/admin/notifications/stats
// Returns a per-type/audience/severity breakdown of what's been written
// to the `notifications` table in the last 24h. Default window is 24h
// because that matches the bell badge expectation; the ?hours= param
// lets the operator widen for incident retros.
export async function handleNotificationStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const hoursRaw = parseInt(url.searchParams.get("hours") ?? "24", 10);
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 && hoursRaw <= 720
      ? hoursRaw
      : 24;
    const window = `-${hours} hours`;

    // Per-type rollup with audience + severity bucketing. Single query
    // since `notifications` has indices on (audience, created_at) and
    // (type) — both selected. LIMIT keeps the response bounded for the
    // unusual case of many event types being active.
    const byType = await env.DB.prepare(`
      SELECT
        type,
        audience,
        severity,
        COUNT(*)             AS fired,
        COUNT(DISTINCT user_id) AS unique_recipients
      FROM notifications
      WHERE created_at >= datetime('now', ?)
      GROUP BY type, audience, severity
      ORDER BY fired DESC
      LIMIT 200
    `).bind(window).all<{
      type: string; audience: string; severity: string;
      fired: number; unique_recipients: number;
    }>();

    const totalsRow = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT type) AS types,
        COUNT(DISTINCT user_id) AS unique_recipients,
        SUM(CASE WHEN audience = 'super_admin' THEN 1 ELSE 0 END) AS super_admin_count,
        SUM(CASE WHEN audience = 'tenant'      THEN 1 ELSE 0 END) AS tenant_count,
        SUM(CASE WHEN audience = 'team'        THEN 1 ELSE 0 END) AS team_count,
        SUM(CASE WHEN audience = 'all'         THEN 1 ELSE 0 END) AS all_count,
        SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical_count,
        SUM(CASE WHEN severity = 'high'     THEN 1 ELSE 0 END) AS high_count
      FROM notifications
      WHERE created_at >= datetime('now', ?)
    `).bind(window).first<{
      total: number; types: number; unique_recipients: number;
      super_admin_count: number; tenant_count: number;
      team_count: number; all_count: number;
      critical_count: number; high_count: number;
    }>();

    return json({
      success: true,
      data: {
        window_hours: hours,
        totals: totalsRow,
        by_type: byType.results,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Mutes ──────────────────────────────────────────────────────────

interface MuteBody {
  type?: string;
  hours?: number;
  reason?: string;
  // user_id stays implicit — system-wide mutes only for now. Per-user
  // mutes are a future feature; the schema (notification_type_mutes)
  // supports them via the user_id column already.
}

// POST /api/admin/notifications/mute
// Body: { type: string, hours: number (1-720), reason?: string }
// Creates / updates a system-wide mute (user_id NULL). Idempotent on
// (user_id, type) thanks to the unique index in migration 0193.
export async function handleCreateNotificationMute(
  request: Request, env: Env, mutedBy: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => ({})) as MuteBody;
    if (!body.type || typeof body.type !== 'string') {
      return json({ success: false, error: "type is required" }, 400, origin);
    }
    const hours = typeof body.hours === 'number' && body.hours > 0 && body.hours <= 720
      ? body.hours
      : 0;
    if (!hours) {
      return json({ success: false, error: "hours must be a positive number ≤ 720 (30 days)" }, 400, origin);
    }
    const id = crypto.randomUUID();
    const mutedUntil = new Date(Date.now() + hours * 3_600_000).toISOString();

    // UPSERT via the partial unique index (COALESCE(user_id,'') + type).
    // The DELETE-then-INSERT keeps the audit clean — every mute issuance
    // records who + when. Duplicate-suppression is by intent here, not
    // a bug: re-muting the same type extends the window.
    await env.DB.prepare(
      `DELETE FROM notification_type_mutes WHERE user_id IS NULL AND type = ?`
    ).bind(body.type).run();

    await env.DB.prepare(`
      INSERT INTO notification_type_mutes
        (id, user_id, type, muted_until, reason, created_by, created_at)
      VALUES (?, NULL, ?, ?, ?, ?, datetime('now'))
    `).bind(id, body.type, mutedUntil, body.reason ?? null, mutedBy).run();

    return json({
      success: true,
      data: { id, type: body.type, muted_until: mutedUntil, reason: body.reason ?? null },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// DELETE /api/admin/notifications/mute/:type
// Unmutes a system-wide mute by type. No-op if not currently muted.
export async function handleDeleteNotificationMute(
  request: Request, env: Env, type: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    if (!type) {
      return json({ success: false, error: "type is required" }, 400, origin);
    }
    await env.DB.prepare(
      `DELETE FROM notification_type_mutes WHERE user_id IS NULL AND type = ?`
    ).bind(type).run();
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/admin/notifications/mutes
// Lists active (non-expired) system-wide mutes.
export async function handleListNotificationMutes(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(`
      SELECT id, type, muted_until, reason, created_by, created_at
        FROM notification_type_mutes
       WHERE user_id IS NULL
         AND muted_until > datetime('now')
       ORDER BY muted_until DESC
    `).all<{
      id: string; type: string; muted_until: string;
      reason: string | null; created_by: string; created_at: string;
    }>();
    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
