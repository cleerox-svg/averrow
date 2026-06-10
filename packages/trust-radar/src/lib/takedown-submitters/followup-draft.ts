// Follow-up email submitter — used by Sparrow Phase H when a
// takedown's per-org SLA window
// (takedown_authorizations.scope.auto_followup_breached_sla_hours)
// has elapsed without the provider acknowledging.
//
// Behavior mirrors the primary email submitters but the body is
// reframed as a follow-up referencing the original submission (by
// ticket id when available, else by takedown id).
//
// Mode-aware since S1 (IMPROVEMENT_PLAN_2026-06):
//   - TAKEDOWN_SEND_MODE='live'  → sends via Resend (shared transport
//     in email-send.ts); submitter_kind='followup_email',
//     outcome='submitted' on handoff.
//   - any other mode → records the draft only (historical behavior);
//     submitter_kind='followup_email_draft', outcome='queued'.
//
// The SLA breach detector dedups against both kinds (Phase H's
// NOT EXISTS uses submitter_kind LIKE 'followup_%').

import type { Env } from "../../types";
import { sendTakedownEmail, isLiveSendMode } from "./email-send";
import { summarize, type TakedownEmailContent } from "./email-draft";
import type {
  Submitter,
  SubmissionResult,
  TakedownRecord,
  ProviderRecord,
} from "./types";

const KIND_DRAFT = "followup_email_draft";
const KIND_LIVE  = "followup_email";

export interface FollowupContext {
  /** When the original submission landed. ISO-8601 string. */
  originalSubmittedAt: string;
  /** Ticket / case id from the prior submission, when the provider issued one. */
  priorTicketId?:      string | null;
  /** Hours since original submission — derived once by the caller, passed in for body copy. */
  hoursElapsed:        number;
}

function buildFollowupEmail(
  t: TakedownRecord,
  p: ProviderRecord,
  ctx: FollowupContext,
): TakedownEmailContent {
  const subject = `[Averrow] Follow-up — takedown still active (${t.target_type})`;
  const reference = ctx.priorTicketId
    ? `Reference: provider ticket ${ctx.priorTicketId}`
    : `Reference: Averrow takedown ${t.id}`;
  const targetLine = t.target_url
    ? `Target: ${t.target_value} (${t.target_url})`
    : `Target: ${t.target_value}`;
  const detail = t.evidence_detail ?? t.evidence_summary;
  const body = [
    "Hello,",
    "",
    `Following up on our prior submission. The reported ${t.target_type} remains active ${ctx.hoursElapsed} hour(s) after submission, exceeding the agreed response window.`,
    "",
    reference,
    `Original submitted: ${ctx.originalSubmittedAt}`,
    "",
    targetLine,
    `Severity: ${t.severity}`,
    `Provider: ${p.provider_name}`,
    `Module:   ${t.module_key ?? "(unspecified)"}`,
    "",
    "Original evidence:",
    detail.trim(),
    "",
    `Please action this report or reply with a status update referencing takedown id ${t.id}.`,
    "",
    "Regards,",
    "Averrow Trust & Safety",
    "https://averrow.com",
  ].join("\n");
  return { subject, body };
}

function toPayload(content: TakedownEmailContent, p: ProviderRecord): string {
  return [
    `To: ${p.abuse_email ?? "(no abuse email on file)"}`,
    `Subject: ${content.subject}`,
    "",
    content.body,
  ].join("\n");
}

export interface FollowupSubmitter extends Submitter {
  submitFollowup(
    env:      Env,
    takedown: TakedownRecord,
    provider: ProviderRecord,
    ctx:      FollowupContext,
  ): Promise<SubmissionResult>;
}

export const followupDraftSubmitter: FollowupSubmitter = {
  kind: KIND_DRAFT,

  // Not part of the dispatcher priority chain — Phase H calls
  // submitFollowup() explicitly. canHandle exists to satisfy the
  // Submitter interface and stays conservative.
  canHandle(_env: Env, _takedown: TakedownRecord, provider: ProviderRecord): boolean {
    return Boolean(provider.abuse_email);
  },

  async submit(env: Env, takedown: TakedownRecord, provider: ProviderRecord): Promise<SubmissionResult> {
    return this.submitFollowup(env, takedown, provider, {
      originalSubmittedAt: "(unknown)",
      hoursElapsed:        0,
    });
  },

  async submitFollowup(
    env:      Env,
    takedown: TakedownRecord,
    provider: ProviderRecord,
    ctx:      FollowupContext,
  ): Promise<SubmissionResult> {
    const start = Date.now();
    const content = buildFollowupEmail(takedown, provider, ctx);
    const payload = toPayload(content, provider);

    if (isLiveSendMode(env) && provider.abuse_email) {
      const sent = await sendTakedownEmail(env, provider.abuse_email, content);
      if (sent.ok) {
        return {
          outcome:          "submitted",
          submitter_kind:   KIND_LIVE,
          submitter_target: provider.abuse_email,
          request_summary:  summarize(payload),
          request_payload:  payload,
          response_status:  sent.status ?? null,
          response_body:    sent.id ? JSON.stringify({ resend_id: sent.id }) : null,
          duration_ms:      Date.now() - start,
        };
      }
      return {
        outcome:          "failed",
        submitter_kind:   KIND_LIVE,
        submitter_target: provider.abuse_email,
        request_summary:  summarize(payload),
        request_payload:  payload,
        response_status:  sent.status ?? null,
        error_message:    sent.error ?? "send failed",
        duration_ms:      Date.now() - start,
      };
    }

    return {
      outcome:          "queued",
      submitter_kind:   KIND_DRAFT,
      submitter_target: provider.abuse_email,
      request_summary:  summarize(payload),
      request_payload:  payload,
      duration_ms:      Date.now() - start,
    };
  },
};
