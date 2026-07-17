// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Insight & Notification Endpoints

import { json } from "../lib/cors";
import type { Env } from "../types";

// GET /api/insights/latest
export async function handleLatestInsights(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(20, parseInt(url.searchParams.get("limit") ?? "5", 10));

    const rows = await env.DB.prepare(`
      SELECT ao.id, ao.agent_id AS agent_name, ao.severity, ao.summary AS summary_text,
             ao.created_at, ao.type AS output_type,
             ao.details, ao.related_brand_ids, ao.related_campaign_id
      FROM agent_outputs ao
      WHERE ao.type IN ('insight', 'correlation')
      ORDER BY ao.created_at DESC
      LIMIT ?
    `).bind(limit).all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/notifications
export async function handleListNotifications(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "20", 10));
    const unreadOnly = url.searchParams.get("unread") === "true";

    let sql = `SELECT id, type, title, body, severity, created_at, read_by
               FROM system_notifications`;
    if (unreadOnly) {
      sql += ` WHERE (read_by IS NULL OR read_by NOT LIKE ?)`;
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;

    const params: unknown[] = unreadOnly ? [`%${userId}%`, limit] : [limit];
    const rows = await env.DB.prepare(sql).bind(...params).all();

    // Annotate with read status for the requesting user
    const data = rows.results.map((n: Record<string, unknown>) => {
      const readBy = n.read_by ? JSON.parse(n.read_by as string) as string[] : [];
      return { ...n, read: readBy.includes(userId), read_by: undefined };
    });

    return json({ success: true, data }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/notifications/:id/read
export async function handleMarkNotificationRead(request: Request, env: Env, notificationId: string, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const row = await env.DB.prepare("SELECT read_by FROM system_notifications WHERE id = ?")
      .bind(notificationId).first<{ read_by: string | null }>();

    if (!row) return json({ success: false, error: "Notification not found" }, 404, origin);

    const readBy: string[] = row.read_by ? JSON.parse(row.read_by) : [];
    if (!readBy.includes(userId)) {
      readBy.push(userId);
      await env.DB.prepare("UPDATE system_notifications SET read_by = ? WHERE id = ?")
        .bind(JSON.stringify(readBy), notificationId).run();
    }

    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/notifications/read-all
export async function handleMarkAllNotificationsRead(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Get all unread notifications for this user
    const rows = await env.DB.prepare(
      "SELECT id, read_by FROM system_notifications WHERE read_by IS NULL OR read_by NOT LIKE ?",
    ).bind(`%${userId}%`).all();

    for (const row of rows.results as { id: string; read_by: string | null }[]) {
      const readBy: string[] = row.read_by ? JSON.parse(row.read_by) : [];
      if (!readBy.includes(userId)) {
        readBy.push(userId);
        await env.DB.prepare("UPDATE system_notifications SET read_by = ? WHERE id = ?")
          .bind(JSON.stringify(readBy), row.id).run();
      }
    }

    return json({ success: true, data: { marked: rows.results.length } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
