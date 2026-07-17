/**
 * Admin push handlers — VAPID bootstrap + send-test.
 *
 * The bootstrap flow is intentionally manual because the VAPID private
 * key must be set as a Cloudflare secret (`wrangler secret put`), which
 * can't happen in-band from a Worker request. Sequence:
 *
 *   1. Admin calls POST /api/admin/push/generate-vapid-keys
 *      → Worker generates a fresh ECDSA P-256 keypair via Web Crypto.
 *      → Returns BOTH keys to the admin one time (for write-down).
 *      → Stores public key + subject in platform_config.
 *      → push_enabled stays '0' until the operator confirms.
 *
 *   2. Operator runs (offline):
 *        wrangler secret put VAPID_PRIVATE_KEY
 *      and pastes the private key from step 1.
 *
 *   3. Admin calls PUT /api/admin/push/config { enabled: true } to flip
 *      push_enabled = '1' once they've confirmed the secret is set.
 *
 *   4. POST /api/admin/push/test sends a test push to the calling admin's
 *      own subscriptions — useful for confirming the encryption + JWT
 *      signing path works end-to-end after key rotation.
 */

import { json } from "../lib/cors";
import type { Env } from "../types";
import { generateVapidKeypair } from "../lib/push-vapid";
import { dispatchPush, getPushConfig } from "../lib/push";

interface UpdateConfigBody {
  enabled?: boolean;
  subject?: string;
  public_key?: string;  // allow manual paste in case of key rotation outside Worker
}

// POST /api/admin/push/generate-vapid-keys — super_admin only
// Generates a fresh keypair, persists the public half, returns both.
// SAFE because this is rate-limited by the requireSuperAdmin gate and only
// returns the private key to the calling admin's response body, never to
// any other surface.
export async function handleGenerateVapidKeys(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => ({})) as { subject?: string };
    const subject = body.subject ?? "mailto:ops@averrow.com";
    if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
      return json({ success: false, error: "subject must be mailto: or https://" }, 400, origin);
    }

    const { publicKey, privateKey } = await generateVapidKeypair();

    // Persist public key + subject. Do NOT enable push — operator must
    // confirm the wrangler secret is set first.
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO platform_config (key, value, updated_at) VALUES ('vapid_public_key', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(publicKey, now).run();
    await env.DB.prepare(`
      INSERT INTO platform_config (key, value, updated_at) VALUES ('vapid_subject', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(subject, now).run();

    return json({
      success: true,
      data: {
        public_key: publicKey,
        private_key: privateKey,
        subject,
        next_steps: [
          "1. Save the private_key to a password manager.",
          "2. Run: wrangler secret put VAPID_PRIVATE_KEY",
          "3. Paste the private_key when prompted.",
          "4. Call PUT /api/admin/push/config { enabled: true } to flip the master switch.",
          "5. Call POST /api/admin/push/test to verify end-to-end delivery.",
        ],
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/admin/push/config — super_admin only
// Returns current state without exposing secrets.
export async function handleGetPushConfig(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(
      `SELECT key, value, updated_at FROM platform_config
        WHERE key IN ('push_enabled', 'vapid_public_key', 'vapid_subject')`,
    ).all<{ key: string; value: string; updated_at: string }>();
    const cfg: Record<string, { value: string; updated_at: string }> = {};
    for (const r of rows.results) cfg[r.key] = { value: r.value, updated_at: r.updated_at };

    const privateKeyConfigured = Boolean(
      (env as unknown as { VAPID_PRIVATE_KEY?: string }).VAPID_PRIVATE_KEY,
    );

    return json({
      success: true,
      data: {
        push_enabled: cfg['push_enabled']?.value === '1',
        vapid_public_key: cfg['vapid_public_key']?.value ?? '',
        vapid_subject: cfg['vapid_subject']?.value ?? '',
        vapid_private_key_configured: privateKeyConfigured,
        last_updated: cfg['push_enabled']?.updated_at ?? null,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// PUT /api/admin/push/config — super_admin only
// Flip push_enabled or update subject / public_key (e.g. for key rotation
// done out-of-band).
export async function handleUpdatePushConfig(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as UpdateConfigBody;
    const now = new Date().toISOString();

    if (body.enabled !== undefined) {
      await env.DB.prepare(`
        INSERT INTO platform_config (key, value, updated_at) VALUES ('push_enabled', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(body.enabled ? '1' : '0', now).run();
    }
    if (body.subject !== undefined) {
      await env.DB.prepare(`
        INSERT INTO platform_config (key, value, updated_at) VALUES ('vapid_subject', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(body.subject, now).run();
    }
    if (body.public_key !== undefined) {
      await env.DB.prepare(`
        INSERT INTO platform_config (key, value, updated_at) VALUES ('vapid_public_key', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(body.public_key, now).run();
    }

    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/admin/push/test — super_admin only
// Sends a test push to the calling admin's own subscriptions. Bypasses the
// per-event prefs + quiet hours, but still respects platform_config.push_enabled.
// Returns a per-device delivery result so the operator can see which devices
// fired (or failed and why).
export async function handlePushTest(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const cfg = await getPushConfig(env);
    if (!cfg) {
      return json({
        success: false,
        error: "push_enabled is off, or VAPID keys are not fully configured (public + subject in platform_config, private as VAPID_PRIVATE_KEY secret)",
      }, 400, origin);
    }

    const result = await dispatchPush(env, userId, {
      title: "Averrow test notification",
      body: "If you see this, push delivery is working end-to-end.",
      url: "/v2/observatory",
      tag: "averrow-test",
      severity: "info",
      type: "test",
    });

    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "An internal error occurred",
    }, 500, origin);
  }
}
