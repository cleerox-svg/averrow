/**
 * Notification creation with rate limiting + push delivery.
 *
 * Three-layer gate (per FarmTrack pattern):
 *   1. Platform (`platform_config.push_enabled` + VAPID configured)
 *   2. Per-user pref:
 *        - userToggleable event flag in `notification_preferences` (e.g. brand_threat)
 *        - global channel flag for push (`push_notifications`)
 *   3. Quiet hours (`notification_preferences.quiet_hours_*`) —
 *        suppress PUSH only; in-app row always writes.
 *        Critical-severity events break through quiet hours when
 *        `critical_breakthrough = 1`.
 *
 * The event list, dedup windows, and which events are user-toggleable all
 * live in `notification-events.ts` — that module is the single source of
 * truth. Add new events there, never here.
 *
 * Signature change in PR 3a: the first arg is now `Env` (not `D1Database`)
 * so we can also reach the VAPID secret + read platform_config. Callers
 * are updated in lock-step. The function still writes the same in-app
 * `notifications` row it always did; push delivery is a NEW side effect
 * that fires after the in-app insert succeeds.
 */

import type { Env } from '../types';
import {
  NOTIFICATION_EVENT_DEDUP,
  NOTIFICATION_EVENTS,
  USER_TOGGLEABLE_EVENTS,
  type NotificationEventKey,
  type NotificationSeverity,
} from '@averrow/shared';
import { dispatchPush, isInQuietHours, type QuietHoursPrefs } from './push';

// Re-exported for callers that already imported these names.
export type NotificationType = NotificationEventKey;
export type Severity = NotificationSeverity;

const KNOWN_EVENT_KEYS: ReadonlySet<NotificationEventKey> = new Set(
  NOTIFICATION_EVENTS.map((e) => e.key)
);

const USER_TOGGLEABLE_EVENT_KEYS: ReadonlySet<NotificationEventKey> = new Set(
  USER_TOGGLEABLE_EVENTS.map((e) => e.key)
);

interface CreateNotificationOpts {
  userId?: string | null;
  type: NotificationType;
  severity: Severity;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;

  // ── N3 additions (NOTIFICATIONS_AUDIT.md §10) ────────────────────────
  /**
   * Audience routing. Defaults to 'tenant'. When 'tenant' + a brandId is
   * resolvable (from `brandId` arg or `metadata.brand_id`), recipients
   * are users with a notification_subscriptions row at level != 'ignored'
   * for that brand. When 'super_admin', recipients are all users with
   * role='super_admin'. When 'all' (legacy), every active user — kept
   * for compatibility with system-wide events.
   */
  audience?: 'tenant' | 'super_admin' | 'team' | 'all';
  brandId?: string | null;
  orgId?: string | null;
  /**
   * Static template fields (Q5). Surfaced in the UI as "Why am I seeing
   * this?" / "What should I do?".
   */
  reasonText?: string;
  recommendedAction?: string;
  /**
   * Dedup key. When present, replaces the legacy metadata-LIKE dedup
   * scan. Format: `<type>:<entity_id>` — e.g. `brand_threat:brand_42`.
   */
  groupKey?: string;
}

interface UserPrefRow {
  // Per-event toggles. `null` when row doesn't exist (defaults-if-absent).
  brand_threat?: number | null;
  campaign_escalation?: number | null;
  feed_health?: number | null;
  intelligence_digest?: number | null;
  agent_milestone?: number | null;
  // Global channel + DND
  push_notifications?: number | null;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  quiet_hours_tz?: string | null;
  critical_breakthrough?: number | null;
}

