-- 0196_abuse_inbox_classification_attempts.sql
--
-- Poison-pill retry cap for the abuse mailbox classifier.
--
-- Before this migration: `lib/abuse-mailbox-classifier.ts` left rows
-- in `classification='pending'` when Haiku returned null (transport
-- error, parse failure, truncated JSON past maxTokens). The orchestrator
-- re-picked them every hourly tick and re-called Haiku, looping forever.
--
-- Production audit on 2026-05-16 caught one such row (message
-- e0b194b5-76fa-4ac0-b42c-3b9671649062): minimal body parsed from a
-- 15KB forwarded .eml, AI classifier failed silently 6 ticks in a row,
-- ~32% of the day's abuse_mailbox_classifier calls were wasted retries.
--
-- This migration adds the retry budget:
--   - `classification_attempts` — incremented every time the classifier
--      starts processing the row.
--   - `last_classify_error` — captures the error reason so an operator
--      can see what went wrong (truncated JSON, prompt content, etc.).
--
-- The companion code change in `lib/abuse-mailbox-classifier.ts` caps
-- attempts at 3 and auto-graduates the row to classification='ambiguous'
-- with classified_by='auto_graduated'. The pending-SELECT filter adds
-- `AND classification_attempts < 3` so exhausted rows exit the queue.

ALTER TABLE abuse_inbox_messages ADD COLUMN classification_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE abuse_inbox_messages ADD COLUMN last_classify_error TEXT;
