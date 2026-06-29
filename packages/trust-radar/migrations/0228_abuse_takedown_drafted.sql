-- Tier 1 (close the loop), part 2: stamp when Sparrow has drafted takedowns
-- for an abuse-mailbox-confirmed phishing report, so each message is
-- processed at most once by createTakedownsFromAbuseReports. Additive,
-- nullable.
ALTER TABLE abuse_inbox_messages ADD COLUMN takedown_drafted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_abuse_takedown_drafted
  ON abuse_inbox_messages(takedown_drafted_at);