export async function createNotification(env: Env, opts: CreateNotificationOpts): Promise<number> {
  // Defense-in-depth: refuse unknown event keys before we hit the SQL CHECK.
  if (!KNOWN_EVENT_KEYS.has(opts.type)) {
    return 0;
  }

  const db = env.DB;

  // NX5: per-type mute check. Super admin can silence a notification
  // type for N hours during an incident via /api/admin/notifications/mute.
  // Producers continue running; we suppress at recipient resolution
  // time so the mute is honored without changing the producer code.
  // Best-effort — if the mute table query fails, fall through and
  // deliver as normal (the audit row is the source of truth).
  try {
    const muted = await db.prepare(
      `SELECT 1 FROM notification_type_mutes
        WHERE type = ? AND user_id IS NULL AND muted_until > datetime('now')
        LIMIT 1`
    ).bind(opts.type).first<{ '1': number }>();
    if (muted) return 0;
  } catch {
    // Table may not exist in older test fixtures — ignore.
  }
  const metadataJson = opts.metadata ? JSON.stringify(opts.metadata) : null;

  // ─── Resolve audience + scope ────────────────────────────────────────
  // N1: audience is now effectively required. The legacy default was
  // 'tenant', which silently fell through to "all active users" when no
  // brandId was derivable — that's the bug that caused super-admins to
  // receive every campaign_escalation / agent_milestone / feed_health
  // ping. The new resolution path:
  //
  //   - opts.audience present  → use as-is.
  //   - opts.audience missing  → infer from brandId presence:
  //                              brandId set    → 'tenant'  (brand event)
  //                              brandId absent → 'team'    (staff-wide,
  //                                                          excludes clients)
  //
  // To explicitly broadcast to every active user including tenants, set
  // `audience: 'all'`. Don't omit the field hoping for that behavior.
  const brandId = (opts.brandId ?? (opts.metadata?.brand_id as string | undefined)) ?? null;
  const audience: NonNullable<CreateNotificationOpts['audience']> =
    opts.audience ?? (brandId ? 'tenant' : 'team');
  const groupKey = opts.groupKey ?? (brandId ? `${opts.type}:${brandId}` : null);

  // ─── Dedup ────────────────────────────────────────────────────────────
  // Prefer group_key (canonical, indexed). Fall back to legacy metadata
  // LIKE for callers that haven't been updated yet.
  if (groupKey) {
    const window = NOTIFICATION_EVENT_DEDUP[opts.type];
    const existing = await db.prepare(
      `SELECT COUNT(*) as c FROM notifications
       WHERE type = ? AND group_key = ? AND created_at > datetime('now', ?)`
    ).bind(opts.type, groupKey, window).first<{ c: number }>();
    if (existing && existing.c > 0) return 0;
  } else {
    const rateKey = getRateKey(opts);
    if (rateKey) {
      const window = NOTIFICATION_EVENT_DEDUP[opts.type];
      const existing = await db.prepare(
        `SELECT COUNT(*) as c FROM notifications
         WHERE type = ? AND created_at > datetime('now', ?)
         AND metadata LIKE ?`
      ).bind(opts.type, window, `%${rateKey}%`).first<{ c: number }>();
      if (existing && existing.c > 0) return 0;
    }
  }

  // ─── Resolve target users ─────────────────────────────────────────────
  let userIds: string[];
  if (opts.userId) {
    userIds = [opts.userId];
  } else if (audience === 'super_admin') {
    const users = await db.prepare(
      "SELECT id FROM users WHERE status = 'active' AND role = 'super_admin'"
    ).all<{ id: string }>();
    userIds = users.results.map(u => u.id);
  } else if (audience === 'tenant' && brandId) {
    // Per §10.2: subscriptions level 'ignored' opts the user out;
    // 'default' and 'watching' both receive (severity floor handled
    // separately downstream).
    //
    // Q3 / N5: super_admins with show_tenant_notifications=1 are
    // ALSO recipients regardless of subscription — they explicitly
    // opted into the tenant firehose.
    const users = await db.prepare(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN notification_subscriptions ns ON ns.user_id = u.id
        WHERE u.status = 'active'
          AND ns.brand_id = ?
          AND ns.level != 'ignored'
       UNION
       SELECT u.id
         FROM users u
         JOIN notification_preferences_v2 p ON p.user_id = u.id
        WHERE u.status = 'active'
          AND u.role = 'super_admin'
          AND p.show_tenant_notifications = 1`
    ).bind(brandId).all<{ id: string }>();
    userIds = users.results.map(u => u.id);
  } else if (audience === 'team') {
    // Staff-wide: every non-client role. Used for cross-cutting agent
    // telemetry (feed health, agent stalls) where ops, SOC analysts,
    // sales, and support all want visibility, but tenant customers
    // (role='client') don't.
    const users = await db.prepare(
      "SELECT id FROM users WHERE status = 'active' AND role != 'client'"
    ).all<{ id: string }>();
    userIds = users.results.map(u => u.id);
  } else {
    // Explicit 'all' — every active user, tenants included. Reserved
    // for genuine cross-cutting events (platform maintenance, ToS
    // updates). Reaching this branch with audience='tenant' + no brandId
    // means the caller forgot to pass a brand; we log to console for
    // observability and broadcast staff-wide (NOT all users) to limit
    // the blast radius until the call site is fixed.
    if (audience === 'tenant' && !brandId) {
      console.warn(
        `[createNotification] type=${opts.type} requested audience=tenant but no brandId resolvable; downgrading to team broadcast`,
      );
      const users = await db.prepare(
        "SELECT id FROM users WHERE status = 'active' AND role != 'client'"
      ).all<{ id: string }>();
      userIds = users.results.map(u => u.id);
    } else {
      const users = await db.prepare("SELECT id FROM users WHERE status = 'active'").all<{ id: string }>();
      userIds = users.results.map(u => u.id);
    }
  }

  let created = 0;
  for (const uid of userIds) {
    // Pull every pref we might need in one query (event flag + push + DND).
    const pref = await db.prepare(
      `SELECT brand_threat, campaign_escalation, feed_health,
              intelligence_digest, agent_milestone,
              push_notifications,
              quiet_hours_start, quiet_hours_end, quiet_hours_tz,
              critical_breakthrough
         FROM notification_preferences WHERE user_id = ?`,
    ).bind(uid).first<UserPrefRow>();

    // ── Gate 2a: per-event opt-out (only for user-toggleable events) ──
    if (USER_TOGGLEABLE_EVENT_KEYS.has(opts.type) && pref) {
      const eventEnabled = pref[opts.type as keyof UserPrefRow];
      if (eventEnabled === 0) continue;
    }

    // ── Write the in-app row (always — DND doesn't suppress in-app) ──
    // Schema columns from migration 0127: id, user_id, brand_id, org_id,
    // audience, type, severity, title, message, reason_text,
    // recommended_action, link, state (defaults to 'unread'), group_key,
    // metadata. created_at + updated_at have DB defaults.
    const notificationId = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO notifications
         (id, user_id, brand_id, org_id, audience,
          type, severity, title, message,
          reason_text, recommended_action, link,
          group_key, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      notificationId, uid, brandId, opts.orgId ?? null, audience,
      opts.type, opts.severity, opts.title, opts.message,
      opts.reasonText ?? null, opts.recommendedAction ?? null, opts.link ?? null,
      groupKey, metadataJson,
    ).run();
    created++;

    // ── Per-channel delivery audit (migration 0131) ─────────────────
    // The in_app row above always succeeds at this point (the INSERT
    // would have thrown otherwise). Record it so the delivery audit
    // can prove a notification reached at least one channel.
    await recordDelivery(env, notificationId, uid, "in_app", "succeeded", null);

    // ── Push delivery — best-effort, never fails the in-app write ──
    // Inline await is fine: dispatchPush parallelizes per-device sends
    // and each one has a 5s timeout (see lib/push.ts).
    const pushAllowed = await shouldSendPush(opts, pref);
    if (pushAllowed) {
      // Mark the attempt synchronously so the audit can see "push
      // attempted" even if the worker is killed before dispatchPush
      // resolves. dispatchPush's own per-device telemetry lives in
      // push_devices / push_delivery_log.
      await recordDelivery(env, notificationId, uid, "push", "attempted", null);
      dispatchPush(env, uid, {
        title: opts.title,
        body: opts.message,
        url: opts.link,
        tag: `${opts.type}-${notificationId}`,
        notificationId,
        severity: opts.severity,
        type: opts.type,
      }).then(
        () => recordDelivery(env, notificationId, uid, "push", "succeeded", null),
        (err: unknown) => {
          const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
          return recordDelivery(env, notificationId, uid, "push", "failed", reason);
        },
      ).catch(() => { /* swallow — in-app row is the source of truth */ });
    } else {
      // Capture the reason a notification skipped the push channel so
      // the audit can distinguish "user opted out" from "delivery broke".
      const reason = !pref
        ? "no preferences row"
        : pref.push_notifications !== 1
          ? "push_notifications opt-out"
          : "quiet hours / DND";
      await recordDelivery(env, notificationId, uid, "push", "skipped", reason);
    }
  }
  return created;
}

/** Gate 2b + Gate 3: should we attempt push delivery for this event/user? */
async function shouldSendPush(
  opts: CreateNotificationOpts,
  pref: UserPrefRow | null,
): Promise<boolean> {
  if (!pref) return false;                       // no row = defaults (push off)
  if (pref.push_notifications !== 1) return false; // explicit user opt-in required

  const quiet: QuietHoursPrefs = {
    start: pref.quiet_hours_start ?? null,
    end: pref.quiet_hours_end ?? null,
    tz: pref.quiet_hours_tz ?? null,
    criticalBreakthrough: pref.critical_breakthrough === 1,
  };
  if (isInQuietHours(quiet)) {
    // Critical events with breakthrough enabled punch through DND.
    if (opts.severity === 'critical' && quiet.criticalBreakthrough) return true;
    return false;
  }
  return true;
}

function getRateKey(opts: CreateNotificationOpts): string | null {
  if (!opts.metadata) return null;
  const m = opts.metadata;
  if (m.brand_id) return `"brand_id":"${m.brand_id}"`;
  if (m.campaign_id) return `"campaign_id":"${m.campaign_id}"`;
  if (m.feed_name) return `"feed_name":"${m.feed_name}"`;
  if (m.agent_id) return `"agent_id":"${m.agent_id}"`;
  return null;
}

/** Per-channel delivery audit. Failures here must never break the
 *  notification flow — wrap and swallow. Migration 0131. */
async function recordDelivery(
  env: Env,
  notificationId: string,
  userId: string,
  channel: "in_app" | "push" | "email",
  status: "attempted" | "succeeded" | "failed" | "skipped",
  reason: string | null,
): Promise<void> {
  try {
    const completedAt = status === "attempted" ? null : new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO notification_deliveries
         (id, notification_id, user_id, channel, status, reason, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (notification_id, user_id, channel)
       DO UPDATE SET status = excluded.status,
                     reason = excluded.reason,
                     completed_at = excluded.completed_at`,
    ).bind(
      crypto.randomUUID(),
      notificationId,
      userId,
      channel,
      status,
      reason,
      completedAt,
    ).run();
  } catch {
    // Audit table missing or transient D1 error — never fatal. The
    // in-app row is the source of truth.
  }
}
