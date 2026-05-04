// Averrow — Notification Delivery Audit Handler
//
// Surfaces platform_* notifications and reports whether each one
// reached operators. Built after the Apr 30 - May 2 ingest blackout
// (50cb1e4) where platform_feed_silent was emitted but no operator
// noticed for 3 days.
//
// "Healthy" = at least one channel succeeded AND at least one
// recipient changed state from 'unread' to 'read' within 24h.
//
// Reads from notification_deliveries (migration 0131) joined against
// notifications (migration 0127+).

import { json } from "../lib/cors";
import type { Env } from "../types";

interface AuditRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  group_key: string | null;
  created_at: string;
  recipient_count: number;
  read_count: number;
  in_app_succeeded: number;
  push_attempted: number;
  push_succeeded: number;
  push_failed: number;
  push_skipped: number;
  email_attempted: number;
  email_succeeded: number;
  email_failed: number;
}

interface AuditResponse {
  generated_at: string;
  window_days: number;
  summary: {
    total: number;
    unread: number;
    push_failed: number;
    no_human_acknowledgement: number;
  };
  notifications: Array<AuditRow & {
    /** True if the notification has been open in the inbox for > 6h
     *  with no read_at on any recipient row. */
    stale: boolean;
    /** Best-effort assessment of "did this reach a human?". */
    delivery_health: "healthy" | "delivered_unread" | "push_only_failed" | "in_app_only";
  }>;
}

const DEFAULT_WINDOW_DAYS = 7;
const STALE_THRESHOLD_HOURS = 6;

export async function handleNotificationDeliveryAudit(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const days = Math.min(
    Math.max(parseInt(url.searchParams.get("days") ?? `${DEFAULT_WINDOW_DAYS}`, 10) || DEFAULT_WINDOW_DAYS, 1),
    30,
  );

  try {
    // One row per notification with delivery + read counts pivoted in
    // SQL. Joining against notifications keeps the result self-contained
    // so the UI doesn't need a second round-trip.
    const rows = await env.DB.prepare(
      `SELECT
         n.id, n.type, n.severity, n.title, n.group_key, n.created_at,
         (SELECT COUNT(DISTINCT user_id) FROM notifications WHERE group_key = n.group_key)
           AS recipient_count,
         (SELECT COUNT(*) FROM notifications
            WHERE group_key = n.group_key AND state = 'read')
           AS read_count,
         COALESCE(SUM(CASE WHEN nd.channel = 'in_app' AND nd.status = 'succeeded' THEN 1 ELSE 0 END), 0) AS in_app_succeeded,
         COALESCE(SUM(CASE WHEN nd.channel = 'push'   AND nd.status = 'attempted' THEN 1 ELSE 0 END), 0) AS push_attempted,
         COALESCE(SUM(CASE WHEN nd.channel = 'push'   AND nd.status = 'succeeded' THEN 1 ELSE 0 END), 0) AS push_succeeded,
         COALESCE(SUM(CASE WHEN nd.channel = 'push'   AND nd.status = 'failed'    THEN 1 ELSE 0 END), 0) AS push_failed,
         COALESCE(SUM(CASE WHEN nd.channel = 'push'   AND nd.status = 'skipped'   THEN 1 ELSE 0 END), 0) AS push_skipped,
         COALESCE(SUM(CASE WHEN nd.channel = 'email'  AND nd.status = 'attempted' THEN 1 ELSE 0 END), 0) AS email_attempted,
         COALESCE(SUM(CASE WHEN nd.channel = 'email'  AND nd.status = 'succeeded' THEN 1 ELSE 0 END), 0) AS email_succeeded,
         COALESCE(SUM(CASE WHEN nd.channel = 'email'  AND nd.status = 'failed'    THEN 1 ELSE 0 END), 0) AS email_failed
       FROM notifications n
       LEFT JOIN notification_deliveries nd ON nd.notification_id = n.id
       WHERE n.type LIKE 'platform_%'
         AND n.created_at >= datetime('now', '-' || ? || ' days')
       GROUP BY n.id
       ORDER BY n.created_at DESC
       LIMIT 200`,
    ).bind(days).all<AuditRow>();

    const now = Date.now();
    const annotated = rows.results.map(r => {
      const ageHours = (now - new Date(r.created_at + "Z").getTime()) / (1000 * 60 * 60);
      const stale = r.read_count === 0 && ageHours > STALE_THRESHOLD_HOURS;

      let delivery_health: AuditResponse["notifications"][number]["delivery_health"];
      if (r.read_count > 0) {
        delivery_health = "healthy";
      } else if (r.push_failed > 0 && r.push_succeeded === 0) {
        delivery_health = "push_only_failed";
      } else if (r.push_succeeded > 0 || r.push_attempted > 0) {
        delivery_health = "delivered_unread";
      } else {
        delivery_health = "in_app_only";
      }

      return { ...r, stale, delivery_health };
    });

    const summary = {
      total: annotated.length,
      unread: annotated.filter(r => r.read_count === 0).length,
      push_failed: annotated.reduce((s, r) => s + r.push_failed, 0),
      no_human_acknowledgement: annotated.filter(r => r.stale).length,
    };

    const body: AuditResponse = {
      generated_at: new Date().toISOString(),
      window_days: days,
      summary,
      notifications: annotated,
    };
    return json(body, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(
      { success: false, error: `notification-delivery-audit failed: ${message}` },
      500,
      origin,
    );
  }
}
