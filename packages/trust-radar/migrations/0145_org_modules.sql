-- 0145_org_modules.sql
-- Per-tenant module entitlements. v3 Phase A foundation.
--
-- One row per (org, module). Status flips drive what shows up in
-- averrow-tenant's sidebar + which API endpoints accept the org.
-- See `lib/entitlements.ts`. Plan in `eager-moseying-papert.md`.
--
-- Module keys (canonical, lowercase, snake_case):
--   domain          — domain monitoring
--   social          — social media impersonation
--   app_store       — app store impersonation (Apple, Google, alternatives)
--   dark_web        — dark web mentions + leaked credentials
--   abuse_mailbox   — customer-branded report-fraud inbox
--   trademark       — logo/wordmark/likeness misuse
--   threat_actor    — actor-centric pivots/MO/kit intel

CREATE TABLE org_modules (
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  module_key    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'trial')),
  activated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  suspended_at  TEXT,
  trial_ends_at TEXT,
  -- Per-tenant override knobs. Defaults come from module_metric_definitions.
  config_json   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, module_key)
);

CREATE INDEX idx_org_modules_status ON org_modules(status);
