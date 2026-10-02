// Averrow — Abuse Mailbox spam-protection / rate-limit decision
//
// Single bad actor (or botnet sharing a sending domain) can flood
// the public abuse aliases with thousands of submissions in minutes.
// Without protection, each submission triggers:
//
//   - 1 Resend API call (ack email)
//   - 1 per-message triage Workflow (rules pass, optional Haiku call)
//   - 1 Resend API call (determination email)
//
// The protected path keeps the forensic INSERT but marks the row
// `throttled = 1`, which skips the ack, the Workflow dispatch, the rules
// pass, the AI classifier and the determination email (every one of those
// filters on throttled = 0).
//
// Four rolling-60-minute caps, checked in order of specificity (the first
// that fires is the recorded reason):
//
//   PER_SENDER_HOURLY_THRESHOLD = 20    forwarded_by_email
//   PER_DOMAIN_HOURLY_THRESHOLD = 50    forwarded_by_reg_domain — the
//                                       REGISTRABLE domain, so rotating
//                                       subdomains (a1.bad.example,
//                                       a2.bad.example, …) share one bucket
//   PER_ORG_HOURLY_THRESHOLD    = 200   org_id (the alias's org)
//   GLOBAL_HOURLY_THRESHOLD     = 1000  every abuse alias combined
//
// The org and global caps bound outbound email + Workflow volume even when
// a flood rotates sender addresses and domains. Each count reads at most
// `threshold` index entries (`COUNT(*)` over a `LIMIT`ed subquery), so a
// flood cannot make the check itself expensive. Indexes:
// idx_abuse_inbox_sender_recent (0185), idx_abuse_inbox_reg_domain_recent
// (0273), idx_abuse_inbox_received (org_id, received_at; 0150),
// idx_abuse_inbox_received_at (0273).
//
// Reactivation: when an operator clears the throttle on a specific
// row (UPDATE abuse_inbox_messages SET throttled = 0 WHERE id = ?),
// the hourly sweep picks it up on its next pass. No per-sender unblock
// is needed — the rolling window naturally re-permits the sender once
// their rate drops below threshold.

import type { Env } from "../types";
import { registrableDomain } from "./domain-utils";

export const PER_SENDER_HOURLY_THRESHOLD = 20;
export const PER_DOMAIN_HOURLY_THRESHOLD = 50;
export const PER_ORG_HOURLY_THRESHOLD    = 200;
export const GLOBAL_HOURLY_THRESHOLD     = 1000;
export const WINDOW_MINUTES              = 60;

export type ThrottleReason =
  | "sender_rate_limit"
  | "domain_rate_limit"
  | "org_rate_limit"
  | "global_rate_limit";

export interface ThrottleDecision {
  /** Whether the inbound message should bypass ack + Workflow + classifier + determination. */
  throttled: boolean;
  /** Which rule fired, if any. */
  reason: ThrottleReason | null;
  /** Counts seen in the rolling window (each capped at its threshold). */
  sender_count_last_window: number;
  domain_count_last_window: number;
  org_count_last_window:    number;
  global_count_last_window: number;
  /** Echoed back so the caller doesn't need to re-derive. */
  sender_email: string | null;
  sender_domain: string | null;
  /** Registrable domain of the sender — the domain-rule key, stored as
   *  abuse_inbox_messages.forwarded_by_reg_domain. */
  sender_reg_domain: string | null;
}

/**
 * Extract the sending domain from an email address. Returns null
 * for malformed input. Lower-cased to match the storage convention
 * used by the email handler.
 */
export function extractSenderDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
}

/** Registrable domain of a sender address ("a@mx1.mail.bad.co.uk" → "bad.co.uk"). */
export function extractSenderRegDomain(email: string | null | undefined): string | null {
  const d = extractSenderDomain(email);
  if (!d) return null;
  return registrableDomain(d) ?? d;
}

const WINDOW_EXPR = `datetime('now', '-${WINDOW_MINUTES} minutes')`;

async function cappedCount(env: Env, where: string, binds: unknown[], cap: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM abuse_inbox_messages
       WHERE ${where} AND received_at > ${WINDOW_EXPR}
       LIMIT ?
     )`,
  ).bind(...binds, cap).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Compute the throttle decision for an incoming message. Reads from
 * D1 only — no writes. Caller stamps the row with the decision.
 */
export async function decideAbuseMailboxThrottle(
  env: Env,
  senderEmail: string | null,
  opts: { orgId?: number | null } = {},
): Promise<ThrottleDecision> {
  const senderDomain = extractSenderDomain(senderEmail);
  const senderRegDomain = extractSenderRegDomain(senderEmail);
  const orgId = opts.orgId ?? null;

  const [senderCount, domainCount, orgCount, globalCount] = await Promise.all([
    senderEmail
      ? cappedCount(env, "forwarded_by_email = ?", [senderEmail], PER_SENDER_HOURLY_THRESHOLD)
      : Promise.resolve(0),
    senderRegDomain
      ? cappedCount(env, "forwarded_by_reg_domain = ?", [senderRegDomain], PER_DOMAIN_HOURLY_THRESHOLD)
      : Promise.resolve(0),
    orgId !== null
      ? cappedCount(env, "org_id = ?", [orgId], PER_ORG_HOURLY_THRESHOLD)
      : Promise.resolve(0),
    cappedCount(env, "1 = 1", [], GLOBAL_HOURLY_THRESHOLD),
  ]);

  // Most specific rule first — sender > domain > org > global.
  let reason: ThrottleReason | null = null;
  if (senderEmail && senderCount >= PER_SENDER_HOURLY_THRESHOLD) reason = "sender_rate_limit";
  else if (senderRegDomain && domainCount >= PER_DOMAIN_HOURLY_THRESHOLD) reason = "domain_rate_limit";
  else if (orgId !== null && orgCount >= PER_ORG_HOURLY_THRESHOLD) reason = "org_rate_limit";
  else if (globalCount >= GLOBAL_HOURLY_THRESHOLD) reason = "global_rate_limit";

  return {
    throttled: reason !== null,
    reason,
    sender_count_last_window: senderCount,
    domain_count_last_window: domainCount,
    org_count_last_window:    orgCount,
    global_count_last_window: globalCount,
    sender_email: senderEmail,
    sender_domain: senderDomain,
    sender_reg_domain: senderRegDomain,
  };
}

/** Human-readable label for a throttle reason (operator notification). */
export function throttleReasonLabel(reason: ThrottleReason | null): string {
  switch (reason) {
    case "sender_rate_limit": return `Sender exceeded ${PER_SENDER_HOURLY_THRESHOLD} messages in 60 minutes`;
    case "domain_rate_limit": return `Sending domain exceeded ${PER_DOMAIN_HOURLY_THRESHOLD} messages in 60 minutes`;
    case "org_rate_limit":    return `Organization alias exceeded ${PER_ORG_HOURLY_THRESHOLD} messages in 60 minutes`;
    case "global_rate_limit": return `Abuse mailboxes exceeded ${GLOBAL_HOURLY_THRESHOLD} messages in 60 minutes`;
    default:                  return "Rate-limited at capture";
  }
}
