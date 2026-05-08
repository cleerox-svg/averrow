// Email-draft submitter — records an intended submission to
// takedown_submissions but does NOT actually send the email.
//
// Why this exists: outbound SMTP isn't wired yet (Phase D), but
// the dispatcher framework (lib/takedown-submitters/) and Sparrow
// Phase G need a real submitter to integrate against. This
// submitter:
//
//   - assembles the email body from evidence_detail + a standard
//     boilerplate header,
//   - writes a takedown_submissions row with outcome='queued',
//   - returns the row to the dispatcher so Sparrow can stamp
//     submitted_at + advance status to 'submitted'.
//
// Operators see the queued submissions in averrow-ops and send
// them manually until an outbound SMTP submitter replaces this
// one. The behavior here is intentionally side-effect-free except
// for the audit row — that means it's safe to enable via
// auto_submit_enabled in production from day one.
//
// Phase C sprint 1.

import type {
  Submitter,
  SubmissionResult,
  TakedownRecord,
  ProviderRecord,
} from "./types";

const KIND = "email_draft";

function buildEmailBody(t: TakedownRecord, p: ProviderRecord): string {
  const heading = `[Averrow] Takedown request — ${t.target_type}`;
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
}

function summarize(body: string): string {
  return body.length > 500 ? body.slice(0, 497) + "…" : body;
}

export const emailDraftSubmitter: Submitter = {
  kind: KIND,

  canHandle(_takedown: TakedownRecord, provider: ProviderRecord): boolean {
    // Handles every provider that exposes an abuse_email.
    // The dispatcher prefers more-specific submitters first; this
    // one is the fallback.
    return Boolean(provider.abuse_email);
  },

  async submit(takedown: TakedownRecord, provider: ProviderRecord): Promise<SubmissionResult> {
    const start = Date.now();
    const body = buildEmailBody(takedown, provider);
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
