/**
 * ServiceNow ticketing connector — open-on-detection, close-on-resolution,
 * for a compliance record of takedowns.
 *
 * Uses the Table API (default table: incident). Auth is Basic
 * username:password (a dedicated integration user is recommended).
 */

import { validateOutboundWebhookUrl } from "../url-guard";
import {
  type TicketContext,
  type TicketCreateResult,
  type TicketCloseResult,
  type ConnectorTestResult,
  timedFetch,
  strField,
} from "./ticketing-types";

export interface ServiceNowConfig {
  instance_url: string; // https://yourco.service-now.com
  username: string;
  password: string;
  table: string; // default 'incident'
}

export function parseServiceNowConfig(config: Record<string, unknown> | null): ServiceNowConfig | null {
  if (!config) return null;
  const instance_url = strField(config.instance_url);
  const username = strField(config.username);
  const password = strField(config.password);
  if (!instance_url || !username || !password) return null;
  return {
    instance_url: instance_url.replace(/\/+$/, ""),
    username,
    password,
    table: strField(config.table) ?? "incident",
  };
}

function authHeader(cfg: ServiceNowConfig): string {
  return "Basic " + btoa(`${cfg.username}:${cfg.password}`);
}

async function errText(res: Response, prefix: string): Promise<string> {
  let detail = "";
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    if (j?.error?.message) detail = ` — ${j.error.message}`;
  } catch {
    /* non-JSON */
  }
  return `${prefix} HTTP ${res.status}${detail}`.slice(0, 500);
}

// ServiceNow incident severity → impact/urgency (1 high … 3 low).
function snowPriority(severity?: string): string {
  switch ((severity ?? "").toUpperCase()) {
    case "CRITICAL": return "1";
    case "HIGH": return "2";
    default: return "3";
  }
}

export async function createServiceNowIncident(
  cfg: ServiceNowConfig,
  ticket: TicketContext,
): Promise<TicketCreateResult> {
  const guard = validateOutboundWebhookUrl(cfg.instance_url);
  if (!guard.ok) return { ok: false, error: `ServiceNow URL rejected: ${guard.reason}` };

  const impact = snowPriority(ticket.severity);
  const res = await timedFetch(`${cfg.instance_url}/api/now/table/${encodeURIComponent(cfg.table)}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      short_description: ticket.summary.slice(0, 160),
      description: ticket.description,
      impact,
      urgency: impact,
    }),
  });
  if (!res) return { ok: false, error: "ServiceNow create request timed out" };
  if (res.ok) {
    const j = (await res.json().catch(() => ({}))) as { result?: { sys_id?: string } };
    const sysId = j.result?.sys_id ?? "";
    return {
      ok: true,
      httpStatus: res.status,
      externalKey: sysId,
      externalUrl: sysId
        ? `${cfg.instance_url}/nav_to.do?uri=${encodeURIComponent(cfg.table)}.do?sys_id=${sysId}`
        : undefined,
    };
  }
  return { ok: false, httpStatus: res.status, error: await errText(res, "ServiceNow create") };
}

export async function closeServiceNowIncident(
  cfg: ServiceNowConfig,
  sysId: string,
): Promise<TicketCloseResult> {
  const res = await timedFetch(
    `${cfg.instance_url}/api/now/table/${encodeURIComponent(cfg.table)}/${encodeURIComponent(sysId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: authHeader(cfg),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      // state 6 = Resolved. close_code/notes are required to resolve incidents.
      body: JSON.stringify({
        state: "6",
        close_code: "Resolved by caller",
        close_notes: "Resolved automatically by Averrow — the related takedown reached a terminal state.",
      }),
    },
  );
  if (!res) return { ok: false, error: "ServiceNow resolve request timed out" };
  if (res.ok) return { ok: true, httpStatus: res.status };
  return { ok: false, httpStatus: res.status, error: await errText(res, "ServiceNow resolve") };
}

export async function testServiceNowConnection(cfg: ServiceNowConfig): Promise<ConnectorTestResult> {
  const guard = validateOutboundWebhookUrl(cfg.instance_url);
  if (!guard.ok) return { ok: false, error: `ServiceNow URL rejected: ${guard.reason}` };
  const res = await timedFetch(
    `${cfg.instance_url}/api/now/table/${encodeURIComponent(cfg.table)}?sysparm_limit=1`,
    { method: "GET", headers: { Authorization: authHeader(cfg), Accept: "application/json" } },
  );
  if (!res) return { ok: false, error: "ServiceNow request timed out" };
  if (res.ok) return { ok: true, httpStatus: res.status };
  return { ok: false, httpStatus: res.status, error: await errText(res, "ServiceNow auth") };
}
