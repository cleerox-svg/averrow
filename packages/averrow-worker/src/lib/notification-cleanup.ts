// Averrow — Notification ↔ alert reconciliation sweep
//
// The `alerts` and `notifications` tables are loosely coupled — there
// is no foreign key linking a notification to the alert that fired
// it. Most notification creators (notification_narrator, strategist,
// flightControl) emit aggregate envelopes that don't reference a
// specific alert id. So when an alert auto-dismisses (Tier 1/1.5/3
// triage), the bell notification doesn't automatically clear and the
// operator's unread count stays stale.
//
// This sweep does the cleanest correlation we can manage today:
// match notifications that share the same `brand_id` AND landed
// within a tight time window (default ±15 min) of a `false_positive`
// alert created in the same window. Anything matching gets stamped
// as 'read' so the bell catches up.
//
// Heuristic by design: we may miss notifications that pre-date the
// alert by more than the window, and we may incorrectly mark a few
// notifications as read for brands with high alert volume. The
// alternative — leaving the bell stale forever — is operationally
// worse, and the operator can always re-mark a notification as
// unread via the existing notifications API.
//
// Operators run `POST /api/admin/notifications/cleanup-dismissed`
// to trigger the sweep on demand. Idempotent — already-read
// notifications are no-ops on re-run.

import type { D1Database } from '@cloudflare/workers-types';

export interface NotificationCleanupResult {
  /** Number of dismissed alerts considered. */
  alerts_checked: number;
  /** Number of notifications updated to 'read' status. */
  notifications_cleared: number;
}

export interface NotificationCleanupOptions {
  /** Look back N hours for dismissed alerts. Default 168 (7 days). */
  lookbackHours?: number;
  /** Time window in minutes to correlate notifications to alerts. Default 15. */
  windowMinutes?: number;
  /** Bound the sweep so it doesn't blow the worker budget. */
  limit?: number;
}

/**
 * Mark notifications as 'read' when they correlate (by brand_id +
 * time window) to a recently auto-dismissed alert.
 *
 * Two-step: first pull dismissed alerts in the lookback window,
 * then run a single bulk UPDATE per alert that matches notifications
 * by brand_id + created_at within ±windowMinutes of the alert.
 *
 * Returns counts so the operator can audit how many notifications
 * each call swept.
 */
export async function reconcileNotificationsForDismissedAlerts(
  db: D1Database,
  opts?: NotificationCleanupOptions,
): Promise<NotificationCleanupResult> {
  const lookbackHours = opts?.lookbackHours ?? 168;
  const windowMinutes = opts?.windowMinutes ?? 15;
  const limit = Math.max(1, Math.min(2000, opts?.limit ?? 1000));

  // Pull recently auto-dismissed alerts. Only those whose
  // resolution_notes start with 'auto:' — operator-driven manual
  // dismissals already mark notifications individually via the bell
  // UI, so we don't sweep for those.
  const alerts = await db.prepare(`
    SELECT id, brand_id, created_at
    FROM alerts
    WHERE status = 'false_positive'
      AND resolution_notes LIKE 'auto:%'
      AND resolved_at >= datetime('now', '-' || ? || ' hours')
    ORDER BY resolved_at DESC
    LIMIT ?
  `).bind(lookbackHours, limit).all<{ id: string; brand_id: string; created_at: string }>();

  let notificationsCleared = 0;

  for (const alert of alerts.results) {
    // Mark notifications as 'read' that share brand_id and landed
    // within ±windowMinutes of the alert's created_at. Only updates
    // currently-unread rows so the count is meaningful.
    const result = await db.prepare(`
      UPDATE notifications
      SET state = 'read', updated_at = datetime('now')
      WHERE state = 'unread'
        AND brand_id = ?
        AND created_at >= datetime(?, '-' || ? || ' minutes')
        AND created_at <= datetime(?, '+' || ? || ' minutes')
    `).bind(
      alert.brand_id,
      alert.created_at, windowMinutes,
      alert.created_at, windowMinutes,
    ).run();
    notificationsCleared += result.meta.changes ?? 0;
  }

  return {
    alerts_checked: alerts.results.length,
    notifications_cleared: notificationsCleared,
  };
}
