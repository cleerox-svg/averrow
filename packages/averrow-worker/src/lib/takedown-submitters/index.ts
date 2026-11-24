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
import { store } from "../db-registry";
import { isLiveSendMode } from "./email-send";
import { emailDraftSubmitter } from "./email-draft";
import { emailSendSubmitter } from "./email-send";
import { followupDraftSubmitter } from "./followup-draft";
import { webRiskSubmitter } from "./web-risk";
import { netbeaconSubmitter } from "./netbeacon";
import { godaddySubmitter } from "./godaddy";
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
 *
 * Provider-specific API submitters (webRiskSubmitter, future
 * cloudflare/registrar/etc.) sit ahead of the generic email channel. Each
 * gates its own canHandle() on the live-send kill switch + its credential,
 * so an unconfigured submitter transparently falls back to email rather
 * than failing.
 *
 * S1: emailSendSubmitter sits ahead of the draft fallback but its
 * canHandle() only matches when TAKEDOWN_SEND_MODE='live' — in draft
 * mode (the default) selection falls through to emailDraftSubmitter
 * and behavior is identical to pre-S1.
 */
// webRiskSubmitter and netbeaconSubmitter are mutually exclusive per
// takedown — each canHandle()s only its own provider.abuse_api_type — so
// their relative order is immaterial; both just sit ahead of email.
export const SUBMITTERS: Submitter[] = [
  webRiskSubmitter,      // Google Web Risk Submission API (URL blocklist)
  netbeaconSubmitter,    // NetBeacon — registrar-routed DNS-abuse reports
  godaddySubmitter,      // GoDaddy Abuse API — direct-to-registrar tickets
  // future: apwgSubmitter, netcraftSubmitter, …
  emailSendSubmitter,
  emailDraftSubmitter,
];

export function pickSubmitter(
  env: Env,
  takedown: TakedownRecord,
  provider: ProviderRecord,
): Submitter | null {
  for (const s of SUBMITTERS) {
    if (s.canHandle(env, takedown, provider)) return s;
  }
  return null;
}

/**
 * pickSubmitter plus each match's optional quota gate: a submitter whose
 * hasCapacity() says no is skipped and the next match in priority order is
 * tried. `skipped` names the kinds passed over for quota.
 */
export async function pickSubmitterWithCapacity(
  env: Env,
  takedown: TakedownRecord,
  provider: ProviderRecord,
): Promise<{ submitter: Submitter | null; skipped: string[] }> {
  const skipped: string[] = [];
  for (const s of SUBMITTERS) {
    if (!s.canHandle(env, takedown, provider)) continue;
    if (s.hasCapacity && !(await s.hasCapacity(env))) {
      skipped.push(s.kind);
      continue;
    }
    return { submitter: s, skipped };
  }
  return { submitter: null, skipped };
}

/**
 * True when a takedown has a matching channel but every match is at its
 * monthly cap — i.e. it should WAIT for the cap to reset, not fail. Callers
 * check this before claiming a row (Sparrow skips it; hand-submit answers 409).
 */
export async function isQuotaBlocked(
  env: Env,
  takedown: TakedownRecord,
  provider: ProviderRecord,
): Promise<boolean> {
  const { submitter, skipped } = await pickSubmitterWithCapacity(env, takedown, provider);
  return submitter === null && skipped.length > 0;
}

/**
 * Provider names whose takedowns can only go through Web Risk (no abuse
 * email to fall back to) while Web Risk is at its monthly cap. Sparrow leaves
 * these out of a run's candidate batch so capped takedowns wait unclaimed and
 * can't starve other providers' slots. [] when Web Risk has capacity or the
 * send mode is draft (Web Risk is never picked then).
 */
export async function quotaBlockedProviderNames(env: Env): Promise<string[]> {
  if (!isLiveSendMode(env) || !webRiskSubmitter.hasCapacity) return [];
  if (await webRiskSubmitter.hasCapacity(env)) return [];
  const rows = await store(env, "core").prepare(
    `SELECT provider_name FROM takedown_providers
      WHERE abuse_api_type = 'web_risk'
        AND (abuse_email IS NULL OR trim(abuse_email) = '')`,
  ).all<{ provider_name: string }>();
  return (rows.results ?? []).map((r) => r.provider_name);
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
  const { submitter, skipped } = await pickSubmitterWithCapacity(env, takedown, provider);

  let result: SubmissionResult;
  if (!submitter) {
    const quota = skipped.length > 0 ? `; at monthly cap: ${skipped.join(", ")}` : "";
    result = {
      outcome:          "failed",
      submitter_kind:   "none",
      submitter_target: null,
      request_summary:  null,
      error_message:    `No submitter matched provider ${provider.provider_name} (api_type=${provider.abuse_api_type ?? "?"})${quota}`,
    };
  } else {
    try {
      result = await submitter.submit(env, takedown, provider);
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

  const submissionId = await recordSubmissionAttempt(env, takedown.id, provider.id, result);
  return { result, submission_id: submissionId };
}

/**
 * Persist a single submission attempt to takedown_submissions.
 *
 * Used by dispatchSubmission() and by Phase H follow-up logic that
 * dispatches a follow-up submitter (followup-draft) directly without
 * going through the priority chain.
 */
export async function recordSubmissionAttempt(
  env:         Env,
  takedownId:  string,
  providerId:  number | null,
  result:      SubmissionResult,
): Promise<string> {
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
    takedownId,
    providerId,
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
  return submissionId;
}

export { emailDraftSubmitter } from "./email-draft";
export { emailSendSubmitter, isLiveSendMode } from "./email-send";
export { followupDraftSubmitter, type FollowupContext } from "./followup-draft";
export type { Submitter, SubmissionResult, TakedownRecord, ProviderRecord } from "./types";
