/**
 * Integration delivery engine — data-out to customer SIEM/SOAR/ticketing.
 *
 * Two delivery modes:
 *   • push (Splunk, …): fire every platform event at the destination.
 *   • ticketing (Jira, ServiceNow): open a ticket on detection and close it
 *     on resolution, keyed on the underlying object (a takedown), for an
 *     auditable compliance record.
 *
 * Best-effort + fully isolated: a failing or misconfigured integration
 * records a failed delivery and NEVER throws into the producer.
 */

import type { Env } from "../types";
import type { WebhookEventType } from "./webhooks";
import { decryptConfig } from "./integration-secret";
import type { ConnectorResult, OutboundEvent } from "./integrations/push-types";
import { parseSplunkConfig, deliverToSplunk } from "./integrations/splunk";
import { parseSentinelConfig, deliverToSentinel } from "./integrations/sentinel";
import { parseQRadarConfig, deliverToQRadar } from "./integrations/qradar";
import {
  parseJiraConfig,
  createJiraIssue,
  closeJiraIssue,
  testJiraConnection,
} from "./integrations/jira";
import {
  parseServiceNowConfig,
  createServiceNowIncident,
  closeServiceNowIncident,
  testServiceNowConnection,
} from "./integrations/servicenow";
import type {
  TicketContext,
  TicketCreateResult,
  TicketCloseResult,
} from "./integrations/ticketing-types";

/** Push connectors — fire each event. */
export const DELIVERABLE_INTEGRATION_TYPES = new Set<string>(["splunk", "sentinel", "qradar"]);
/** Ticketing connectors — open-on-detection, close-on-resolution. */
export const TICKETING_INTEGRATION_TYPES = new Set<string>(["jira", "servicenow"]);
/** All org_integrations.type values that have a connector. */
export const CONNECTOR_INTEGRATION_TYPES = new Set<string>([
  ...DELIVERABLE_INTEGRATION_TYPES,
  ...TICKETING_INTEGRATION_TYPES,
]);

/** Takedown statuses that mean "done" → close the ticket. */
const TERMINAL_TAKEDOWN_STATUSES = new Set(["taken_down", "failed", "expired", "withdrawn"]);

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
    case "sentinel": {
      const cfg = parseSentinelConfig(config);
      if (!cfg) return { ok: false, error: "Sentinel config missing/invalid workspace_id/shared_key" };
      return deliverToSentinel(cfg, event);
    }
    case "qradar": {
      const cfg = parseQRadarConfig(config);
      if (!cfg) return { ok: false, error: "QRadar config missing receiver_url" };
      return deliverToQRadar(cfg, event);
    }
    default:
      return { ok: false, error: `No connector for integration type '${type}'` };
  }
}

/** Max push attempts (1 try + 2 retries) for transient failures. */
const MAX_PUSH_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Deliver a push event with bounded retry/backoff. Retries only on
 * transient failures (network/timeout/429/5xx — `result.retryable`); 4xx
 * config/auth errors fail fast. Returns the final result plus the attempt
 * count for the delivery log.
 */
async function dispatchWithRetry(
  type: string,
  config: Record<string, unknown> | null,
  event: OutboundEvent,
): Promise<{ result: ConnectorResult; attempts: number }> {
  let result: ConnectorResult = { ok: false, error: "not attempted" };
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    result = await dispatchToConnector(type, config, event);
    if (result.ok || !result.retryable) return { result, attempts: attempt };
    if (attempt < MAX_PUSH_ATTEMPTS) {
      // 400ms, 1200ms backoff — bounded so a slow sink can't blow the worker budget.
      await sleep(attempt * attempt * 400);
    }
  }
  return { result, attempts: MAX_PUSH_ATTEMPTS };
}

/**
 * Deliver one platform event to all of an org's connected integrations
 * (push + ticketing). Never throws — outcomes are logged to
 * integration_deliveries.
 */
