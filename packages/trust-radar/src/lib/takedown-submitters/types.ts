// Shared types for the takedown-submitters dispatcher and individual submitters.
//
// Phase C sprint 1.
// S1 (IMPROVEMENT_PLAN_2026-06): submitters receive Env so live submitters
// can reach transport secrets (Resend) and the TAKEDOWN_SEND_MODE flag.

import type { Env } from "../../types";
import type { ModuleKey } from "../entitlements";

export interface TakedownRecord {
  id:                     string;
  org_id:                 number | null;
  brand_id:               string;
  module_key:             ModuleKey | null;
  target_type:            string;          // domain | social_profile | url | email
  target_value:           string;
  target_url:             string | null;
  evidence_summary:       string;
  evidence_detail:        string | null;
  provider_name:          string | null;
  provider_abuse_contact: string | null;
  provider_method:        string | null;   // email | form | api | rest
  severity:               string;
}

export interface ProviderRecord {
  id:                  number;
  provider_name:       string;
  provider_type:       string;
  abuse_email:         string | null;
  abuse_url:           string | null;
  abuse_api_url:       string | null;
  abuse_api_type:      string | null;
  auto_submit_enabled: number;             // SQLite stores as 0/1
}

/**
 * Result of a single submission attempt.
 *
 * Outcome values:
 *   - 'submitted'  — provider acknowledged receipt (HTTP 2xx for API/form,
 *                    or "email handed off" for email submitters)
 *   - 'queued'     — work is recorded but no outbound side effect yet
 *                    (e.g. email-draft submitter — ops will send manually
 *                    until SMTP is wired)
 *   - 'rejected'   — provider explicitly rejected (HTTP 4xx, or rejection
 *                    body text)
 *   - 'failed'     — transient failure (HTTP 5xx, network error, timeout)
 */
export type SubmissionOutcome = "submitted" | "queued" | "rejected" | "failed";

export interface SubmissionResult {
  outcome:           SubmissionOutcome;
  submitter_kind:    string;                 // 'email_draft' | 'email' | 'api_cloudflare' | …
  submitter_target:  string | null;          // recipient / endpoint
  request_summary:   string | null;          // <=500 chars preview
  request_payload?:  string | null;          // JSON body / email body
  response_status?:  number | null;
  response_body?:    string | null;
  ticket_id?:        string | null;
  error_message?:    string | null;
  duration_ms?:      number;
}

export interface Submitter {
  /** Stable kind identifier — written to takedown_submissions.submitter_kind. */
  readonly kind: string;
  /** True iff this submitter can handle the given (takedown, provider) pair. */
  canHandle(env: Env, takedown: TakedownRecord, provider: ProviderRecord): boolean;
  /** Perform the submission. Implementations must not throw — catch + return outcome='failed'. */
  submit(env: Env, takedown: TakedownRecord, provider: ProviderRecord): Promise<SubmissionResult>;
}
