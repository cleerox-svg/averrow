-- 0328_email_security_dmarcbis_tags.sql
-- RFC 9989 (DMARCbis, May 2026) obsoletes RFC 7489. It deprecates `pct`
-- and adds `np` (non-existent-subdomain policy), `psd` (Public Suffix
-- Domain flag) and `t` (testing mode). The posture scanner
-- (src/email-security.ts + src/lib/dmarc-record.ts) now parses them; `sp`
-- (existing-subdomain policy) was never stored either and is the RFC 9989
-- fallback for `np`, so it is added alongside.
--
-- Follows the existing per-tag column convention on email_security_scans
-- (dmarc_pct, dmarc_rua, dmarc_ruf). `dmarc_pct` stays and is still
-- written. ADD COLUMN only, all nullable; older rows read NULL ("not
-- captured"), which every reader already tolerates. No backfill: the next
-- scan of each brand writes them.

ALTER TABLE email_security_scans ADD COLUMN dmarc_sp TEXT;
ALTER TABLE email_security_scans ADD COLUMN dmarc_np TEXT;
ALTER TABLE email_security_scans ADD COLUMN dmarc_t TEXT;
ALTER TABLE email_security_scans ADD COLUMN dmarc_psd TEXT;

-- Scoring rubric version (EMAIL_SCORE_RUBRIC_VERSION in email-security.ts).
-- The RFC 9989 rubric (version 2) grades testing-mode and np-gap records
-- lower. Grade-change alerting compares two scans only when both carry the
-- current version, so the first rescan under a new rubric updates the
-- stored grade silently instead of alerting. NULL = pre-version rubric (1).
ALTER TABLE email_security_scans ADD COLUMN score_rubric_version INTEGER;
