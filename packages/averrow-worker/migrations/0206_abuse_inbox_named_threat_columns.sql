-- Migration 0206: Technique + named-threat columns on abuse_inbox_messages
--
-- The abuse-mailbox classifier now runs a device-code-phishing technique
-- detector + the named-threat matcher on each captured message. These
-- columns record the result so the operator UI can show "Identified:
-- Kali365 (device-code phishing)" and so the signal is auditable even
-- when no malicious URL was promotable (device-code lures often carry
-- only a legitimate Microsoft endpoint + a code).

ALTER TABLE abuse_inbox_messages ADD COLUMN detected_technique TEXT;
ALTER TABLE abuse_inbox_messages ADD COLUMN named_threat_id TEXT;
ALTER TABLE abuse_inbox_messages ADD COLUMN named_threat_name TEXT;
