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
  // Global channel + DND (v1 — legacy)
  push_notifications?: number | null;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  quiet_hours_tz?: string | null;
  critical_breakthrough?: number | null;
  // NX6 fix: v2 fields joined so the push gate can use the modern
  // source-of-truth. The NX5 preferences UI writes push_severity_floor
  // (NotificationPreferencesV2) but the legacy v1 push_notifications
  // column was the gate — so users who toggled push via the new UI
  // never actually received pushes.
  v2_push_severity_floor?: string | null;
  v2_quiet_hours_start?: string | null;
  v2_quiet_hours_end?: string | null;
  v2_quiet_hours_timezone?: string | null;
  v2_critical_bypasses_quiet?: number | null;
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0, low: 1, medium: 2, high: 3, critical: 4,
};

// Notification types that are valuable to tenant brand subscribers but
// not actionable by super_admins. These get the regular tenant recipient
// resolution (notification_subscriptions) but skip the super_admin
// show_tenant_notifications opt-in path — even when a super_admin has
// the firehose toggle on. Super admins can still view them per-brand
// in the admin alerts surface when investigating.
//
// `intel_recommended_action` is the canonical entry: DMARC=none + other
// hygiene callouts that only the brand owner can fix. Production audit
// on 2026-05-16 showed one super_admin receiving 538 of these in 24h
// for random unclaimed brands.
const TENANT_ONLY_TYPES: ReadonlySet<string> = new Set([
  'intel_recommended_action',
]);

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
  //
  // PR-BM (2026-05-21): switched COUNT(*) → SELECT 1 ... LIMIT 1. The
  // dedup is a binary decision ("does any row exist in the window?"),
  // so counting every matching row is wasted work.
  //
  // PR-BN (2026-05-22): added ORDER BY created_at DESC. Post-PR-BM
  // diagnostics showed LIMIT 1 alone wasn't reducing rows/call (still
  // 21K rows/call) because the planner was scanning the full (type,
  // group_key) prefix and picking any row — not short-circuiting at
  // the newest. The explicit ORDER BY forces the planner to walk
  // idx_notifications_dedup (type, group_key, created_at DESC) in
  // sort order and seek the newest row first. With LIMIT 1 that's a
  // ≤1-row read whether dedup hits (returns the newest matching row)
  // or misses (newest is older than the window — no rows match).
  // Together the two clauses unlock the ~12M reads/day savings.
  if (groupKey) {
    const window = NOTIFICATION_EVENT_DEDUP[opts.type];
    const existing = await db.prepare(
      `SELECT 1 AS hit FROM notifications
       WHERE type = ? AND group_key = ? AND created_at > datetime('now', ?)
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(opts.type, groupKey, window).first<{ hit: number }>();
    if (existing) return 0;
  } else {
    const rateKey = getRateKey(opts);
    if (rateKey) {
      const window = NOTIFICATION_EVENT_DEDUP[opts.type];
      const existing = await db.prepare(
        `SELECT 1 AS hit FROM notifications
         WHERE type = ? AND created_at > datetime('now', ?)
         AND metadata LIKE ?
         ORDER BY created_at DESC
         LIMIT 1`
      ).bind(opts.type, window, `%${rateKey}%`).first<{ hit: number }>();
      if (existing) return 0;
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
    //
    // NX-push-uxr+1: types in TENANT_ONLY_TYPES (hygiene callouts the
    // super_admin can't action — e.g. intel_recommended_action for
    // brand DMARC=none) skip the super_admin half of the UNION. Brand
    // subscribers still receive them. Production audit showed a single
    // super_admin getting 538 DMARC-hygiene notifications in 24h about
    // random unclaimed brands they have no power to fix.
    const includeSuperAdmins = !TENANT_ONLY_TYPES.has(opts.type);
    const sql = includeSuperAdmins
      ? `SELECT DISTINCT u.id
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
      : `SELECT DISTINCT u.id
           FROM users u
           JOIN notification_subscriptions ns ON ns.user_id = u.id
          WHERE u.status = 'active'
            AND ns.brand_id = ?
            AND ns.level != 'ignored'`;
    const users = await db.prepare(sql).bind(brandId).all<{ id: string }>();
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
    // Pull every pref we might need in one query — v1 (event flags +
    // legacy push toggle + DND) JOIN v2 (modern severity floors +
    // quiet hours). NX6 fix: prior versions queried v1 only, so the
    // push gate used the legacy push_notifications column even after
    // the NX5 UI moved users to the v2 push_severity_floor model.
    // Users who set their preferences in the new UI never got pushes
    // because v1.push_notifications stayed at 0/null.
    const pref = await db.prepare(
      `SELECT np.brand_threat, np.campaign_escalation, np.feed_health,
              np.intelligence_digest, np.agent_milestone,
              np.push_notifications,
              np.quiet_hours_start, np.quiet_hours_end, np.quiet_hours_tz,
              np.critical_breakthrough,
              pv.push_severity_floor      AS v2_push_severity_floor,
              pv.quiet_hours_start        AS v2_quiet_hours_start,
              pv.quiet_hours_end          AS v2_quiet_hours_end,
              pv.quiet_hours_timezone     AS v2_quiet_hours_timezone,
              pv.critical_bypasses_quiet  AS v2_critical_bypasses_quiet
         FROM users u
         LEFT JOIN notification_preferences    np ON np.user_id = u.id
         LEFT JOIN notification_preferences_v2 pv ON pv.user_id = u.id
        WHERE u.id = ?`,
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
      const v2Floor = pref?.v2_push_severity_floor;
      const v1Enabled = pref?.push_notifications === 1;
      const reason = !pref
        ? "no preferences row"
        : v2Floor === 'off'
          ? "v2 push_severity_floor=off"
          : v2Floor && (SEVERITY_RANK[opts.severity] ?? 0) < (SEVERITY_RANK[v2Floor] ?? 0)
            ? `severity ${opts.severity} below floor ${v2Floor}`
            : !v2Floor && !v1Enabled
              ? "v1 push_notifications opt-out (no v2 row)"
              : "quiet hours / DND";
      await recordDelivery(env, notificationId, uid, "push", "skipped", reason);
    }
  }
  return created;
}

