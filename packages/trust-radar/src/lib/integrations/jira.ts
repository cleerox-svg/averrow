/**
 * Jira (Atlassian Cloud) ticketing connector — open-on-detection,
 * close-on-resolution, for a compliance record of takedowns.
 *
 * Uses the v2 REST API (plain-text descriptions; v3 requires ADF).
 * Auth is Basic email:api_token (Atlassian API token).
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

export interface JiraConfig {
  base_url: string; // https://yourco.atlassian.net
  email: string;
  api_token: string;
  project_key: string;
  issue_type: string;
  done_transition_id?: string;
}

export function parseJiraConfig(config: Record<string, unknown> | null): JiraConfig | null {
  if (!config) return null;
  const base_url = strField(config.base_url);
  const email = strField(config.email);
  const api_token = strField(config.api_token);
  const project_key = strField(config.project_key);
  if (!base_url || !email || !api_token || !project_key) return null;
  return {
    base_url: base_url.replace(/\/+$/, ""),
    email,
    api_token,
    project_key,
    issue_type: strField(config.issue_type) ?? "Task",
    done_transition_id: strField(config.done_transition_id) ?? undefined,
  };
}

function authHeader(cfg: JiraConfig): string {
  return "Basic " + btoa(`${cfg.email}:${cfg.api_token}`);
}

async function errText(res: Response, prefix: string): Promise<string> {
  let detail = "";
  try {
    const j = (await res.json()) as { errorMessages?: string[]; errors?: Record<string, string> };
    if (j?.errorMessages?.length) detail = ` — ${j.errorMessages.join("; ")}`;
    else if (j?.errors) detail = ` — ${Object.values(j.errors).join("; ")}`;
  } catch {
    /* non-JSON */
  }
  return `${prefix} HTTP ${res.status}${detail}`.slice(0, 500);
}

export async function createJiraIssue(
  cfg: JiraConfig,
  ticket: TicketContext,
): Promise<TicketCreateResult> {
  const guard = validateOutboundWebhookUrl(cfg.base_url);
  if (!guard.ok) return { ok: false, error: `Jira base URL rejected: ${guard.reason}` };

  const res = await timedFetch(`${cfg.base_url}/rest/api/2/issue`, {
    method: "POST",
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: cfg.project_key },
        summary: ticket.summary.slice(0, 250),
        description: ticket.description,
        issuetype: { name: cfg.issue_type },
      },
    }),
  });
  if (!res) return { ok: false, error: "Jira create request timed out" };
  if (res.ok) {
    const j = (await res.json().catch(() => ({}))) as { key?: string };
    const key = j.key ?? "";
    return {
      ok: true,
      httpStatus: res.status,
      externalKey: key,
      externalUrl: key ? `${cfg.base_url}/browse/${key}` : undefined,
    };
  }
  return { ok: false, httpStatus: res.status, error: await errText(res, "Jira create") };
}

export async function closeJiraIssue(
  cfg: JiraConfig,
  issueKey: string,
): Promise<TicketCloseResult> {
  let transitionId = cfg.done_transition_id ?? null;

  if (!transitionId) {
    const t = await timedFetch(
      `${cfg.base_url}/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
      { method: "GET", headers: { Authorization: authHeader(cfg), Accept: "application/json" } },
    );
    if (t && t.ok) {
      const data = (await t.json().catch(() => ({}))) as {
        transitions?: Array<{ id: string; name: string }>;
      };
      const match = (data.transitions ?? []).find((tr) => /done|closed|resolve/i.test(tr.name));
      transitionId = match?.id ?? null;
    }
  }
  if (!transitionId) {
    return { ok: false, error: "No Done/Closed/Resolved transition available (set done_transition_id)" };
  }

  const res = await timedFetch(
    `${cfg.base_url}/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
    {
      method: "POST",
      headers: { Authorization: authHeader(cfg), "Content-Type": "application/json" },
      body: JSON.stringify({ transition: { id: transitionId } }),
    },
  );
  if (!res) return { ok: false, error: "Jira transition request timed out" };
  if (res.ok) return { ok: true, httpStatus: res.status };
  return { ok: false, httpStatus: res.status, error: await errText(res, "Jira transition") };
}

export async function testJiraConnection(cfg: JiraConfig): Promise<ConnectorTestResult> {
  const guard = validateOutboundWebhookUrl(cfg.base_url);
  if (!guard.ok) return { ok: false, error: `Jira base URL rejected: ${guard.reason}` };
  const res = await timedFetch(`${cfg.base_url}/rest/api/2/myself`, {
    method: "GET",
    headers: { Authorization: authHeader(cfg), Accept: "application/json" },
  });
  if (!res) return { ok: false, error: "Jira request timed out" };
  if (res.ok) return { ok: true, httpStatus: res.status };
  return { ok: false, httpStatus: res.status, error: await errText(res, "Jira auth") };
}