export async function deliverToIntegrations(
  env: Env,
  orgId: number,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  let rows: IntegrationRow[];
  try {
    const types = Array.from(CONNECTOR_INTEGRATION_TYPES);
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
    if (TICKETING_INTEGRATION_TYPES.has(row.type)) {
      await handleTicketingEvent(env, row, orgId, eventType, data);
      continue;
    }
    let result: ConnectorResult;
    let attempts = 1;
    try {
      const config = await decryptConfig(env, row.config_encrypted);
      const out = await dispatchWithRetry(row.type, config, event);
      result = out.result;
      attempts = out.attempts;
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await recordDelivery(env, row, orgId, eventType, result, attempts);
  }
}

// ─── Ticketing ────────────────────────────────────────────────────

interface TakedownTicketRow {
  status: string;
  target_value: string;
  target_url: string | null;
  severity: string;
  evidence_summary: string | null;
  brand_id: string | null;
}

interface TicketLinkRow {
  id: string;
  external_key: string;
  status: string;
}

/**
 * Open-on-detection / close-on-resolution for ticketing integrations.
 * v1 scope: takedowns (the natural compliance object). The event carries a
 * takedown_id; we read the takedown's current state and either open a ticket
 * (first time we see an active takedown) or close it (terminal state).
 */
async function handleTicketingEvent(
  env: Env,
  row: IntegrationRow,
  orgId: number,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  if (eventType !== "takedown.status_changed") return;
  const takedownId = typeof data.takedown_id === "string" ? data.takedown_id : null;
  if (!takedownId) return;

  let td: TakedownTicketRow | null;
  let existing: TicketLinkRow | null;
  try {
    td = await env.DB.prepare(
      `SELECT status, target_value, target_url, severity, evidence_summary, brand_id
       FROM takedown_requests WHERE id = ?`,
    ).bind(takedownId).first<TakedownTicketRow>();
    existing = await env.DB.prepare(
      `SELECT id, external_key, status FROM integration_tickets
       WHERE integration_id = ? AND source_type = 'takedown' AND source_id = ?`,
    ).bind(row.id, takedownId).first<TicketLinkRow>();
  } catch {
    return;
  }
  if (!td) return;

  const terminal = TERMINAL_TAKEDOWN_STATUSES.has(td.status);

  // OPEN: first time we see this (active) takedown.
  if (!existing && !terminal) {
    const ticket: TicketContext = {
      summary: `Averrow takedown — ${td.target_value} (${td.severity})`,
      description:
        `${td.evidence_summary ?? "Malicious infrastructure detected by Averrow."}\n\n` +
        `Target: ${td.target_url ?? td.target_value}\n` +
        `Severity: ${td.severity}\nStatus: ${td.status}\n` +
        `Tracked by Averrow. Takedown ID: ${takedownId}.`,
      severity: td.severity,
    };
    let result: TicketCreateResult;
    try {
      const config = await decryptConfig(env, row.config_encrypted);
      result = await createTicket(row.type, config, ticket);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok && result.externalKey) {
      try {
        await env.DB.prepare(`
          INSERT INTO integration_tickets
            (integration_id, org_id, source_type, source_id, external_key, external_url, status)
          VALUES (?, ?, 'takedown', ?, ?, ?, 'open')
          ON CONFLICT (integration_id, source_type, source_id) DO NOTHING
        `).bind(row.id, orgId, takedownId, result.externalKey, result.externalUrl ?? null).run();
      } catch {
        /* best-effort link */
      }
    }
    await recordDelivery(env, row, orgId, "ticket.opened", result);
    return;
  }

  // CLOSE: takedown resolved and we have an open ticket.
  if (existing && existing.status === "open" && terminal) {
    let result: TicketCloseResult;
    try {
      const config = await decryptConfig(env, row.config_encrypted);
      result = await closeTicket(row.type, config, existing.external_key);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) {
      try {
        await env.DB.prepare(
          "UPDATE integration_tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?",
        ).bind(existing.id).run();
      } catch {
        /* best-effort */
      }
    }
    await recordDelivery(env, row, orgId, "ticket.closed", result);
  }
}

async function createTicket(
  type: string,
  config: Record<string, unknown> | null,
  ticket: TicketContext,
): Promise<TicketCreateResult> {
  switch (type) {
    case "jira": {
      const cfg = parseJiraConfig(config);
      if (!cfg) return { ok: false, error: "Jira config incomplete (base_url/email/api_token/project_key)" };
      return createJiraIssue(cfg, ticket);
    }
    case "servicenow": {
      const cfg = parseServiceNowConfig(config);
      if (!cfg) return { ok: false, error: "ServiceNow config incomplete (instance_url/username/password)" };
      return createServiceNowIncident(cfg, ticket);
    }
    default:
      return { ok: false, error: `No ticketing connector for '${type}'` };
  }
}

async function closeTicket(
  type: string,
  config: Record<string, unknown> | null,
  externalKey: string,
): Promise<TicketCloseResult> {
  switch (type) {
    case "jira": {
      const cfg = parseJiraConfig(config);
      if (!cfg) return { ok: false, error: "Jira config incomplete" };
      return closeJiraIssue(cfg, externalKey);
    }
    case "servicenow": {
      const cfg = parseServiceNowConfig(config);
      if (!cfg) return { ok: false, error: "ServiceNow config incomplete" };
      return closeServiceNowIncident(cfg, externalKey);
    }
    default:
      return { ok: false, error: `No ticketing connector for '${type}'` };
  }
}

// ─── Delivery log ─────────────────────────────────────────────────

async function recordDelivery(
  env: Env,
  row: IntegrationRow,
  orgId: number,
  eventType: string,
  result: ConnectorResult,
  attempts = 1,
): Promise<void> {
  const errText = result.ok ? null : (result.error ?? "delivery failed").slice(0, 500);
  try {
    await env.DB.prepare(`
      INSERT INTO integration_deliveries
        (integration_id, org_id, event_type, status, http_status, error, attempts, payload_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.id,
      orgId,
      eventType,
      result.ok ? "delivered" : "failed",
      result.httpStatus ?? null,
      errText,
      attempts,
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
 * Live connection test for one integration (test-connection endpoint).
 * Does not write a delivery row — it's an interactive check.
 */
export async function testIntegrationConnection(
  env: Env,
  type: string,
  config_encrypted: string | null,
): Promise<ConnectorResult> {
  if (!CONNECTOR_INTEGRATION_TYPES.has(type)) {
    return { ok: false, error: `Connection testing not implemented for '${type}'` };
  }
  let config: Record<string, unknown> | null;
  try {
    config = await decryptConfig(env, config_encrypted);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  switch (type) {
    case "jira": {
      const cfg = parseJiraConfig(config);
      if (!cfg) return { ok: false, error: "Jira config incomplete" };
      return testJiraConnection(cfg);
    }
    case "servicenow": {
      const cfg = parseServiceNowConfig(config);
      if (!cfg) return { ok: false, error: "ServiceNow config incomplete" };
      return testServiceNowConnection(cfg);
    }
    default:
      // push connectors: a synthetic event POST.
      return dispatchToConnector(type, config, {
        event: "test",
        timestamp: new Date().toISOString(),
        org_id: 0,
        data: { message: "Averrow integration test event" },
      });
  }
}
