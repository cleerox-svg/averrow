-- PR-AX — Abuse-mailbox IOC capture, correlation, and promotion
--
-- Adds the fields that bridge a captured forwarded email to the
-- platform's threat intelligence:
--
--   auth_results           — JSON {spf, dkim, dmarc} parsed from the
--                            Authentication-Results header at capture
--                            time. Feeds the classifier prompt for
--                            better verdicts and powers the
--                            structured pill in the drill-down UI.
--
--   sender_ip              — first non-private IP walked from the
--                            Received chain (most-external entry into
--                            the mail relay path). Used for hosting-
--                            provider + threat-actor correlation
--                            downstream.
--
--   correlated_threat_ids  — JSON array of `threats.id` values where
--                            one or more of the message's extracted_urls
--                            already exists. Surfaced in the UI as
--                            "this URL was already flagged 12 days
--                            ago across N brands".
--
--   promoted_threat_ids    — JSON array of `threats.id` values we
--                            CREATED from this submission, on
--                            confirmed phishing/malware HIGH/CRITICAL
--                            verdicts. Allows the UI to show a
--                            "promoted to platform" badge and the
--                            operator to navigate to the new entries.
--
-- All four are nullable. Pre-PR-AX rows keep their existing UI; the
-- drill-down handles the empty state gracefully.

ALTER TABLE abuse_inbox_messages ADD COLUMN auth_results          TEXT;
ALTER TABLE abuse_inbox_messages ADD COLUMN sender_ip             TEXT;
ALTER TABLE abuse_inbox_messages ADD COLUMN correlated_threat_ids TEXT;
ALTER TABLE abuse_inbox_messages ADD COLUMN promoted_threat_ids   TEXT;
