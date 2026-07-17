/**
 * Web Push orchestration — config loading, send-to-endpoint, auto-cleanup.
 *
 * Public surface:
 *   - getPushConfig(env)       — loads platform_config row + secret
 *   - getUserSubscriptions(...) — fetches all push_subscriptions for a user
 *   - sendPushTo(...)          — encrypts + signs + POSTs to one subscription
 *   - dispatchPush(...)        — fans out to all of a user's subs, handles 404/410
 *   - isInQuietHours(...)      — quiet-hours evaluator (used by the dispatcher)
 *
 * Integration with the existing notification flow:
 *   `src/lib/notifications.ts:createNotification()` is unchanged in role —
 *   it still writes the in-app row. After the row is written, it now
 *   ALSO calls dispatchPush() if the user has push enabled and isn't in
 *   quiet hours. The push payload encodes the in-app row's id + url so
 *   the SW (PR 3b) can deep-link the click and mark the row as read.
 */

import type { Env } from '../types';
import { buildVapidJWT } from './push-vapid';
import { encryptPushPayload } from './push-encryption';

// ─── Config loading ────────────────────────────────────────────────────

export interface PushConfig {
  enabled: boolean;
  vapidPublicKey: string;   // base64url, 65 bytes uncompressed
  vapidSubject: string;     // 'mailto:ops@averrow.com'
  vapidPrivateKey: string;  // base64url, 32 bytes (from wrangler secret)
}

/** Returns null if push is disabled or VAPID isn't configured.
 *  Callers should treat null as "skip push, in-app only". */
export async function getPushConfig(env: Env): Promise<PushConfig | null> {
  const rows = await env.DB.prepare(
    `SELECT key, value FROM platform_config
      WHERE key IN ('push_enabled', 'vapid_public_key', 'vapid_subject')`,
  ).all<{ key: string; value: string }>();

  const cfg: Record<string, string> = {};
  for (const r of rows.results) cfg[r.key] = r.value ?? '';

  const enabled = cfg['push_enabled'] === '1';
  if (!enabled) return null;

  const vapidPublicKey = cfg['vapid_public_key'] ?? '';
  const vapidSubject = cfg['vapid_subject'] ?? '';
  const vapidPrivateKey = (env as unknown as { VAPID_PRIVATE_KEY?: string }).VAPID_PRIVATE_KEY ?? '';

  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    // Misconfigured — flagging push_enabled without setting keys. Don't
    // crash the dispatcher; just skip push and let the operator see the
    // empty values via the admin endpoint.
    return null;
  }

  return { enabled, vapidPublicKey, vapidSubject, vapidPrivateKey };
}

// ─── Subscriptions ─────────────────────────────────────────────────────

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_label: string | null;
}

export async function getUserSubscriptions(
  db: D1Database,
  userId: string,
): Promise<PushSubscriptionRow[]> {
  const rows = await db.prepare(
    `SELECT id, user_id, endpoint, p256dh, auth, device_label
       FROM push_subscriptions WHERE user_id = ?`,
  ).bind(userId).all<PushSubscriptionRow>();
  return rows.results;
}

// ─── Quiet hours ───────────────────────────────────────────────────────

export interface QuietHoursPrefs {
  start: string | null;   // 'HH:MM'
  end: string | null;     // 'HH:MM'
  tz: string | null;      // IANA — falls back to UTC if invalid
  criticalBreakthrough: boolean;
}

/** True iff the current wall clock in `tz` is inside the [start, end) window.
 *  The window is inclusive of `start`, exclusive of `end`, and wraps midnight
 *  (start='22:00', end='07:00' = 22:00–07:00 next day). */
export function isInQuietHours(prefs: QuietHoursPrefs, now: Date = new Date()): boolean {
  if (!prefs.start || !prefs.end) return false;

  const tz = prefs.tz || 'UTC';
  let parts: { hour: string; minute: string };
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const obj = Object.fromEntries(
      fmt.formatToParts(now)
        .filter(p => p.type === 'hour' || p.type === 'minute')
        .map(p => [p.type, p.value]),
    );
    parts = { hour: obj['hour'] ?? '00', minute: obj['minute'] ?? '00' };
  } catch {
    // Invalid tz — fall back to UTC
    const u = now.toISOString().slice(11, 16); // 'HH:MM'
    parts = { hour: u.slice(0, 2), minute: u.slice(3, 5) };
  }

  // 'HH:MM' string comparison works for sortable 24-hour times.
  const nowStr = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  const start = prefs.start;
  const end = prefs.end;

  if (start <= end) {
    return nowStr >= start && nowStr < end;
  }
  // Wraps midnight.
  return nowStr >= start || nowStr < end;
}

