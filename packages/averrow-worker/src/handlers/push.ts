/**
 * Web Push HTTP handlers — user-facing.
 *
 * Mounted at /api/notifications/* by routes/dashboard.ts. The user-
 * facing surface is named "notifications" because that's how the
 * UI talks about it; the backend keeps using "push" as the noun
 * because it's specifically about Web Push delivery (RFC 8030).
 *
 * Distinct from /api/admin/push/* which is the platform-side VAPID
 * configuration surface (super_admin only — handled by adminPush.ts).
 *
 * Endpoints:
 *   GET    /api/notifications/config         — VAPID public key + push_enabled
 *   POST   /api/notifications/subscribe      — register a device
 *   DELETE /api/notifications/unsubscribe    — remove by endpoint (body)
 *   POST   /api/notifications/test           — test push to caller's devices
 *   GET    /api/notifications/subscriptions  — list caller's devices
 *   DELETE /api/notifications/subscribe/:id  — remove a specific device by id
 *
 * Subscribe payload follows the W3C `PushSubscription.toJSON()` shape:
 *   { subscription: { endpoint, keys: { p256dh, auth } }, device_label? }
 */

import { json } from "../lib/cors";
import { dispatchPush } from "../lib/push";
import type { Env } from "../types";

// ─── GET /api/notifications/config ────────────────────────────
//
// Public — no auth. The SPA reads this on every page load to get
// the VAPID public key needed for `pushManager.subscribe()`. The
// public key isn't a secret; it's what the push service uses to
// verify our VAPID JWT signatures.
export async function handleGetNotificationConfig(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(
      `SELECT key, value FROM platform_config
        WHERE key IN ('push_enabled', 'vapid_public_key')`,
    ).all<{ key: string; value: string }>();

    const cfg: Record<string, string> = {};
    for (const r of rows.results) cfg[r.key] = r.value;

    return json({
      success: true,
      data: {
        vapid_public_key: cfg["vapid_public_key"] ?? "",
        push_enabled: cfg["push_enabled"] === "1",
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/notifications/subscribe ────────────────────────
//
// Auth required. Idempotent — same endpoint re-subscribing just
// refreshes the keys + re-binds to the current user (handles "user
// signs into a different account on the same device" cleanly).
//
// Body shape matches `PushSubscription.toJSON()` from the browser
// Push API spec:
//   { subscription: { endpoint, keys: { p256dh, auth } }, device_label? }
interface SubscribeBody {
  subscription?: {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  device_label?: string;
}

export async function handleSubscribePush(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = (await request.json()) as SubscribeBody;
    const sub = body.subscription;
    const endpoint = sub?.endpoint;
    const p256dh = sub?.keys?.p256dh;
    const auth = sub?.keys?.auth;

    if (!endpoint || !p256dh || !auth) {
      return json(
        { success: false, error: "subscription.endpoint, subscription.keys.p256dh, and subscription.keys.auth are required" },
        400,
        origin,
      );
    }

    const userAgent = request.headers.get("User-Agent") ?? null;

    await env.DB.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device_label, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        device_label = excluded.device_label,
        user_agent = excluded.user_agent
    `).bind(
      crypto.randomUUID(),
      userId,
      endpoint,
      p256dh,
      auth,
      body.device_label ?? null,
      userAgent,
    ).run();

    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── DELETE /api/notifications/unsubscribe ────────────────────
//
// Auth required. Removes the caller's row by endpoint (sent in the
// JSON body). Used by the unsubscribe flow which already has the
// endpoint string from `pushManager.getSubscription()`.
interface UnsubscribeBody {
  endpoint?: string;
}

export async function handleUnsubscribeByEndpoint(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = (await request.json().catch(() => ({}))) as UnsubscribeBody;
    if (!body.endpoint) {
      return json({ success: false, error: "endpoint is required" }, 400, origin);
    }
    await env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`,
    ).bind(body.endpoint, userId).run();
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── DELETE /api/notifications/subscribe/:id ──────────────────
//
// Auth required. Removes a specific device by row id — used by the
// "Manage devices" UI in Profile (the per-device revoke button).
export async function handleUnsubscribePush(
  request: Request,
  env: Env,
  subscriptionId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    await env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?`,
    ).bind(subscriptionId, userId).run();
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/notifications/subscriptions ─────────────────────
//
// Auth required. Lists the caller's devices for the Profile UI.
export async function handleListPushSubscriptions(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(
      `SELECT id, device_label, user_agent, created_at, last_used_at
         FROM push_subscriptions WHERE user_id = ?
         ORDER BY created_at DESC`,
    ).bind(userId).all();
    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/notifications/test ─────────────────────────────
//
// Auth required. Sends a test push to the caller's own subscribed
// devices, bypassing per-event prefs and quiet hours. Useful for
// "I want to confirm push is wired on this device after subscribe."
export async function handleTestNotification(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const result = await dispatchPush(env, userId, {
      title: "Averrow test notification",
      body: "If you see this, push delivery is working end-to-end on this device.",
      url: "/v2",
      tag: "averrow-test",
      severity: "info",
      type: "test",
    });

    if (result.sent === 0 && result.failed === 0 && result.expired === 0) {
      return json({
        success: false,
        error: "No subscribed devices found. Subscribe in Profile → Notifications first.",
      }, 400, origin);
    }

    return json({
      success: true,
      data: {
        attempted: result.sent + result.failed + result.expired,
        delivered: result.sent,
        failed: result.failed,
        expired: result.expired,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
