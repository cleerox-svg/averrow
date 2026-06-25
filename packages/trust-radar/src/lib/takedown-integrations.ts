// Takedown Integration Health — aggregates takedown_submissions by submitter
// "kind" into a per-integration health rollup (NetBeacon, GoDaddy, Web Risk,
// the email channels), merged with each integration's live config state
// (credential present? operator auto-submit gate on? global send mode?).
//
// This is the data behind the Ops "Integrations" view and answers, at a
// glance: is this integration configured, is it live, and how is it doing —
// submissions / success rate / last submission / last error over a window.
//
// Adding a new submitter automatically shows up here: register its kind in
// REGISTRY below (and give the submitter an isConfigured()). No per-provider
// dashboard wiring needed.

import type { Env } from "../types";
import { SUBMITTERS } from "./takedown-submitters";
import { isLiveSendMode } from "./takedown-submitters/email-send";

export type IntegrationStatus =
  | "live"          // configured + enabled + live send mode
  | "paused"        // configured + enabled, but global send mode is draft
  | "disabled"      // configured, operator auto-submit gate is off
  | "active"        // email-draft channels — always works, records intent
  | "unconfigured"; // credential/transport missing

export interface IntegrationHealth {
  kind:                string;
  label:               string;
  channel:             "api" | "email";
  api_type:            string | null;
  provider_name:       string | null;
  configured:          boolean;
  auto_submit_enabled: boolean | null; // null for email channels (no per-provider gate)
  status:              IntegrationStatus;
  total:               number;
  submitted:           number;
  queued:              number;
  rejected:            number;
  failed:              number;
  success_rate:        number | null;  // 0-100, over submitted+rejected+failed; null if none
  last_submission_at:  string | null;
  last_error:          string | null;
}

export interface IntegrationsReport {
  window_hours:  number;
  send_mode:     "live" | "draft";
  integrations:  IntegrationHealth[];
}

interface IntegrationMeta {
  kind:     string;
  label:    string;
  channel:  "api" | "email";
  api_type: string | null; // matches takedown_providers.abuse_api_type for API kinds
}

// Display registry. Order = display order. API integrations first.
const REGISTRY: IntegrationMeta[] = [
  { kind: "api_netbeacon",       label: "NetBeacon",              channel: "api",   api_type: "netbeacon" },
  { kind: "api_godaddy",         label: "GoDaddy Abuse API",      channel: "api",   api_type: "godaddy" },
  { kind: "api_web_risk",        label: "Google Web Risk",        channel: "api",   api_type: "web_risk" },
  { kind: "email_send",          label: "Abuse email (live send)", channel: "email", api_type: null },
  { kind: "email_draft",         label: "Abuse email (draft)",     channel: "email", api_type: null },
  { kind: "followup_email_draft", label: "Follow-up email (draft)", channel: "email", api_type: null },
];

interface StatRow {
  kind:               string;
  total:              number;
  submitted:          number;
  queued:             number;
  rejected:           number;
  failed:             number;
  last_submission_at: string | null;
}

function isConfiguredFor(kind: string, env: Env): boolean {
  const submitter = SUBMITTERS.find((s) => s.kind === kind);
  // No isConfigured() (email drafts) → no external credential → always configured.
  return submitter?.isConfigured ? submitter.isConfigured(env) : true;
}

function deriveStatus(
  meta:       IntegrationMeta,
  configured: boolean,
  autoEnabled: boolean | null,
  sendLive:   boolean,
): IntegrationStatus {
  if (!configured) return "unconfigured";
  if (meta.channel === "email") {
    if (meta.kind === "email_send") return sendLive ? "live" : "paused";
    return "active"; // drafts always work
  }
  // API channel
  if (!autoEnabled) return "disabled";
  return sendLive ? "live" : "paused";
}

/**
 * Build the integration-health report over the trailing `windowHours`.
 * Pure aggregation over takedown_submissions + takedown_providers config.
 */
