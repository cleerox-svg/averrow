-- Abuse Mailbox — per-tenant inbox for forwarded suspicious emails.
--
-- Two-table additive layout:
--
--   org_abuse_aliases      one row per org; the verify-<tenant>@averrow.com
--                          alias the customer's employees forward to.
--
--   abuse_inbox_messages   one row per forwarded message; classified +
--                          severity-scored after the Email Worker
--                          processes it (Email Worker wiring lands in a
--                          follow-up sprint; this schema is read-side
--                          ready now).
--
-- Tenant scope: org_id on every row; brand_id may be NULL until the
-- classifier binds the message to a known brand.
--
-- Phase B sprint 6.

CREATE TABLE IF NOT EXISTS org_abuse_aliases (
  org_id                  INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  alias                   TEXT NOT NULL UNIQUE,         -- e.g. "verify-acme@averrow.com"
  forwarding_instructions TEXT,                          -- markdown shown to customer
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS abuse_inbox_messages (
  id TEXT PRIMARY KEY,
  org_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  brand_id TEXT             REFERENCES brands(id)        ON DELETE SET NULL,

  -- Inbound metadata
  received_at        TEXT NOT NULL DEFAULT (datetime('now')),
  forwarded_by_email TEXT,                  -- person who forwarded the suspicious mail
  inbound_alias      TEXT,                  -- which alias caught it (matches org_abuse_aliases.alias)

  -- Original message snapshot
  original_from         TEXT,
  original_subject      TEXT,
  original_body_snippet TEXT,               -- truncated <= 500 chars
  attachment_count      INTEGER NOT NULL DEFAULT 0,
  url_count             INTEGER NOT NULL DEFAULT 0,

  -- Classification
  classification            TEXT    NOT NULL DEFAULT 'pending',  -- pending | phishing | spam | benign | malware | ambiguous
  classified_by             TEXT,                                 -- ai | manual
  classification_confidence REAL,
  classification_reason     TEXT,
  ai_assessment             TEXT,
  ai_action                 TEXT,                                 -- safe | review | escalate | takedown

  -- Risk
  severity TEXT NOT NULL DEFAULT 'LOW',     -- LOW | MEDIUM | HIGH | CRITICAL
  status   TEXT NOT NULL DEFAULT 'new',     -- new | investigating | resolved | dismissed

  -- Two-response flow (instant ack + 24h determination)
  ack_sent_at           TEXT,
  determination_sent_at TEXT,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_abuse_inbox_org_status
  ON abuse_inbox_messages (org_id, status);

CREATE INDEX IF NOT EXISTS idx_abuse_inbox_brand
  ON abuse_inbox_messages (brand_id);

CREATE INDEX IF NOT EXISTS idx_abuse_inbox_received
  ON abuse_inbox_messages (org_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_abuse_inbox_severity_status
  ON abuse_inbox_messages (org_id, severity)
  WHERE status IN ('new', 'investigating');
