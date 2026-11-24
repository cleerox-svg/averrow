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
import { webRiskMonthlyCap, webRiskSubmissionsThisMonth } from "./takedown-submitters/web-risk";

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
  /**
   * Calendar-month (UTC) usage against a self-imposed cap, for integrations
   * that have one (Web Risk: stays in Google's free allowance). Absent
   * otherwise; `used` is null when the count could not be read.
   */
  monthly_quota?:      { used: number | null; cap: number };
  /** Static channel configuration (secret NAMES, never values) + provider row. */
  config:              IntegrationConfig;
}

/** The takedown_providers row behind an API integration (matched on abuse_api_type). */
export interface IntegrationProviderConfig {
  id:                  number;
  provider_name:       string;
  provider_type:       string | null;
  abuse_email:         string | null;
  abuse_url:           string | null;
  abuse_api_url:       string | null;
  abuse_api_type:      string;
  auto_submit_enabled: boolean;
}

export interface IntegrationConfig {
  /** Worker secret NAMES this channel reads — never their values. */
  credential_secrets:   string[];
  /** Per-secret presence (non-empty string in env) — never the value. */
  credential_status:    Array<{ name: string; set: boolean }>;
  /** Optional non-secret vars this channel reads. */
  optional_vars:        string[];
  /** Whether a real send needs TAKEDOWN_SEND_MODE=live. */
  requires_live_mode:   boolean;
  send_mode:            "live" | "draft";
  /** null for email channels, or when no provider row exists. */
  provider:             IntegrationProviderConfig | null;
  /** true only for API integrations that have a provider row. */
  auto_submit_editable: boolean;
  /**
   * What the auto-submit switch governs. "provider" = the whole
   * takedown_providers row: Sparrow skips EVERY automated submission to it
   * while off (the API and its abuse-email fallback alike). null for email
   * channels, which have no switch.
   */
  auto_submit_scope:    "provider" | null;
}

function secretIsSet(env: Env, name: string): boolean {
  const v = (env as unknown as Record<string, unknown>)[name];
  return typeof v === "string" && v.length > 0;
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
  /** Worker secret names the submitter reads (keep in sync with lib/takedown-submitters/*). */
  secrets:  string[];
  /** Optional non-secret vars the submitter reads. */
  vars:     string[];
  /** A real send needs TAKEDOWN_SEND_MODE=live. */
  live:     boolean;
}

// Display registry. Order = display order. API integrations first.
const REGISTRY: IntegrationMeta[] = [
  { kind: "api_netbeacon",        label: "NetBeacon",               channel: "api",   api_type: "netbeacon",
    secrets: ["NETBEACON_API_KEY"], vars: ["NETBEACON_API_BASE"], live: true },
  { kind: "api_godaddy",          label: "GoDaddy Abuse API",       channel: "api",   api_type: "godaddy",
    secrets: ["GODADDY_API_KEY", "GODADDY_API_SECRET"], vars: ["GODADDY_API_BASE"], live: true },
  { kind: "api_web_risk",         label: "Google Web Risk",         channel: "api",   api_type: "web_risk",
    secrets: ["GOOGLE_SERVICE_ACCOUNT_JSON"], vars: ["WEB_RISK_MONTHLY_CAP"], live: true },
  { kind: "email_send",           label: "Abuse email (live send)", channel: "email", api_type: null,
    secrets: ["RESEND_API_KEY"], vars: [], live: true },
  { kind: "email_draft",          label: "Abuse email (draft)",     channel: "email", api_type: null,
    secrets: [], vars: [], live: false },
  { kind: "followup_email_draft", label: "Follow-up email (draft)", channel: "email", api_type: null,
    secrets: [], vars: [], live: false },
];

/** API integration kind → takedown_providers.abuse_api_type. */
export function apiTypeForIntegrationKind(kind: string): string | null {
  const meta = REGISTRY.find((m) => m.kind === kind);
  return meta && meta.channel === "api" ? meta.api_type : null;
}

/** Whether `kind` is a registered integration (API or email). */
export function isKnownIntegrationKind(kind: string): boolean {
  return REGISTRY.some((m) => m.kind === kind);
}

interface StatRow {
  kind:               string;
  total:              number;
  submitted:          number;
  queued:             number;
  rejected:           number;
  failed:             number;
  last_submission_at: string | null;
}

interface ProviderRow {
  id:                  number;
  provider_name:       string;
  provider_type:       string | null;
  abuse_email:         string | null;
  abuse_url:           string | null;
  abuse_api_url:       string | null;
  abuse_api_type:      string;
  auto_submit_enabled: number;
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
  //    Ordered by id; the lowest-id row per api type is the one reported.
  const provRes = await env.DB.prepare(
    `SELECT id, provider_name, provider_type, abuse_email, abuse_url, abuse_api_url,
            abuse_api_type, auto_submit_enabled
       FROM takedown_providers
      WHERE abuse_api_type IN ('web_risk', 'netbeacon', 'godaddy')
      ORDER BY id`,
  ).all<ProviderRow>();
  const provByApiType = new Map<string, IntegrationProviderConfig>();
  for (const r of provRes.results ?? []) {
    if (provByApiType.has(r.abuse_api_type)) continue;
    provByApiType.set(r.abuse_api_type, {
      id:                  Number(r.id),
      provider_name:       r.provider_name,
      provider_type:       r.provider_type ?? null,
      abuse_email:         r.abuse_email ?? null,
      abuse_url:           r.abuse_url ?? null,
      abuse_api_url:       r.abuse_api_url ?? null,
      abuse_api_type:      r.abuse_api_type,
      auto_submit_enabled: Number(r.auto_submit_enabled) === 1,
    });
  }

  // 4. Web Risk's monthly free-allowance usage (one indexed range COUNT).
  let webRiskUsed: number | null = null;
  try {
    webRiskUsed = await webRiskSubmissionsThisMonth(env);
  } catch {
    webRiskUsed = null;
  }

  const integrations: IntegrationHealth[] = REGISTRY.map((meta) => {
    const s = statsByKind.get(meta.kind);
    const submitted = s?.submitted ?? 0;
    const rejected  = s?.rejected ?? 0;
    const failed    = s?.failed ?? 0;
    const decided   = submitted + rejected + failed;
    const prov      = meta.api_type ? provByApiType.get(meta.api_type) : undefined;
    const autoEnabled = meta.channel === "api" ? (prov ? prov.auto_submit_enabled : false) : null;
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
      ...(meta.kind === "api_web_risk" ? { monthly_quota: { used: webRiskUsed, cap: webRiskMonthlyCap(env) } } : {}),
      config: {
        credential_secrets:   [...meta.secrets],
        credential_status:    meta.secrets.map((name) => ({ name, set: secretIsSet(env, name) })),
        optional_vars:        [...meta.vars],
        requires_live_mode:   meta.live,
        send_mode:            sendLive ? "live" : "draft",
        provider:             meta.channel === "api" ? (prov ? { ...prov } : null) : null,
        auto_submit_editable: meta.channel === "api" && prov !== undefined,
        auto_submit_scope:    meta.channel === "api" ? "provider" : null,
      },
    };
  });

  return {
    window_hours: windowHours,
    send_mode:    sendLive ? "live" : "draft",
    integrations,
  };
}
