/**
 * Unified org-event fan-out.
 *
 * One platform event (alert.created, takedown.status_changed, …) often needs
 * to reach more than one customer destination: their webhook endpoint AND any
 * SIEM/SOAR integrations they've connected. Producers call emitOrgEvent so
 * every data-out path is driven from a single place instead of each producer
 * knowing about webhooks vs integrations.
 *
 * Best-effort: both paths swallow their own errors, and Promise.allSettled
 * ensures one failing destination never blocks the other or the producer.
 */

import type { Env } from "../types";
import { deliverWebhook, type WebhookEventType } from "./webhooks";
import { deliverToIntegrations } from "./integration-delivery";

export async function emitOrgEvent(
  env: Env,
  orgId: number,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  await Promise.allSettled([
    deliverWebhook(env, orgId, eventType, data),
    deliverToIntegrations(env, orgId, eventType, data),
  ]);
}
