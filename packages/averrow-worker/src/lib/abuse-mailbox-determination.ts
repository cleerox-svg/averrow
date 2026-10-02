// Averrow — Abuse Mailbox determination delivery (idempotent)
//
// Single path for sending the determination email for one
// abuse_inbox_messages row, shared by:
//   - the per-message AbuseMailboxTriageWorkflow (after its ~2 min sleep)
//   - the AI classifier (lib/abuse-mailbox-classifier.ts)
//   - the hourly sweeper (sweepAbuseDeterminations, run by the
//     `17 * * * *` abuse_mailbox_classifier agent)
//
// Exactly-once: the send is preceded by an atomic claim —
//   UPDATE … SET determination_sent_at = now WHERE id = ? AND
//   determination_sent_at IS NULL AND <eligible>
// Only the caller whose UPDATE changed the row sends. A transient send
// failure releases the claim (determination_sent_at back to NULL) so the
// sweeper retries; a permanent suppression (opted-out, own-domain loop,
// malformed address) releases it AND stamps responder_suppressed_reason so
// the sweeper stops re-claiming the row.

import type { Env } from "../types";
import { logger } from "./logger";

/** sendDetermination reasons that will never succeed on retry. */
const PERMANENT_SUPPRESSIONS = new Set([
  "no-address", "empty-address", "malformed-address", "own-domain-loop", "opted-out",
]);

/** Sweeper looks back this far for undelivered determinations. */
const SWEEP_LOOKBACK = "-2 days";

export type DeliveryOutcome =
  | "sent"
  | "already_sent"
  | "not_ready"           // still pending / follow_up / throttled / suppressed / no forwarder
  | "claimed_elsewhere"   // a concurrent caller won the claim
  | "suppressed"          // permanent responder suppression recorded
  | "send_failed";        // transient failure; claim released for retry

interface DeterminationRow {
  id:                        string;
  org_id:                    number;
  forwarded_by_email:        string | null;
  inbound_alias:             string | null;
  original_subject:          string | null;
  classification:            string;
  classified_by:             string | null;
  classification_confidence: number | null;
  classification_reason:     string | null;
  ai_action:                 string | null;
  auth_results:              string | null;
  url_count:                 number | null;
  attachment_count:          number | null;
  correlated_threat_ids:     string | null;
  promoted_threat_ids:       string | null;
  deep_analysis:             string | null;
  determination_sent_at:     string | null;
  throttled:                 number | null;
  responder_suppressed_reason: string | null;
  is_attachment_forward:     number | null;
}

function parseJsonSafe<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function jsonArrayLength(s: string | null | undefined): number {
  const v = parseJsonSafe<unknown>(s);
  return Array.isArray(v) ? v.length : 0;
}

/**
 * Send the determination email for `messageId` at most once.
 * Never throws — failures are logged and reported in the outcome.
 */
