-- Migration 0027: Organizations, org members (SCIM-ready), and org-brand mapping
-- Creates tenant architecture with SCIM provisioning columns built in from the start.

-- ─── Organizations (tenants) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'starter',
  status TEXT NOT NULL DEFAULT 'active',
  invite_code TEXT UNIQUE,
  sso_provider TEXT,
  sso_config_json TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,
  max_brands INTEGER DEFAULT 5,
  max_members INTEGER DEFAULT 10,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orgs_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_orgs_invite ON organizations(invite_code);

-- ─── Organization Members (SCIM-ready) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  status TEXT NOT NULL DEFAULT 'active',
  invited_by INTEGER,
  invited_at TEXT,
  accepted_at TEXT,
  last_active_at TEXT,
  -- SCIM provisioning columns (ready for future IdP integration)
  scim_external_id TEXT,
  scim_user_name TEXT,
  provisioned_by TEXT NOT NULL DEFAULT 'manual',
  deprovisioned_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_members_org ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_members_scim_ext ON org_members(scim_external_id);

-- ─── Brand-to-Organization Mapping ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  brand_id INTEGER NOT NULL,
  is_primary INTEGER DEFAULT 0,
  monitoring_config_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id),
  FOREIGN KEY (brand_id) REFERENCES brands(id),
  UNIQUE(org_id, brand_id)
);

CREATE INDEX IF NOT EXISTS idx_org_brands_org ON org_brands(org_id);
CREATE INDEX IF NOT EXISTS idx_org_brands_brand ON org_brands(brand_id);
