// Live email submitter — actually sends the abuse-report email via
// Resend. S1 of IMPROVEMENT_PLAN_2026-06 (Phase D of the original
// takedown plan).
//
// Gating model (defense in depth — every layer must pass):
//   1. Sparrow Phase G only dispatches takedowns whose org has an
//      active signed takedown_authorizations row covering the module,
//      whose org_modules entitlement is enabled, and whose provider
//      row has auto_submit_enabled=1 (agents/sparrow.ts).
//   2. Phase G additionally enforces scope_json.max_takedowns_per_month
//      and a per-run send ceiling (S1).
//   3. This submitter's canHandle() returns true only when
//      env.TAKEDOWN_SEND_MODE === 'live'. In any other mode the
//      dispatcher falls through to emailDraftSubmitter and behavior is
//      exactly the pre-S1 queued-draft flow. Flipping the var back to
//      'draft' is the kill switch — no deploy needed beyond the var.
//
// Identity: sends from takedowns@averrow.com (domain already verified
// in Resend for briefing/outreach/invite mail). Reply-To is the same
// address; migration 0214 registers it as a platform abuse alias so
// provider replies land in the abuse-mailbox pipeline (averrow.ca
// relay — see docs/EMAIL_ROUTING_RUNBOOK.md Path B).
//
// Failure semantics: any transport failure (non-2xx from Resend,
// network error, timeout) returns outcome='failed', which leaves the
// takedown in 'draft' so the next Sparrow tick retries. 'rejected' is
// reserved for provider-side rejection and is never produced here.

import type { Env } from "../../types";
import { logger } from "../logger";
import {
  buildTakedownEmail,
  toAuditPayload,
  summarize,
  type TakedownEmailContent,
} from "./email-draft";
import type {
  Submitter,
  SubmissionResult,
  TakedownRecord,
  ProviderRecord,
} from "./types";

const KIND = "email";

const FROM_ADDRESS  = "Averrow Trust & Safety <takedowns@averrow.com>";
const REPLY_TO      = "takedowns@averrow.com";
const SEND_TIMEOUT_MS = 10_000;

export function isLiveSendMode(env: Env): boolean {
  return env.TAKEDOWN_SEND_MODE === "live";
}

export interface TakedownSendResult {
  ok:          boolean;
  /** Resend message id on success. */
  id?:         string;
  status?:     number;
  error?:      string;
}

/**
 * Plain-text send via Resend. Shared with the follow-up submitter.
 * Never throws.
 */
export async function sendTakedownEmail(
  env: Env,
  to: string,
  content: TakedownEmailContent,
): Promise<TakedownSendResult> {
  if (!env.RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from:     FROM_ADDRESS,
        to:       [to],
        reply_to: REPLY_TO,
        subject:  content.subject,
        text:     content.body,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const json = await res
      .json<{ id?: string; message?: string; name?: string }>()
      .catch(() => ({}) as { id?: string; message?: string; name?: string });
    if (!res.ok) {
      return {
        ok:     false,
        status: res.status,
        error:  json.message ?? json.name ?? `Resend HTTP ${res.status}`,
      };
    }
    return { ok: true, id: json.id, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const emailSendSubmitter: Submitter = {
  kind: KIND,

  isConfigured(env: Env): boolean {
    return Boolean(env.RESEND_API_KEY);
  },

  canHandle(env: Env, _takedown: TakedownRecord, provider: ProviderRecord): boolean {
    return isLiveSendMode(env) && Boolean(provider.abuse_email);
  },

  async submit(env: Env, takedown: TakedownRecord, provider: ProviderRecord): Promise<SubmissionResult> {
    const start = Date.now();
    const content = buildTakedownEmail(takedown, provider);
    const payload = toAuditPayload(content, provider);
    const to = provider.abuse_email as string; // canHandle guarantees non-null

    const sent = await sendTakedownEmail(env, to, content);
    if (!sent.ok) {
      logger.warn("takedown email send failed", {
        takedown_id: takedown.id,
        provider:    provider.provider_name,
        status:      sent.status,
        error:       sent.error,
      });
      return {
        outcome:          "failed",
        submitter_kind:   KIND,
        submitter_target: to,
        request_summary:  summarize(payload),
        request_payload:  payload,
        response_status:  sent.status ?? null,
        error_message:    sent.error ?? "send failed",
        duration_ms:      Date.now() - start,
      };
    }

    return {
      outcome:          "submitted",
      submitter_kind:   KIND,
      submitter_target: to,
      request_summary:  summarize(payload),
      request_payload:  payload,
      response_status:  sent.status ?? null,
      // Resend message id — forensic link to the delivery record.
      response_body:    sent.id ? JSON.stringify({ resend_id: sent.id }) : null,
      duration_ms:      Date.now() - start,
    };
  },
};
