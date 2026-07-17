-- Pricing config — DB-backed so super_admins can edit baseline tier
-- prices, per-module prices, and per-customer overrides without a
-- code deploy.
--
-- Stripe handles the billing event (charge / invoice / retry); the
-- source of truth for what each org's effective price IS lives in
-- trust-radar.
--
-- Three additive tables:
--
--   pricing_plans          tier definitions (Professional / Business /
--                          Enterprise) with monthly base price and
--                          included module list.
--
--   module_prices          per-module monthly price for à-la-carte /
--                          mix-and-match subscriptions. Covers the
--                          7 customer-facing modules.
--
--   org_pricing_overrides  super_admin records a custom price per org
--                          (discount, enterprise deal, etc.). Append-only
--                          with effective_until so the audit trail
--                          stays intact.
--
-- Plus four columns on organizations to track the Stripe linkage and
-- trial state.
--
-- v3 Phase D Stripe sprint 1.

-- ─── 1. organizations: Stripe linkage + plan + trial ─────────────
ALTER TABLE organizations ADD COLUMN stripe_customer_id     TEXT;
ALTER TABLE organizations ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE organizations ADD COLUMN plan_id                TEXT;          -- FK-soft to pricing_plans.id
ALTER TABLE organizations ADD COLUMN trial_ends_at          TEXT;          -- 14-day default; null after conversion or never-trial
ALTER TABLE organizations ADD COLUMN billing_status         TEXT NOT NULL DEFAULT 'unbilled';
                                                                          -- 'unbilled' | 'trialing' | 'active' | 'past_due' | 'cancelled'

CREATE INDEX IF NOT EXISTS idx_organizations_stripe_customer
  ON organizations(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_billing_status
  ON organizations(billing_status);

-- ─── 2. pricing_plans (tier definitions) ─────────────────────────
CREATE TABLE IF NOT EXISTS pricing_plans (
  id                   TEXT PRIMARY KEY,                    -- 'professional' | 'business' | 'enterprise' | (custom)
  display_name         TEXT NOT NULL,
  monthly_price_cents  INTEGER NOT NULL,                    -- 0 for enterprise (quote-based)
  trial_days           INTEGER NOT NULL DEFAULT 14,
  included_modules     TEXT NOT NULL,                       -- JSON array of ModuleKey strings
  stripe_price_id      TEXT,                                -- env-or-DB Stripe price id; null for enterprise/custom
  description          TEXT,
  is_active            INTEGER NOT NULL DEFAULT 1,          -- soft-delete; lets ops retire a plan without losing audit
  sort_order           INTEGER NOT NULL DEFAULT 0,          -- ascending; controls public pricing-page order
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed the three default tiers from CLAUDE.md. Enterprise is
-- quote-based; price=0 and stripe_price_id NULL signals "custom
-- override required" to the subscription create flow.
INSERT OR IGNORE INTO pricing_plans
  (id, display_name, monthly_price_cents, trial_days, included_modules, stripe_price_id, description, sort_order)
VALUES
  ('professional', 'Professional', 149900, 14,
   '["domain","social","app_store"]',
   NULL,
   'Domain, Social, and App Store impersonation monitoring with auto-takedown.',
   10),
  ('business', 'Business', 399900, 14,
   '["domain","social","app_store","dark_web","trademark"]',
   NULL,
   'Adds Dark Web monitoring + Trademark infringement scanning. For mid-market brands with active threat exposure.',
   20),
  ('enterprise', 'Enterprise', 0, 14,
   '["domain","social","app_store","dark_web","trademark","abuse_mailbox","threat_actor"]',
   NULL,
   'All seven modules, including Abuse Mailbox + Threat-Actor Intelligence. Custom pricing; contact sales.',
   30);

-- ─── 3. module_prices (per-module à-la-carte) ────────────────────
CREATE TABLE IF NOT EXISTS module_prices (
  module_key           TEXT PRIMARY KEY,                    -- ModuleKey
  display_name         TEXT NOT NULL,
  monthly_price_cents  INTEGER NOT NULL,
  stripe_price_id      TEXT,                                -- env-or-DB Stripe price id
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed all 7 customer-facing modules at default à-la-carte prices.
-- Operator can adjust later via the Customers page in averrow-ops.
INSERT OR IGNORE INTO module_prices
  (module_key, display_name, monthly_price_cents, stripe_price_id)
VALUES
  ('domain',        'Domain Monitoring',         59900, NULL),
  ('social',        'Social Impersonation',      49900, NULL),
  ('app_store',     'App Store Impersonation',   49900, NULL),
  ('dark_web',      'Dark Web Monitoring',       79900, NULL),
  ('trademark',     'Trademark Infringement',    69900, NULL),
  ('abuse_mailbox', 'Abuse Mailbox',             39900, NULL),
  ('threat_actor',  'Threat-Actor Intelligence', 99900, NULL);

-- ─── 4. org_pricing_overrides (per-org custom pricing) ───────────
CREATE TABLE IF NOT EXISTS org_pricing_overrides (
  id                  TEXT PRIMARY KEY,
  org_id              INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  override_type       TEXT NOT NULL                                         -- 'tier_price' | 'module_price' | 'discount_percent'
                        CHECK (override_type IN ('tier_price', 'module_price', 'discount_percent')),

  -- The "what gets overridden" pointer. Exactly one of these is set
  -- per row depending on override_type:
  --   tier_price       → plan_id (FK-soft to pricing_plans.id)
  --   module_price     → module_key
  --   discount_percent → null on both — discount applies to the org's
  --                       full subscription
  plan_id             TEXT,
  module_key          TEXT,

  -- The override value. Semantics depend on override_type:
  --   tier_price       → custom_price_cents (negotiated tier price)
  --   module_price     → custom_price_cents (negotiated per-module price)
  --   discount_percent → discount_pct  (0-100)
  custom_price_cents  INTEGER,
  discount_pct        REAL,

  -- Audit
  reason              TEXT NOT NULL,                                         -- "Enterprise deal", "Loyalty discount", etc.
  set_by_user_id      TEXT REFERENCES users(id),
  effective_from      TEXT NOT NULL DEFAULT (datetime('now')),
  effective_until     TEXT,                                                  -- null = open-ended

  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_org_pricing_overrides_org
  ON org_pricing_overrides(org_id, effective_from DESC);

-- Per-org "what's currently active" lookup. effective_until IS NULL
-- (open-ended) OR effective_until > now is the "still active" filter
-- the read handler applies at request time.
CREATE INDEX IF NOT EXISTS idx_org_pricing_overrides_active
  ON org_pricing_overrides(org_id)
  WHERE effective_until IS NULL;
