/**
 * Webhook Delivery Engine — Phase D
 *
 * Delivers signed webhook events to org-configured endpoints.
 * HMAC-SHA256 signature in X-Trust-Radar-Signature header.
 *
 * Payload format is intentionally flat JSON compatible with:
 * Splunk HEC, Elastic, Microsoft Sentinel, and generic webhook receivers.
 */

import type { Env } from "../types";
import { validateOutboundWebhookUrl } from "./url-guard";

// ─── Event Types ─────────────────────────────────────────────

export type WebhookEventType =
  | "alert.created"
  | "alert.status_changed"
  | "takedown.status_changed"
  | "threat.detected"
  | "email_grade.changed"
  | "social_profile.discovered"
  | "test";

// ─── HMAC Signing ────────────────────────────────────────────

async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Delivery ────────────────────────────────────────────────

export async function deliverWebhook(
  env: Env,
  orgId: number,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    // 1. Look up org webhook config
    const org = await env.DB.prepare(
      "SELECT webhook_url, webhook_secret, webhook_events, name FROM organizations WHERE id = ?",
    )
      .bind(orgId)
      .first<{
        webhook_url: string | null;
        webhook_secret: string | null;
        webhook_events: string | null;
        name: string;
      }>();

    if (!org || !org.webhook_url) return false;

    // SSRF guard (audit M1, defense in depth): the URL is validated at
    // config-write time, but stored values may predate the guard.
    if (!validateOutboundWebhookUrl(org.webhook_url).ok) return false;

    // 2. Check event subscription
    if (org.webhook_events) {
      try {
        const subscribedEvents: string[] = JSON.parse(org.webhook_events);
        if (subscribedEvents.length > 0 && !subscribedEvents.includes(eventType)) {
          return false; // Not subscribed to this event type
        }
      } catch {
        // Invalid JSON — deliver anyway
      }
    }

    // 3. Build payload envelope
    const deliveryId = crypto.randomUUID();
    const envelope = {
      event: eventType,
      timestamp: new Date().toISOString(),
      delivery_id: deliveryId,
      org_id: orgId,
      org_name: org.name,
      data,
    };

    const body = JSON.stringify(envelope);

    // 4. Sign payload
    const signature = org.webhook_secret
      ? await signPayload(body, org.webhook_secret)
      : "";

    // 5. POST to webhook URL
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(org.webhook_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Trust-Radar-Signature": `sha256=${signature}`,
          "X-Trust-Radar-Event": eventType,
          "X-Trust-Radar-Delivery": deliveryId,
          "User-Agent": "TrustRadar-Webhook/1.0",
        },
        body,
        signal: controller.signal,
        // Never follow redirects — a "public" endpoint must not be able
        // to bounce the signed payload to an internal address (M1).
        redirect: "manual",
      });

      clearTimeout(timeout);

      if (response.ok) {
        // Success — update last_success
        await env.DB.prepare(
          "UPDATE organizations SET webhook_last_success = datetime('now') WHERE id = ?",
        )
          .bind(orgId)
          .run();
        return true;
      }

      // Non-2xx response — record failure
      await env.DB.prepare(
        "UPDATE organizations SET webhook_last_failure = datetime('now'), webhook_failures_24h = webhook_failures_24h + 1 WHERE id = ?",
      )
        .bind(orgId)
        .run();
      return false;
    } catch {
      clearTimeout(timeout);
      // Network error or timeout
      await env.DB.prepare(
        "UPDATE organizations SET webhook_last_failure = datetime('now'), webhook_failures_24h = webhook_failures_24h + 1 WHERE id = ?",
      )
        .bind(orgId)
        .run();
      return false;
    }
  } catch {
    // DB error looking up org — fail silently
    return false;
  }
}

// ─── Test Webhook ────────────────────────────────────────────

export async function sendTestWebhook(
  env: Env,
  orgId: number,
): Promise<{ success: boolean; status?: number; error?: string }> {
  const org = await env.DB.prepare(
    "SELECT webhook_url, webhook_secret, name FROM organizations WHERE id = ?",
  )
    .bind(orgId)
    .first<{ webhook_url: string | null; webhook_secret: string | null; name: string }>();

  if (!org?.webhook_url) {
    return { success: false, error: "No webhook URL configured" };
  }

  // SSRF guard (audit M1, defense in depth): re-validate stored URL.
  const guard = validateOutboundWebhookUrl(org.webhook_url);
  if (!guard.ok) {
    return { success: false, error: `Webhook URL rejected: ${guard.reason}` };
  }

  const deliveryId = crypto.randomUUID();
  const envelope = {
    event: "test" as const,
    timestamp: new Date().toISOString(),
    delivery_id: deliveryId,
    org_id: orgId,
    org_name: org.name,
    data: {
      message: "This is a test webhook from Averrow",
      org_name: org.name,
    },
  };

  const body = JSON.stringify(envelope);
  const signature = org.webhook_secret
    ? await signPayload(body, org.webhook_secret)
    : "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(org.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trust-Radar-Signature": `sha256=${signature}`,
        "X-Trust-Radar-Event": "test",
        "X-Trust-Radar-Delivery": deliveryId,
        "User-Agent": "TrustRadar-Webhook/1.0",
      },
      body,
      signal: controller.signal,
      // Never follow redirects (M1) — see deliverWebhook.
      redirect: "manual",
    });

    clearTimeout(timeout);

    if (response.ok) {
      await env.DB.prepare(
        "UPDATE organizations SET webhook_last_success = datetime('now') WHERE id = ?",
      )
        .bind(orgId)
        .run();
    }

    return { success: response.ok, status: response.status };
  } catch (err) {
    clearTimeout(timeout);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Request failed",
    };
  }
}
