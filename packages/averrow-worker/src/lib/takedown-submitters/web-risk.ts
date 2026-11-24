// Web Risk submitter — submits a malicious URL to Google's Web Risk
// Submission API so it gets flagged in Chrome / Android Safe Browsing.
//
// This is the platform's first true provider-API submitter (vs. the generic
// abuse-email channel). It's a *defensive* / blocklist submission: it doesn't
// take infrastructure down, it gets the URL flagged so end users are warned —
// high leverage, low legal exposure. See
// docs/TAKEDOWN_PROVIDER_INTEGRATION_PLAN.md §3.4, Phase P3.
//
// Gating (same defense-in-depth as the email submitters, plus credential):
//   1. Sparrow Phase G only dispatches when the org's policy + entitlement +
//      monthly cap + provider.auto_submit_enabled=1 all pass.
//   2. canHandle() requires TAKEDOWN_SEND_MODE='live' (the global kill
//      switch — draft mode falls through to the email draft channel) AND a
//      configured Google service-account credential. Absent credential →
//      this submitter declines and the dispatcher falls back to email.
//   3. The provider must be marked abuse_api_type='web_risk' (set on the
//      'Google Safe Browsing' row by migration 0223) so selection is
//      data-driven, not name-hardcoded.
//
// API: POST https://webrisk.googleapis.com/v1/projects/{projectId}/uris:submit
//      body { submission: { uri }, threatTypes: [...] }
// Prerequisite: the GCP project must be allow-listed by Google for the Web
// Risk Submission API (partner program). Until that + the service-account
// secret are in place, canHandle() returns false and email is used.

import type { Env } from "../../types";
import { logger } from "../logger";
import { store } from "../db-registry";
import { getGoogleAccessToken, hasServiceAccount } from "../google-service-account";
import { isLiveSendMode } from "./email-send";
import { postJson, outcomeForStatus, truncate } from "./http";
import type {
  Submitter,
  SubmissionResult,
  TakedownRecord,
  ProviderRecord,
} from "./types";

const KIND = "api_web_risk";

/**
 * Monthly cap on Web Risk Submission API calls, to stay inside Google's free
 * allowance. Google's quota page allows 1,000 SubmitUri calls/day and 100/min
 * per project, but the pricing page lists the Submission API as "Contact
 * sales" (older pricing gave 100 free submissions/month), so 100/month is the
 * conservative free ceiling. Every call this UTC month counts, whatever its
 * outcome (Google is billed per call, not per acceptance). Override with the
 * WEB_RISK_MONTHLY_CAP var (non-negative integer; 0 = no Web Risk submissions).
 */
export const WEB_RISK_MONTHLY_CAP_DEFAULT = 100;

export function webRiskMonthlyCap(env: Env): number {
  const raw = env.WEB_RISK_MONTHLY_CAP?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return WEB_RISK_MONTHLY_CAP_DEFAULT;
}

/** 'YYYY-MM-01 00:00:00' (UTC) — the takedown_submissions.attempted_at format. */
export function utcMonthStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 7)}-01 00:00:00`;
}

/** Web Risk calls recorded this UTC month (idx_takedown_submissions_attempted range). */
export async function webRiskSubmissionsThisMonth(env: Env, now: Date = new Date()): Promise<number> {
  const row = await store(env, "core").prepare(
    `SELECT COUNT(*) AS n FROM takedown_submissions
      WHERE attempted_at >= ? AND submitter_kind = ?`,
  ).bind(utcMonthStart(now), KIND).first<{ n: number }>();
  return row?.n ?? 0;
}
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
// Threat types we assert when submitting. Web Risk accepts these enums.
const THREAT_TYPES = ["SOCIAL_ENGINEERING", "MALWARE", "UNWANTED_SOFTWARE"];

/** The URL to submit — prefer the explicit target_url, else build from the value. */
function resolveUri(takedown: TakedownRecord): string | null {
  if (takedown.target_url && /^https?:\/\//i.test(takedown.target_url)) {
    return takedown.target_url;
  }
  const v = takedown.target_value?.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  // domain / bare host → https URL
  if (takedown.target_type === "domain" || takedown.target_type === "url") {
    return `https://${v}`;
  }
  return null;
}

export const webRiskSubmitter: Submitter = {
  kind: KIND,

  isConfigured(env: Env): boolean {
    return hasServiceAccount(env);
  },

  async hasCapacity(env: Env): Promise<boolean> {
    try {
      return (await webRiskSubmissionsThisMonth(env)) < webRiskMonthlyCap(env);
    } catch (err) {
      // Can't count → don't risk a billable call.
      logger.warn("web risk cap check failed; skipping web risk", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  canHandle(env: Env, takedown: TakedownRecord, provider: ProviderRecord): boolean {
    return (
      isLiveSendMode(env) &&
      provider.abuse_api_type === "web_risk" &&
      hasServiceAccount(env) &&
      resolveUri(takedown) !== null
    );
  },

  async submit(env: Env, takedown: TakedownRecord, provider: ProviderRecord): Promise<SubmissionResult> {
    const start = Date.now();
    const uri = resolveUri(takedown); // canHandle guarantees non-null
    if (!uri) {
      return {
        outcome:          "failed",
        submitter_kind:   KIND,
        submitter_target: null,
        request_summary:  null,
        error_message:    "No submittable URL on takedown",
        duration_ms:      Date.now() - start,
      };
    }

    const token = await getGoogleAccessToken(env, SCOPE);
    if (!token) {
      // Credential vanished between canHandle and submit, or token exchange
      // failed. Retryable.
      return {
        outcome:          "failed",
        submitter_kind:   KIND,
        submitter_target: provider.abuse_api_url,
        request_summary:  truncate(`Web Risk submit ${uri}`),
        error_message:    "Could not obtain Google access token",
        duration_ms:      Date.now() - start,
      };
    }
    if (!token.project_id) {
      return {
        outcome:          "failed",
        submitter_kind:   KIND,
        submitter_target: provider.abuse_api_url,
        request_summary:  truncate(`Web Risk submit ${uri}`),
        error_message:    "Service-account JSON has no project_id",
        duration_ms:      Date.now() - start,
      };
    }

    const endpoint = `https://webrisk.googleapis.com/v1/projects/${token.project_id}/uris:submit`;
    const payload = { submission: { uri }, threatTypes: THREAT_TYPES };

    const res = await postJson(endpoint, payload, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    const outcome = res.error ? "failed" : outcomeForStatus(res.status);
    // The API returns a long-running Operation; its name is our ticket id.
    const opName =
      res.json && typeof res.json === "object" && "name" in res.json
        ? String((res.json as { name?: unknown }).name ?? "")
        : null;

    if (outcome !== "submitted") {
      logger.warn("web risk submit non-success", {
        takedown_id: takedown.id,
        status:      res.status,
        error:       res.error,
      });
    }

    return {
      outcome,
      submitter_kind:   KIND,
      submitter_target: endpoint,
      request_summary:  truncate(`Web Risk submit ${uri} (${THREAT_TYPES.join(",")})`),
      request_payload:  JSON.stringify(payload),
      response_status:  res.status,
      response_body:    res.bodyText,
      ticket_id:        opName || null,
      error_message:    outcome === "submitted" ? null : (res.error ?? res.bodyText ?? `HTTP ${res.status}`),
      duration_ms:      Date.now() - start,
    };
  },
};