/** Gate 2b + Gate 3: should we attempt push delivery for this event/user?
 *
 * NX6 fix: v2 push_severity_floor is the canonical source. v1
 * push_notifications is the legacy fallback for users without a v2
 * row (rare — handleGetPreferencesV2 auto-seeds them on first read).
 *
 * Push fires when EITHER:
 *   - v2 push_severity_floor != 'off' AND notification severity meets the floor, OR
 *   - v2 not present AND v1 push_notifications === 1 (legacy users).
 *
 * Quiet hours: v2 columns take precedence when present; v1 used as fallback.
 * Critical breakthrough: v2 critical_bypasses_quiet takes precedence.
 */
async function shouldSendPush(
  opts: CreateNotificationOpts,
  pref: UserPrefRow | null,
): Promise<boolean> {
  if (!pref) return false;

  // ── Channel gate: v2 floor first, v1 toggle as fallback ──────────
  const v2Floor = pref.v2_push_severity_floor;
  let v2Allows = false;
  if (v2Floor && v2Floor !== 'off') {
    const eventRank = SEVERITY_RANK[opts.severity] ?? 0;
    const floorRank = SEVERITY_RANK[v2Floor] ?? 0;
    v2Allows = eventRank >= floorRank;
  }
  const v1Allows = pref.push_notifications === 1;
  // v2 is the canonical source — only fall back to v1 when no v2 row exists.
  const v2HasRow = !!v2Floor;
  const allowed = v2HasRow ? v2Allows : v1Allows;
  if (!allowed) return false;

  // ── Quiet hours: prefer v2, fall back to v1 ──────────────────────
  const quietStart = pref.v2_quiet_hours_start    ?? pref.quiet_hours_start    ?? null;
  const quietEnd   = pref.v2_quiet_hours_end      ?? pref.quiet_hours_end      ?? null;
  const quietTz    = pref.v2_quiet_hours_timezone ?? pref.quiet_hours_tz       ?? null;
  const criticalBreakthrough = pref.v2_critical_bypasses_quiet != null
    ? pref.v2_critical_bypasses_quiet === 1
    : pref.critical_breakthrough === 1;

  const quiet: QuietHoursPrefs = {
    start: quietStart,
    end: quietEnd,
    tz: quietTz,
    criticalBreakthrough,
  };
  if (isInQuietHours(quiet)) {
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