export async function getTakedownIntegrations(
  env:         Env,
  windowHours = 168,
): Promise<IntegrationsReport> {
  const since = `-${Math.max(1, Math.floor(windowHours))} hours`;
  const sendLive = isLiveSendMode(env);

  // 1. Aggregates by submitter_kind within the window.
  const statsRes = await env.DB.prepare(
    `SELECT submitter_kind AS kind,
            COUNT(*) AS total,
            SUM(CASE WHEN outcome = 'submitted' THEN 1 ELSE 0 END) AS submitted,
            SUM(CASE WHEN outcome = 'queued'    THEN 1 ELSE 0 END) AS queued,
            SUM(CASE WHEN outcome = 'rejected'  THEN 1 ELSE 0 END) AS rejected,
            SUM(CASE WHEN outcome = 'failed'    THEN 1 ELSE 0 END) AS failed,
            MAX(attempted_at) AS last_submission_at
       FROM takedown_submissions
      WHERE attempted_at >= datetime('now', ?)
      GROUP BY submitter_kind`,
  ).bind(since).all<StatRow>();
  const statsByKind = new Map<string, StatRow>();
  for (const r of statsRes.results ?? []) statsByKind.set(r.kind, r);

  // 2. Most-recent error per kind within the window.
  const errRes = await env.DB.prepare(
    `SELECT submitter_kind AS kind, error_message, attempted_at
       FROM takedown_submissions
      WHERE error_message IS NOT NULL
        AND attempted_at >= datetime('now', ?)
      ORDER BY attempted_at DESC`,
  ).bind(since).all<{ kind: string; error_message: string; attempted_at: string }>();
  const lastErrByKind = new Map<string, string>();
  for (const r of errRes.results ?? []) {
    if (!lastErrByKind.has(r.kind)) lastErrByKind.set(r.kind, r.error_message);
  }

  // 3. Provider config (auto-submit gate + name) for the API integrations.
  const provRes = await env.DB.prepare(
    `SELECT provider_name, abuse_api_type, auto_submit_enabled
       FROM takedown_providers
      WHERE abuse_api_type IN ('web_risk', 'netbeacon', 'godaddy')`,
  ).all<{ provider_name: string; abuse_api_type: string; auto_submit_enabled: number }>();
  const provByApiType = new Map<string, { provider_name: string; auto_submit_enabled: number }>();
  for (const r of provRes.results ?? []) {
    provByApiType.set(r.abuse_api_type, { provider_name: r.provider_name, auto_submit_enabled: r.auto_submit_enabled });
  }

  const integrations: IntegrationHealth[] = REGISTRY.map((meta) => {
    const s = statsByKind.get(meta.kind);
    const submitted = s?.submitted ?? 0;
    const rejected  = s?.rejected ?? 0;
    const failed    = s?.failed ?? 0;
    const decided   = submitted + rejected + failed;
    const prov      = meta.api_type ? provByApiType.get(meta.api_type) : undefined;
    const autoEnabled = meta.channel === "api" ? (prov ? prov.auto_submit_enabled === 1 : false) : null;
    const configured  = isConfiguredFor(meta.kind, env);

    return {
      kind:                meta.kind,
      label:               meta.label,
      channel:             meta.channel,
      api_type:            meta.api_type,
      provider_name:       prov?.provider_name ?? null,
      configured,
      auto_submit_enabled: autoEnabled,
      status:              deriveStatus(meta, configured, autoEnabled, sendLive),
      total:               s?.total ?? 0,
      submitted,
      queued:              s?.queued ?? 0,
      rejected,
      failed,
      success_rate:        decided > 0 ? Math.round((submitted / decided) * 100) : null,
      last_submission_at:  s?.last_submission_at ?? null,
      last_error:          lastErrByKind.get(meta.kind) ?? null,
    };
  });

  return {
    window_hours: windowHours,
    send_mode:    sendLive ? "live" : "draft",
    integrations,
  };
}