// ─── Send a single push ────────────────────────────────────────────────

export interface PushPayload {
  /** Notification title (top line of the OS notification). */
  title: string;
  /** Body text (second line). */
  body: string;
  /** Deep link to open on click — handled by the SW's notificationclick (PR 3b). */
  url?: string;
  /** Tag for collapsing duplicates in the OS notification tray. */
  tag?: string;
  /** Reference to the in-app `notifications.id` row, so the SW can mark-read on click. */
  notificationId?: string;
  /** Severity bucket — used by the SW for icon/badge selection in PR 3b. */
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /** Event registry key — for client-side filtering / analytics. */
  type?: string;
  /**
   * W3C Web Push action buttons. Pass an empty array to opt out
   * of the SW's default Snooze/Done buttons. Chrome + Firefox
   * honor; iOS Safari (PWA) ignores. Server-side default is
   * undefined → SW renders default Snooze/Done.
   */
  actions?: Array<{ action: string; title: string; icon?: string }>;
}

export interface SendResult {
  ok: boolean;
  status?: number;
  /** True when the push service indicates the subscription is gone (404/410). */
  expired?: boolean;
  error?: string;
}

const PUSH_TIMEOUT_MS = 5000;

export async function sendPushTo(
  cfg: PushConfig,
  sub: PushSubscriptionRow,
  payload: PushPayload,
): Promise<SendResult> {
  const url = new URL(sub.endpoint);

  const { jwt, publicKey } = await buildVapidJWT(
    `${url.protocol}//${url.host}`,
    cfg.vapidSubject,
    cfg.vapidPrivateKey,
    cfg.vapidPublicKey,
  );

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const { body } = await encryptPushPayload({
    p256dh: sub.p256dh,
    auth: sub.auth,
    plaintext,
  });

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': String(body.byteLength),
        'TTL': '86400',
        'Authorization': `vapid t=${jwt}, k=${publicKey}`,
        'Urgency': payload.severity === 'critical' ? 'high' : 'normal',
      },
      body: body as BodyInit,
    });

    if (res.status === 404 || res.status === 410) {
      return { ok: false, status: res.status, expired: true };
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status };
    }
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Fan-out across all of a user's subscriptions ──────────────────────

/** Dispatch a push to every device the user has subscribed.
 *  Auto-deletes any subscription that returns 404/410 (subscription
 *  expired — user uninstalled the PWA or revoked permission). Bumps
 *  `last_used_at` on successful sends.
 *
 *  Returns counts; never throws. Callers (the dispatcher in
 *  `lib/notifications.ts`) should ignore failures here — push is a
 *  best-effort delivery alongside the in-app row that's always written. */
export async function dispatchPush(
  env: Env,
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; expired: number; failed: number }> {
  const cfg = await getPushConfig(env);
  if (!cfg) return { sent: 0, expired: 0, failed: 0 };

  const subs = await getUserSubscriptions(env.DB, userId);
  if (subs.length === 0) return { sent: 0, expired: 0, failed: 0 };

  let sent = 0, expired = 0, failed = 0;
  const now = new Date().toISOString();

  // Send in parallel — each call is bounded by PUSH_TIMEOUT_MS.
  const results = await Promise.allSettled(subs.map(s => sendPushTo(cfg, s, payload)));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const sub = subs[i];
    if (!r || !sub) continue;
    if (r.status === 'fulfilled' && r.value.ok) {
      sent++;
      env.DB.prepare(`UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?`)
        .bind(now, sub.id).run().catch(() => {});
    } else if (r.status === 'fulfilled' && r.value.expired) {
      expired++;
      env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?`)
        .bind(sub.id).run().catch(() => {});
    } else {
      failed++;
    }
  }

  return { sent, expired, failed };
}
