// POST /api/stripe/webhook
//
// Public, unauthenticated, signature-verified. Stripe POSTs lifecycle
// events here; we map them onto organizations + org_modules state
// (see lib/stripe-events.ts). Idempotent via stripe_webhook_events
// (see migration 0154).
//
// Auth model: env.STRIPE_WEBHOOK_SECRET must be set as a Worker
// secret. Without it the endpoint returns 503 (server not
// configured) so missing-secret in dev fails loudly instead of
// quietly accepting any request. Stripe retries on non-2xx so an
// unconfigured prod would also retry and operator notices via
// Stripe dashboard's webhook delivery log.
//
// v3 Phase D Stripe sprint 4.

import { json } from "../lib/cors";
import type { Env } from "../types";
import { verifyStripeSignature } from "../lib/stripe-signature";
import {
  syncOrgFromSubscription,
  cancelOrgFromSubscription,
  markOrgPastDue,
  clearOrgPastDue,
  type StripeEvent,
  type StripeSubscription,
  type StripeInvoice,
} from "../lib/stripe-events";

const RAW_PAYLOAD_PREFIX_LIMIT = 4096;

export async function handleStripeWebhook(
  request: Request,
  env:     Env,
): Promise<Response> {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return json({
      success: false,
      error: "Stripe webhook is not configured. Set STRIPE_WEBHOOK_SECRET in Worker secrets.",
    }, 503, null);
  }

  // Read the raw body BEFORE parsing — signature verification
  // hashes the bytes Stripe actually sent, not our re-serialization.
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("Stripe-Signature");

  const verify = await verifyStripeSignature(rawBody, signatureHeader, secret);
  if (!verify.ok) {
    return json({
      success: false,
      error: `Signature verification failed: ${verify.reason ?? "unknown"}`,
    }, 400, null);
  }

  // Parse only after the signature passes.
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, null);
  }

  if (!event.id || !event.type) {
    return json({ success: false, error: "Missing event id or type" }, 400, null);
  }

  // Idempotency: refuse re-delivery quickly with 200 so Stripe
  // doesn't keep retrying.
  const existing = await env.DB.prepare(
    `SELECT event_id, status FROM stripe_webhook_events WHERE event_id = ?`,
  ).bind(event.id).first<{ event_id: string; status: string }>();
  if (existing) {
    return json({
      success: true,
      data: { event_id: event.id, status: existing.status, idempotent_replay: true },
    }, 200, null);
  }

  // Audit row at received_at; we update status + processed_at as
  // we go through the handler.
  await env.DB.prepare(
    `INSERT INTO stripe_webhook_events
       (event_id, event_type, api_version, livemode, raw_payload)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    event.id,
    event.type,
    event.api_version ?? null,
    event.livemode ? 1 : 0,
    rawBody.slice(0, RAW_PAYLOAD_PREFIX_LIMIT),
  ).run();

  let resolvedOrgId: number | null = null;
  let status: "processed" | "noop" | "failed" = "noop";
  let errorMessage: string | null = null;

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as StripeSubscription;
        const result = await syncOrgFromSubscription(env, sub);
        if (result) {
          resolvedOrgId = result.org_id;
          status = "processed";
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as StripeSubscription;
        const result = await cancelOrgFromSubscription(env, sub);
        if (result) {
          resolvedOrgId = result.org_id;
          status = "processed";
        }
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as StripeInvoice;
        const result = await markOrgPastDue(env, inv.customer);
        if (result) {
          resolvedOrgId = result.org_id;
          status = "processed";
        }
        break;
      }
      case "invoice.payment_succeeded": {
        const inv = event.data.object as StripeInvoice;
        const result = await clearOrgPastDue(env, inv.customer);
        if (result) {
          resolvedOrgId = result.org_id;
          status = "processed";
        }
        break;
      }
      default:
        // Event type we don't act on — still record for audit, mark
        // as noop. Includes things like customer.created, charge.*,
        // payout.* etc.
        status = "noop";
    }
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  await env.DB.prepare(
    `UPDATE stripe_webhook_events
     SET status = ?, org_id = ?, error = ?, processed_at = datetime('now')
     WHERE event_id = ?`,
  ).bind(status, resolvedOrgId, errorMessage, event.id).run();

  if (status === "failed") {
    // 500 forces Stripe to retry; the audit row keeps the error
    // message for ops to investigate.
    return json({
      success: false,
      error: `Handler failed: ${errorMessage}`,
    }, 500, null);
  }

  return json({
    success: true,
    data: {
      event_id: event.id,
      status,
      org_id:   resolvedOrgId,
    },
  }, 200, null);
}
