-- 0160_brand_groups.sql
-- Portfolio / holding-company support. v3 research validated this is
-- enterprise-tier table-stakes (CSC DBS, Group-IB, ZeroFox, Fortra all
-- support multi-brand portfolios at enterprise tier). No vendor
-- publishes their schema, and customer structures vary, so we model
-- BOTH shapes:
--
--   brand_parent_id        — hierarchical (conglomerate with subsidiaries:
--                            Acme Corp owns Acme Bank, Acme Insurance, etc.)
--   brand_groups + members — flat tagging (PE portfolio, brand families
--                            that aren't structurally hierarchical)
--
-- Either model can satisfy "show me all brands under X" depending on
-- which the customer's structure naturally fits. Customers pick at
-- onboarding; the platform supports both.
--
-- Tenant-safe by design:
--   - brand_parent_id sits on `brands` — already scope-filtered by
--     org_brands binding; tenants only see parents/children of their
--     bound brands.
--   - brand_groups has org_id FK — implicit per-tenant separation.
--     Different orgs cannot see each other's groupings.

ALTER TABLE brands ADD COLUMN brand_parent_id TEXT REFERENCES brands(id);
CREATE INDEX IF NOT EXISTS idx_brands_parent ON brands(brand_parent_id);

CREATE TABLE IF NOT EXISTS brand_groups (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  created_by      TEXT,                           -- user_id
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS brand_group_members (
  group_id        TEXT NOT NULL REFERENCES brand_groups(id) ON DELETE CASCADE,
  brand_id        TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, brand_id)
);

CREATE INDEX IF NOT EXISTS idx_brand_groups_org           ON brand_groups(org_id);
CREATE INDEX IF NOT EXISTS idx_brand_group_members_brand  ON brand_group_members(brand_id);
