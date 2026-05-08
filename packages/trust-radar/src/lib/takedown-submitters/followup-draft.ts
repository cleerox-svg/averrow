// Follow-up email-draft submitter — used by Sparrow Phase H when a
// takedown's per-org SLA window
// (takedown_authorizations.scope.auto_followup_breached_sla_hours)
// has elapsed without the provider acknowledging.
//
// Behavior mirrors emailDraftSubmitter but the body is reframed
// as a follow-up referencing the original submission (by ticket
// id when available, else by takedown id), and the audit row's
// submitter_kind = 'followup_email_draft' so the SLA breach
// detector can dedup against repeat fires.
//
// Like email-draft, this submitter has no outbound side effect —
// it just records the intended follow-up in takedown_submissions
// and lets ops re-send the email until SMTP wiring lands in
// Phase D.
//
// Phase C sprint 3.

import type {
  Submitter,
  SubmissionResult,
  TakedownRecord,
  ProviderRecord,
} from "./types";

const KIND = "followup_email_draft";

export interface FollowupContext {
  /** When the original submission landed. ISO-8601 string. */
  originalSubmittedAt: string;
  /** Ticket / case id from the prior submission, when the provider issued one. */
  priorTicketId?:      string | null;
  /** Hours since original submission — derived once by the caller, passed in for body copy. */
  hoursElapsed:        number;
}

function buildFollowupBody(
  t: TakedownRecord,
  p: ProviderRecord,
  ctx: FollowupContext,
): string {
  const heading = `[Averrow] Follow-up — takedown still active (${t.target_type})`;
  const reference = ctx.priorTicketId
    ? `Reference: provider ticket ${ctx.priorTicketId}`
    : `Reference: Averrow takedown ${t.id}`;
  const targetLine = t.target_url
    ? `Target: ${t.target_value} (${t.target_url})`
    : `Target: ${t.target_value}`;
  const detail = t.evidence_detail ?? t.evidence_summary;
  return [
    `To: ${p.abuse_email ?? "(no abuse email on file)"}`,
    `Subject: ${heading}`,
    "",
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
}

function summarize(body: string): string {
  return body.length > 500 ? body.slice(0, 497) + "…" : body;
}

export interface FollowupSubmitter extends Submitter {
  submitFollowup(
    takedown: TakedownRecord,
    provider: ProviderRecord,
    ctx:      FollowupContext,
  ): Promise<SubmissionResult>;
}

export const followupDraftSubmitter: FollowupSubmitter = {
  kind: KIND,

  // Not part of the dispatcher priority chain — Phase H calls
  // submitFollowup() explicitly. canHandle exists to satisfy the
  // Submitter interface and stays conservative.
  canHandle(_takedown: TakedownRecord, provider: ProviderRecord): boolean {
    return Boolean(provider.abuse_email);
  },

  async submit(takedown: TakedownRecord, provider: ProviderRecord): Promise<SubmissionResult> {
    return this.submitFollowup(takedown, provider, {
      originalSubmittedAt: "(unknown)",
      hoursElapsed:        0,
    });
  },

  async submitFollowup(
    takedown: TakedownRecord,
    provider: ProviderRecord,
    ctx:      FollowupContext,
  ): Promise<SubmissionResult> {
    const start = Date.now();
    const body = buildFollowupBody(takedown, provider, ctx);
    return {
      outcome:          "queued",
      submitter_kind:   KIND,
      submitter_target: provider.abuse_email,
      request_summary:  summarize(body),
      request_payload:  body,
      duration_ms:      Date.now() - start,
    };
  },
};
