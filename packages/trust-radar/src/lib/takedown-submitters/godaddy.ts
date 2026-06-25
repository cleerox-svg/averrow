// GoDaddy submitter — files a domain-abuse ticket via GoDaddy's Abuse API.
//
// GoDaddy is the one major registrar with a real, authenticated, third-party
// abuse-reporting REST API (most registrars/hosts are form/email only). This
// is the direct-to-registrar channel for GoDaddy-registered domains, distinct
// from NetBeacon's registrar fan-out. See
// docs/TAKEDOWN_PROVIDER_INTEGRATION_PLAN.md Phase P4.
//
// API: POST {base}/v1/abuse/tickets
//   auth:    Authorization: sso-key {GODADDY_API_KEY}:{GODADDY_API_SECRET}
//   body:    { type, source, target?, info?, infoUrl?, intentional? }
//   success: 201 Created, body carries `ticketId`
//   types:   PHISHING | MALWARE | SPAM | NETWORK_ABUSE | CONTENT | FRAUD_WIRE
//            | A_RECORD | IP_BLOCK
//
// Gating mirrors the other API submitters: live-send kill switch + both
// credentials + provider.abuse_api_type='godaddy' + a resolvable source.
// Absent credentials → declines, and because the GoDaddy provider row keeps
// its abuse_email the dispatcher still falls back to the email channel.
// Base URL is overridable via GODADDY_API_BASE (point at the OTE sandbox
// https://api.ote-godaddy.com for verification before going to production).

import type { Env } from "../../types";
import { logger } from "../logger";
import { isLiveSendMode } from "./email-send";
import { postJson, outcomeForStatus, truncate } from "./http";
import type {
  Submitter,
  SubmissionResult,
  TakedownRecord,
  ProviderRecord,
} from "./types";

const KIND = "api_godaddy";
const DEFAULT_BASE = "https://api.godaddy.com";

type GoDaddyAbuseType =
  | "PHISHING" | "MALWARE" | "SPAM" | "NETWORK_ABUSE" | "CONTENT" | "A_RECORD";

function creds(env: Env): { key: string; secret: string } | null {
  const e = env as unknown as Record<string, string | undefined>;
  if (e.GODADDY_API_KEY && e.GODADDY_API_SECRET) {
    return { key: e.GODADDY_API_KEY, secret: e.GODADDY_API_SECRET };
  }
  return null;
}

/** The live abuse location GoDaddy wants in `source` — a URL or IP. */
function resolveSource(takedown: TakedownRecord): string | null {
  if (takedown.target_url && /^https?:\/\//i.test(takedown.target_url)) {
    return takedown.target_url;
  }
  const v = takedown.target_value?.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (takedown.target_type === "domain" || takedown.target_type === "url") {
    return `https://${v}`;
  }
  // bare IP
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v;
  return null;
}

/** Map our internal signal onto GoDaddy's abuse-type enum. */
export function deriveGoDaddyType(takedown: TakedownRecord): GoDaddyAbuseType {
  const hay = `${takedown.module_key ?? ""} ${takedown.evidence_summary} ${takedown.evidence_detail ?? ""}`.toLowerCase();
  if (/\bmalware|trojan|ransomware|dropper|payload\b/.test(hay)) return "MALWARE";
  if (/\bbotnet|c2|command.and.control|\bc&c\b/.test(hay)) return "NETWORK_ABUSE";
  if (/\bspam\b/.test(hay)) return "SPAM";
  return "PHISHING";
}

export const godaddySubmitter: Submitter = {
  kind: KIND,

  isConfigured(env: Env): boolean {
    return creds(env) !== null;
  },

  canHandle(env: Env, takedown: TakedownRecord, provider: ProviderRecord): boolean {
    return (
      isLiveSendMode(env) &&
      provider.abuse_api_type === "godaddy" &&
      creds(env) !== null &&
      resolveSource(takedown) !== null
    );
  },

  async submit(env: Env, takedown: TakedownRecord, provider: ProviderRecord): Promise<SubmissionResult> {
    const start = Date.now();
    const source = resolveSource(takedown);
    const c = creds(env);
    if (!source || !c) {
      return {
        outcome:          "failed",
        submitter_kind:   KIND,
        submitter_target: provider.abuse_api_url,
        request_summary:  null,
        error_message:    !source ? "No abuse source (URL/IP) on takedown" : "GoDaddy credentials missing",
        duration_ms:      Date.now() - start,
      };
    }

    const base = (env as unknown as Record<string, string | undefined>).GODADDY_API_BASE || provider.abuse_api_url || DEFAULT_BASE;
    const endpoint = `${base.replace(/\/$/, "")}/v1/abuse/tickets`;
    const type = deriveGoDaddyType(takedown);

    const payload = {
      type,
      source,
      info:        truncate(`${takedown.evidence_summary}\n\n${takedown.evidence_detail ?? ""}`.trim(), 2000),
      infoUrl:     "https://averrow.com",
      intentional: true,
    };

    const res = await postJson(endpoint, payload, {
      headers: { Authorization: `sso-key ${c.key}:${c.secret}` },
    });

    const outcome = res.error ? "failed" : outcomeForStatus(res.status);
    const ticketId =
      res.json && typeof res.json === "object"
        ? String((res.json as Record<string, unknown>).ticketId ?? "")
        : "";

    if (outcome !== "submitted") {
      logger.warn("godaddy abuse submit non-success", {
        takedown_id: takedown.id,
        status:      res.status,
        error:       res.error,
      });
    }

    return {
      outcome,
      submitter_kind:   KIND,
      submitter_target: endpoint,
      request_summary:  truncate(`GoDaddy ${type} ticket for ${source}`),
      request_payload:  JSON.stringify(payload),
      response_status:  res.status,
      response_body:    res.bodyText,
      ticket_id:        ticketId || null,
      error_message:    outcome === "submitted" ? null : (res.error ?? res.bodyText ?? `HTTP ${res.status}`),
      duration_ms:      Date.now() - start,
    };
  },
};
