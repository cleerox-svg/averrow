-- PR-AT — Bad-actor spam protection for the abuse mailbox
--
-- Adds per-sender + per-domain rate-limit awareness to the abuse-
-- mailbox capture pipeline. When a single email address or sending
-- domain exceeds the per-hour threshold, the inbound message is
-- still captured (forensic record stays intact) but the downstream
-- cost paths are skipped:
--
--   - Resend ack email (lib/abuse-mailbox-responder.ts sendAck)
--   - Haiku classifier (lib/abuse-mailbox-classifier.ts runAbuseClassifierBackfill)
--   - Resend determination email (same classifier path)
--
-- The capture row is stamped with throttle_reason for operator
-- audit + UI display. Operators can manually unmark throttle and
-- reprocess via the existing backfill endpoint after reviewing.
--
-- New columns (all nullable / defaulted):
--   forwarded_by_domain — extracted from forwarded_by_email at INSERT
--   throttled           — 0 (default) | 1 (rate-limited at insert time)
--   throttle_reason     — 'sender_rate_limit' | 'domain_rate_limit' | NULL
--
-- Indexes support the hot-path COUNT(*) queries from the throttle
-- decision (each sender/domain's rolling 60-minute window):
--   idx_abuse_inbox_sender_recent  — (forwarded_by_email, received_at)
--   idx_abuse_inbox_domain_recent  — (forwarded_by_domain, received_at)

ALTER TABLE abuse_inbox_messages ADD COLUMN forwarded_by_domain TEXT;
ALTER TABLE abuse_inbox_messages ADD COLUMN throttled           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE abuse_inbox_messages ADD COLUMN throttle_reason     TEXT;

CREATE INDEX IF NOT EXISTS idx_abuse_inbox_sender_recent
  ON abuse_inbox_messages (forwarded_by_email, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_abuse_inbox_domain_recent
  ON abuse_inbox_messages (forwarded_by_domain, received_at DESC);
