// Takedown-submitters dispatcher.
//
// The dispatcher is the single entry point Sparrow Phase G calls.
// It picks a submitter, runs it, and persists a takedown_submissions
// audit row with the outcome.
//
// Order of precedence at dispatch time:
//
//   1. Provider-specific submitters (e.g. submitters/cloudflare.ts).
//      The first one whose canHandle() returns true wins.
//   2. emailDraftSubmitter as the fallback when the provider has
//      an abuse_email.
//   3. Refuse to dispatch if nothing matches.
//
// As more provider-specific submitters land in C2-Cn (Cloudflare,
// GoDaddy, Twitter/X, etc.), they get registered ahead of the
// fallback by adding them to SUBMITTERS in priority order.
//
// Phase C sprint 1.

import type { Env } from "../../types";
import { emailDraftSubmitter } from "./email-draft";
import type {
  ProviderRecord,
  SubmissionResult,
  Submitter,
  TakedownRecord,
} from "./types";

/**
 * Submitters in priority order. First match wins. The email-draft
 * fallback stays last so any provider-specific implementation
 * shadows it once landed.
 */
const SUBMITTERS: Submitter[] = [
  // future: cloudflareSubmitter, godaddySubmitter, twitterSubmitter, …
  emailDraftSubmitter,
];

export function pickSubmitter(
  takedown: TakedownRecord,
  provider: ProviderRecord,
): Submitter | null {
  for (const s of SUBMITTERS) {
    if (s.canHandle(takedown, provider)) return s;
  }
  return null;
}

export interface DispatchResult {
  result:        SubmissionResult;
  submission_id: string;
}

export async function dispatchSubmission(
  env: Env,
  takedown: TakedownRecord,
  provider: ProviderRecord,
): Promise<DispatchResult> {
  const submitter = pickSubmitter(takedown, provider);

  let result: SubmissionResult;
  if (!submitter) {
    result = {
      outcome:          "failed",
      submitter_kind:   "none",
      submitter_target: null,
      request_summary:  null,
      error_message:    `No submitter matched provider ${provider.provider_name} (api_type=${provider.abuse_api_type ?? "?"})`,
    };
  } else {
    try {
      result = await submitter.submit(takedown, provider);
    } catch (err) {
      // Submitters are required to not throw; defend anyway.
      result = {
        outcome:          "failed",
        submitter_kind:   submitter.kind,
        submitter_target: null,
        request_summary:  null,
        error_message:    err instanceof Error ? err.message : String(err),
      };
    }
  }

  const submissionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO takedown_submissions (
       id, takedown_id, provider_id,
       submitter_kind, submitter_target, request_summary, request_payload,
       outcome, response_status, response_body, ticket_id, error_message,
       attempted_at, duration_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
  ).bind(
    submissionId,
    takedown.id,
    provider.id,
    result.submitter_kind,
    result.submitter_target ?? null,
    result.request_summary  ?? null,
    result.request_payload  ?? null,
    result.outcome,
    result.response_status  ?? null,
    result.response_body    ?? null,
    result.ticket_id        ?? null,
    result.error_message    ?? null,
    result.duration_ms      ?? null,
  ).run();

  return { result, submission_id: submissionId };
}

export { emailDraftSubmitter } from "./email-draft";
export type { Submitter, SubmissionResult, TakedownRecord, ProviderRecord } from "./types";