export async function deliverAbuseDetermination(env: Env, messageId: string): Promise<DeliveryOutcome> {
  let row: DeterminationRow | null;
  try {
    row = await env.DB.prepare(`
      SELECT id, org_id, forwarded_by_email, inbound_alias, original_subject,
             classification, classified_by, classification_confidence,
             classification_reason, ai_action, auth_results, url_count,
             attachment_count, correlated_threat_ids, promoted_threat_ids,
             deep_analysis, determination_sent_at, throttled,
             responder_suppressed_reason,
             CASE WHEN instr(COALESCE(raw_headers, ''), '"_forwarded_inner":') > 0 THEN 1 ELSE 0 END
               AS is_attachment_forward
      FROM abuse_inbox_messages
      WHERE id = ?
    `).bind(messageId).first<DeterminationRow>();
  } catch (err) {
    logger.warn("abuse_determination_load_failed", {
      message_id: messageId, error: err instanceof Error ? err.message : String(err),
    });
    return "send_failed";
  }
  if (!row) return "not_ready";
  if (row.determination_sent_at) return "already_sent";
  if (row.classification === "pending" || row.classification === "follow_up") return "not_ready";
  if ((row.throttled ?? 0) !== 0 || row.responder_suppressed_reason || !row.forwarded_by_email) {
    return "not_ready";
  }

  // Atomic claim — only the caller that flips NULL → now sends.
  try {
    const claim = await env.DB.prepare(`
      UPDATE abuse_inbox_messages
      SET determination_sent_at = datetime('now')
      WHERE id = ?
        AND determination_sent_at IS NULL
        AND responder_suppressed_reason IS NULL
        AND COALESCE(throttled, 0) = 0
        AND classification NOT IN ('pending', 'follow_up')
    `).bind(messageId).run();
    const changes = typeof claim.meta?.changes === "number" ? claim.meta.changes : 1;
    if (changes === 0) return "claimed_elsewhere";
  } catch (err) {
    // Fails closed (no email) — e.g. migration 0273 not yet applied.
    logger.warn("abuse_determination_claim_failed", {
      message_id: messageId, error: err instanceof Error ? err.message : String(err),
    });
    return "send_failed";
  }

  const isRules = row.classified_by === "rules";
  const authResults = parseJsonSafe<{ spf: string | null; dkim: string | null; dmarc: string | null }>(row.auth_results);
  const deep = parseJsonSafe<{ external_narrative?: unknown }>(row.deep_analysis);
  const deepExternal = !isRules && typeof deep?.external_narrative === "string" ? deep.external_narrative : null;

  let result: { ok: boolean; reason: string };
  try {
    const { sendDetermination } = await import("./abuse-mailbox-responder");
    const { loadAbuseBranding } = await import("./abuse-mailbox-branding");
    const { primaryRuleFromReason } = await import("./abuse-mailbox-rules");
    const branding = await loadAbuseBranding(env, row.org_id);
    const rule = isRules ? primaryRuleFromReason(row.classification_reason) : null;
    result = await sendDetermination(env, row.forwarded_by_email, {
      messageId:       row.id,
      inboundAlias:    row.inbound_alias,
      originalSubject: row.original_subject,
      classification:  row.classification,
      confidence:      Math.round(row.classification_confidence ?? 0),
      // Rules verdicts never pass their reason codes into the email —
      // the responder renders a fixed sentence per rule instead.
      reasoning:       isRules ? "" : (row.classification_reason ?? ""),
      action:          row.ai_action ?? "review",
      classifiedBy:    row.classified_by,
      rulesRule:       rule,
      // Rules: auth only describes the original sender on a
      // forward-as-attachment, and only ever pushes toward review — so
      // pass it only then, and only when something failed.
      authResults: isRules
        ? (row.is_attachment_forward === 1 && authResults &&
           [authResults.spf, authResults.dkim, authResults.dmarc].some((v) => v === "fail" || v === "softfail" || v === "permerror")
            ? authResults : null)
        : authResults,
      urlCount:        row.url_count ?? 0,
      attachmentCount: row.attachment_count ?? 0,
      // Rules: only claim "matches patterns we're tracking" when M1 fired.
      correlatedCount: isRules && rule !== "M1" ? 0 : jsonArrayLength(row.correlated_threat_ids),
      promotedCount:   jsonArrayLength(row.promoted_threat_ids),
      deepAnalysisExternal: deepExternal,
    }, branding);
  } catch (err) {
    result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (result.ok) return "sent";

  // Release the claim; record permanent suppressions so the sweeper stops.
  const permanent = PERMANENT_SUPPRESSIONS.has(result.reason);
  try {
    await env.DB.prepare(`
      UPDATE abuse_inbox_messages
      SET determination_sent_at = NULL,
          responder_suppressed_reason = COALESCE(responder_suppressed_reason, ?)
      WHERE id = ?
    `).bind(permanent ? `determination:${result.reason}` : null, messageId).run();
  } catch (err) {
    logger.warn("abuse_determination_release_failed", {
      message_id: messageId, error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!permanent) {
    logger.warn("abuse_determination_send_failed", { message_id: messageId, reason: result.reason.slice(0, 200) });
  }
  return permanent ? "suppressed" : "send_failed";
}

export interface SweepResult {
  candidates: number;
  sent:       number;
  other:      number;
}

/**
 * Hourly sweeper: deliver determinations the per-message Workflow missed
 * (dispatch failed, binding absent, transient Resend failure). Bounded to
 * recent rows classified by the automated paths; 'manual' operator
 * verdicts are not auto-emailed (unchanged behaviour).
 */
export async function sweepAbuseDeterminations(env: Env, opts?: { limit?: number }): Promise<SweepResult> {
  const limit = Math.max(1, Math.min(200, opts?.limit ?? 50));
  const rows = await env.DB.prepare(`
    SELECT id
    FROM abuse_inbox_messages
    WHERE determination_sent_at IS NULL
      AND responder_suppressed_reason IS NULL
      AND COALESCE(throttled, 0) = 0
      AND forwarded_by_email IS NOT NULL
      AND classification NOT IN ('pending', 'follow_up')
      AND classified_by IN ('rules', 'ai')
      AND received_at >= datetime('now', ?)
    ORDER BY received_at ASC
    LIMIT ?
  `).bind(SWEEP_LOOKBACK, limit).all<{ id: string }>();
  const ids = (rows.results ?? []).map((r) => r.id);
  const out: SweepResult = { candidates: ids.length, sent: 0, other: 0 };
  for (const id of ids) {
    const outcome = await deliverAbuseDetermination(env, id);
    if (outcome === "sent") out.sent += 1;
    else out.other += 1;
  }
  return out;
}
