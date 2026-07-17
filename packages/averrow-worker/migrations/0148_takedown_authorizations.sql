-- 0148_takedown_authorizations.sql
-- Per-tenant takedown authorization records. v3 Phase A foundation.
--
-- A customer signs a blanket authorization once; it covers takedown
-- requests across whichever modules they've licensed (per scope_json).
-- The record is the audit trail Sparrow + the takedown submitters
-- check before automating any provider abuse-report submission.
--
-- Lifecycle:
--   active   — signed; takedown automation may proceed within scope
--   revoked  — customer has withdrawn consent; new takedowns blocked
--   expired  — agreement_version superseded; replaced row goes active
--
-- Only one row may be 'active' per org at any time. agreement_version
-- bumps when MSA copy changes; tenant must re-sign.
--
-- See `lib/takedown-authorizations.ts` for the reader/writer.
-- Plan: `eager-moseying-papert.md` Phase A item 5.

CREATE TABLE takedown_authorizations (
  id                 TEXT PRIMARY KEY,
  org_id             INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agreement_version  TEXT NOT NULL,         -- e.g. 'msa-2026-05'
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'revoked', 'expired')),
  -- Who signed it on the customer side
  signed_at          TEXT NOT NULL DEFAULT (datetime('now')),
  signed_by_user_id  TEXT NOT NULL REFERENCES users(id),
  signed_ip          TEXT,                  -- audit trail
  signed_user_agent  TEXT,                  -- audit trail
  -- What the customer consented to. JSON shape (validated by reader):
  --   {
  --     "modules": ["domain","social","app_store","trademark","abuse_mailbox"],
  --     "max_takedowns_per_month": 500 | null,
  --     "escalation": "auto_resubmit_on_pivot" | "manual_only",
  --     "auto_followup_breached_sla_hours": 48 | null,
  --     "high_risk_requires_per_takedown_approval": true | false
  --   }
  scope_json         TEXT NOT NULL,
  -- When the customer revoked / replaced (NULL while active)
  revoked_at         TEXT,
  revoked_by_user_id TEXT REFERENCES users(id),
  revoked_reason     TEXT,
  -- Bookkeeping
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Active-row lookup is the hot path (Sparrow checks it before every
-- automated submission). Composite index keeps it cheap.
CREATE INDEX idx_takedown_auth_active
  ON takedown_authorizations(org_id, status);

-- Only one active authorization per org at a time. Replaces the row
-- on re-sign (insert with new agreement_version, mark prior as expired).
CREATE UNIQUE INDEX idx_takedown_auth_one_active_per_org
  ON takedown_authorizations(org_id) WHERE status = 'active';
