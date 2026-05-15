// Averrow — Abuse Mailbox spam-protection / rate-limit decision
//
// Single bad actor (or botnet sharing a sending domain) can flood
// the public abuse aliases with thousands of submissions in minutes.
// Without protection, each submission triggers:
//
//   - 1 Resend API call (ack email)
//   - 1 Haiku classification call (~$0.001)
//   - 1 Resend API call (determination email)
//
// At 10k spam submissions the unprotected path costs ~$10 in Haiku
// + ~$2 in Resend. The protected path keeps the forensic INSERT but
// skips all three downstream costs.
//
// Storage choice: query the `abuse_inbox_messages` table directly
// over a 60-minute window. No new infrastructure — D1 is already
// there and the (forwarded_by_email, received_at) +
// (forwarded_by_domain, received_at) indexes from migration 0185
// keep these COUNT(*)s in the single-digit-millisecond range even
// at very high inbound rates (the window scan covers <100 rows in
// the worst legitimate case).
//
// Thresholds (per the bad-actor protection product decision):
//
//   PER_SENDER_HOURLY_THRESHOLD = 20
//   PER_DOMAIN_HOURLY_THRESHOLD = 50
//   WINDOW_MINUTES              = 60
//
// Sender rule fires first (the typical attack pattern is one address
// flooding). Domain rule catches the botnet-on-one-domain case.
//
// Reactivation: when an operator clears the throttle on a specific
// row (UPDATE abuse_inbox_messages SET throttled = 0 WHERE id = ?),
// the classifier will pick it up on its next backfill pass. No
// per-sender unblock is needed — the rolling window naturally
// re-permits the sender once their rate drops below threshold.

import type { Env } from "../types";

export const PER_SENDER_HOURLY_THRESHOLD = 20;
export const PER_DOMAIN_HOURLY_THRESHOLD = 50;
export const WINDOW_MINUTES              = 60;

export type ThrottleReason = "sender_rate_limit" | "domain_rate_limit";

export interface ThrottleDecision {
  /** Whether the inbound message should bypass ack + classifier + determination. */
  throttled: boolean;
  /** Which rule fired, if any. */
  reason: ThrottleReason | null;
  /** Counts seen in the rolling window — surfaced in admin UI for diagnostics. */
  sender_count_last_window: number;
  domain_count_last_window: number;
  /** Echoed back so the caller doesn't need to re-derive. */
  sender_email: string | null;
  sender_domain: string | null;
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

/**
 * Compute the throttle decision for an incoming message. Reads from
 * D1 only — no writes. Caller stamps the row with the decision.
 *
 * Sender threshold check runs first: if a single address is flooding,
 * we want to attribute the throttle to the sender (more specific +
 * actionable) rather than the broader domain.
 */
export async function decideAbuseMailboxThrottle(
  env: Env,
  senderEmail: string | null,
): Promise<ThrottleDecision> {
  const senderDomain = extractSenderDomain(senderEmail);

  // No sender → nothing to rate-limit on. Pass through.
  if (!senderEmail) {
    return {
      throttled: false,
      reason: null,
      sender_count_last_window: 0,
      domain_count_last_window: 0,
      sender_email: null,
      sender_domain: senderDomain,
    };
  }

  // Run sender + domain counts in parallel — independent reads, both
  // hit fresh-but-not-stale indexes from migration 0185.
  const windowExpr = `datetime('now', '-${WINDOW_MINUTES} minutes')`;
  const [senderRow, domainRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM abuse_inbox_messages
       WHERE forwarded_by_email = ? AND received_at > ${windowExpr}`,
    ).bind(senderEmail).first<{ n: number }>(),
    senderDomain
      ? env.DB.prepare(
          `SELECT COUNT(*) AS n FROM abuse_inbox_messages
           WHERE forwarded_by_domain = ? AND received_at > ${windowExpr}`,
        ).bind(senderDomain).first<{ n: number }>()
      : Promise.resolve({ n: 0 } as { n: number }),
  ]);

  const senderCount = senderRow?.n ?? 0;
  const domainCount = domainRow?.n ?? 0;

  // Sender rule fires before domain rule — more specific attribution.
  if (senderCount >= PER_SENDER_HOURLY_THRESHOLD) {
    return {
      throttled: true,
      reason: "sender_rate_limit",
      sender_count_last_window: senderCount,
      domain_count_last_window: domainCount,
      sender_email: senderEmail,
      sender_domain: senderDomain,
    };
  }
  if (senderDomain && domainCount >= PER_DOMAIN_HOURLY_THRESHOLD) {
    return {
      throttled: true,
      reason: "domain_rate_limit",
      sender_count_last_window: senderCount,
      domain_count_last_window: domainCount,
      sender_email: senderEmail,
      sender_domain: senderDomain,
    };
  }

  return {
    throttled: false,
    reason: null,
    sender_count_last_window: senderCount,
    domain_count_last_window: domainCount,
    sender_email: senderEmail,
    sender_domain: senderDomain,
  };
}
