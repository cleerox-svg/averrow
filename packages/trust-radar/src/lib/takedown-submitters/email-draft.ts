// Email-draft submitter — records an intended submission to
// takedown_submissions but does NOT actually send the email.
//
// Why this exists: it is the safe default and the fallback when
// TAKEDOWN_SEND_MODE != 'live' (see email-send.ts for the live
// transport, S1 of IMPROVEMENT_PLAN_2026-06). This submitter:
//
//   - assembles the email body from evidence_detail + a standard
//     boilerplate header,
//   - writes a takedown_submissions row with outcome='queued',
//   - returns the row to the dispatcher so Sparrow can stamp
//     submitted_at + advance status to 'submitted'.
//
// Operators see the queued submissions in averrow-ops and send
// them manually while send mode is 'draft'. The behavior here is
// intentionally side-effect-free except for the audit row — that
// means it's safe to enable via auto_submit_enabled in production
// from day one.
//
// Phase C sprint 1. S1: builder extracted + shared with email-send.

import type { Env } from "../../types";
import type {
  Submitter,
  SubmissionResult,
  TakedownRecord,
  ProviderRecord,
} from "./types";

const KIND = "email_draft";

export interface TakedownEmailContent {
  subject: string;
  body:    string;
}

/**
 * Canonical abuse-report email copy. Shared by the draft submitter
 * (audit-only) and the live email-send submitter so the operator-
 * reviewed draft and the actually-sent email are always identical.
 */
export function buildTakedownEmail(t: TakedownRecord, p: ProviderRecord): TakedownEmailContent {
  const subject = `[Averrow] Takedown request — ${t.target_type}`;
  const targetLine = t.target_url
    ? `Target: ${t.target_value} (${t.target_url})`
    : `Target: ${t.target_value}`;
  const detail = t.evidence_detail ?? t.evidence_summary;
  const body = [
    "Hello,",
    "",
    `Averrow is submitting an automated takedown request on behalf of one of our customers. Details follow.`,
    "",
    targetLine,
    `Severity: ${t.severity}`,
    `Provider: ${p.provider_name}`,
    `Module:   ${t.module_key ?? "(unspecified)"}`,
    "",
    "Evidence:",
    detail.trim(),
    "",
    `If you require additional information or wish to dispute this request, reply to this thread referencing takedown id ${t.id}.`,
    "",
    "Regards,",
    "Averrow Trust & Safety",
    "https://averrow.com",
  ].join("\n");
  return { subject, body };
}

/**
 * Audit-row payload format — preserves the historical email-draft shape
 * (To/Subject preamble + body) so averrow-ops rendering and prior rows
 * stay consistent.
 */
export function toAuditPayload(content: TakedownEmailContent, p: ProviderRecord): string {
  return [
    `To: ${p.abuse_email ?? "(no abuse email on file)"}`,
    `Subject: ${content.subject}`,
    "",
    content.body,
  ].join("\n");
}

export function summarize(body: string): string {
  return body.length > 500 ? body.slice(0, 497) + "…" : body;
}

export const emailDraftSubmitter: Submitter = {
  kind: KIND,

  canHandle(_env: Env, _takedown: TakedownRecord, provider: ProviderRecord): boolean {
    // Handles every provider that exposes an abuse_email.
    // The dispatcher prefers more-specific submitters first; this
    // one is the fallback.
    return Boolean(provider.abuse_email);
  },

  async submit(_env: Env, takedown: TakedownRecord, provider: ProviderRecord): Promise<SubmissionResult> {
    const start = Date.now();
    const payload = toAuditPayload(buildTakedownEmail(takedown, provider), provider);
    return {
      outcome:          "queued",
      submitter_kind:   KIND,
      submitter_target: provider.abuse_email,
      request_summary:  summarize(payload),
      request_payload:  payload,
      duration_ms:      Date.now() - start,
    };
  },
};
