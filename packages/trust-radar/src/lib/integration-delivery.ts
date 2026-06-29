/**
 * Integration delivery engine — data-out to customer SIEM/SOAR/ticketing.
 *
 * Turns the org_integrations credential store into an actual delivery
 * engine: given a platform event for an org, fan it out to every connected,
 * deliverable integration the org has configured, recording an auditable
 * outcome row per attempt (integration_deliveries).
 *
 * Best-effort + fully isolated: a failing or misconfigured integration
 * records a failed delivery and NEVER throws into the producer. Add a
 * connector + its type to DELIVERABLE_INTEGRATION_TYPES to support a new
 * destination (Sentinel, QRadar, Jira, ServiceNow next).
 */

import type { Env } from "../types";
import type { WebhookEventType } from "./webhooks";
import { decryptConfig } from "./integration-secret";
import {
  parseSplunkConfig,
  deliverToSplunk,
  type ConnectorResult,
  type OutboundEvent,
} from "./integrations/splunk";

/** org_integrations.type values that have an outbound connector. */
export const DELIVERABLE_INTEGRATION_TYPES = new Set<string>(["splunk"]);

interface IntegrationRow {
  id: string;
  type: string;
  name: string;
  config_encrypted: string | null;
}

async function dispatchToConnector(
  type: string,
  config: Record<string, unknown> | null,
  event: OutboundEvent,
): Promise<ConnectorResult> {
  switch (type) {
    case "splunk": {
      const cfg = parseSplunkConfig(config);
      if (!cfg) return { ok: false, error: "Splunk config missing hec_url/hec_token" };
      return deliverToSplunk(cfg, event);
    }
    default:
      return { ok: false, error: `No connector for integration type '${type}'` };
  }
}

/**
 * Deliver one platform event to all of an org's connected, deliverable
 * integrations. Never throws — failures are logged to integration_deliveries.
 */
export async function deliverToIntegrations(
  env: Env,
  orgId: number,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  let rows: IntegrationRow[];
  try {
    const types = Array.from(DELIVERABLE_INTEGRATION_TYPES);
    const placeholders = types.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT id, type, name, config_encrypted
       FROM org_integrations
       WHERE org_id = ? AND status = 'connected' AND type IN (${placeholders})`,
    ).bind(orgId, ...types).all<IntegrationRow>();
    rows = res.results;
  } catch {
    return; // org_integrations unavailable — never block the producer
  }
  if (rows.length === 0) return;

  const event: OutboundEvent = {
    event: eventType,
    timestamp: new Date().toISOString(),
    org_id: orgId,
    data,
  };

  for (const row of rows) {
    let result: ConnectorResult;
    try {
      const config = await decryptConfig(env, row.config_encrypted);
      result = await dispatchToConnector(row.type, config, event);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await recordDelivery(env, row, orgId, eventType, result);
  }
}

async function recordDelivery(
  env: Env,
  row: IntegrationRow,
  orgId: number,
  eventType: string,
  result: ConnectorResult,
): Promise<void> {
  const errText = result.ok ? null : (result.error ?? "delivery failed").slice(0, 500);
  try {
    await env.DB.prepare(`
      INSERT INTO integration_deliveries
        (integration_id, org_id, event_type, status, http_status, error, payload_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.id,
      orgId,
      eventType,
      result.ok ? "delivered" : "failed",
      result.httpStatus ?? null,
      errText,
      `${row.type}:${eventType}`,
    ).run();

    if (result.ok) {
      await env.DB.prepare(
        "UPDATE org_integrations SET events_sent = events_sent + 1, last_sync_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = ?",
      ).bind(row.id).run();
    } else {
      await env.DB.prepare(
        "UPDATE org_integrations SET last_error = ?, updated_at = datetime('now') WHERE id = ?",
      ).bind(errText, row.id).run();
    }
  } catch {
    // best-effort observability — never throw into the delivery loop
  }
}

/**
 * Send a synthetic test event to one integration (test-connection endpoint).
 * Does not write a delivery row — it's an interactive check, not a real event.
 */
export async function testIntegrationConnection(
  env: Env,
  type: string,
  config_encrypted: string | null,
): Promise<ConnectorResult> {
  if (!DELIVERABLE_INTEGRATION_TYPES.has(type)) {
    return { ok: false, error: `Connection testing not implemented for '${type}'` };
  }
  let config: Record<string, unknown> | null;
  try {
    config = await decryptConfig(env, config_encrypted);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return dispatchToConnector(type, config, {
    event: "test",
    timestamp: new Date().toISOString(),
    org_id: 0,
    data: { message: "Averrow integration test event" },
  });
}
