-- Migration 0273: abuse-mailbox responder suppression, registrable-domain
-- throttle key, and triage-queue indexes.
--
-- ─── abuse_inbox_messages.responder_suppressed_reason ─────────────
-- Records WHY the abuse-mailbox responder deliberately sends no email
-- (ack or determination) for a captured report. Writers:
--
--   1. handlers/abuseMailboxEmail.ts — the backscatter guard, computed
--      BEFORE the INSERT and written by the INSERT itself (fail-closed: a
--      row is never briefly email-eligible). The responder replies only
--      when the topmost Authentication-Results (or ARC-Authentication-
--      Results) header from our own MTA (authserv-id mx.cloudflare.net)
--      reports dmarc=pass for the header-From domain, and that domain's
--      registrable domain matches the SMTP envelope sender's. Codes:
--      'backscatter:invalid_recipient', 'backscatter:domain_mismatch',
--      'backscatter:no_trusted_auth', 'backscatter:dmarc_not_pass'.
--   2. lib/abuse-mailbox-determination.ts — permanent suppressions found
--      at send time ('determination:opted-out', 'determination:own-domain-
--      loop', 'determination:resend_rejected', ...), so the hourly sweeper
--      stops re-claiming a row that will never be emailed.
--   3. lib/abuse-mailbox-rules-runner.ts — 'backlog:stale' for rows the
--      rules pass classifies more than 2 days after receipt.
--   4. This migration — 'legacy:pre_guard' (below).
--
-- NULL = no suppression recorded (the normal case). Additive only.
--
-- ─── abuse_inbox_messages.forwarded_by_reg_domain ─────────────────
-- Registrable domain of the forwarder (lib/abuse-mailbox-throttle.ts), the
-- key of the per-domain flood throttle, so rotating subdomains of one
-- domain share a bucket. NULL on pre-0273 rows (the throttle window is
-- 60 minutes, so no backfill is needed).
--
-- DEPLOY ORDER: apply BEFORE deploying the Worker — the email handler's
-- INSERT names both new columns (ingest fails until they exist), and the
-- determination claim + sweeper filter on responder_suppressed_reason.

ALTER TABLE abuse_inbox_messages ADD COLUMN responder_suppressed_reason TEXT;
ALTER TABLE abuse_inbox_messages ADD COLUMN forwarded_by_reg_domain TEXT;

-- Pre-guard rows were captured without the positive-authentication
-- backscatter guard: never let the determination sweeper email them.
UPDATE abuse_inbox_messages
   SET responder_suppressed_reason = 'legacy:pre_guard'
 WHERE determination_sent_at IS NULL;

-- Per-domain throttle window (forwarded_by_reg_domain, received_at).
CREATE INDEX IF NOT EXISTS idx_abuse_inbox_reg_domain_recent
  ON abuse_inbox_messages (forwarded_by_reg_domain, received_at DESC);

-- Global throttle window + cron gate.
CREATE INDEX IF NOT EXISTS idx_abuse_inbox_received_at
  ON abuse_inbox_messages (received_at);

-- Rules / AI triage queue (rules pass newest-first; AI pass oldest-first).
-- Queries repeat the `classification IN ('pending','ambiguous')` predicate
-- verbatim so SQLite can prove the partial index applies.
CREATE INDEX IF NOT EXISTS idx_abuse_inbox_triage_queue
  ON abuse_inbox_messages (received_at)
  WHERE classification IN ('pending', 'ambiguous');

-- Undelivered-determination sweep + cron gate.
CREATE INDEX IF NOT EXISTS idx_abuse_inbox_undelivered
  ON abuse_inbox_messages (received_at)
  WHERE determination_sent_at IS NULL AND responder_suppressed_reason IS NULL;
