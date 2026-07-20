-- 0244: Executive identity registry — Stage 1 of the executive
--       social-impersonation feature (EXEC_IMPERSONATION_2026-07).
--
-- Registers a customer org's named executives so later stages can detect
-- fake social profiles impersonating them. ADD-only: one new table, no
-- change to any existing table.
--
-- Each exec links to a brand (brand_id) because alerts on this platform
-- are brand-scoped (createAlert requires a brandId) — the link lets
-- downstream detection route through the existing brand-scoped alert path.
--
-- Type choices match the neighbouring org-scoped tables:
--   org_id   INTEGER  → organizations(id)   (as in investigations/org_brands)
--   brand_id TEXT     → brands(id)          (brands.id is TEXT)
--   id       TEXT      UUID PK              (as in investigations/app_store_listings)
--
-- The detection agent, the alert type, the triage rule, and the UI are
-- Stages 2-5 — intentionally NOT in this migration. `photo_ref` is
-- declared now for the later photo-match gate but is unused this stage.

CREATE TABLE IF NOT EXISTS org_executives (
  id TEXT PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,

  full_name TEXT NOT NULL,
  title TEXT,

  official_handles TEXT,          -- JSON object: platform -> handle (mirrors brands.official_handles)
  watch_platforms TEXT,           -- JSON array of platform keys to monitor (social-monitor's 6)
  photo_ref TEXT,                 -- reserved for the later photo-match gate; unused Stage 1

  status TEXT NOT NULL DEFAULT 'active',   -- active | paused

  -- The handler writes ISO/UTC (new Date().toISOString()) on BOTH create
  -- and update so the two columns never diverge in format. These SQL
  -- DEFAULTs (space form, no Z) are a fallback only.
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- List by org (the primary tenant query) + org-scoped brand filter.
CREATE INDEX IF NOT EXISTS idx_org_executives_org
  ON org_executives (org_id);
CREATE INDEX IF NOT EXISTS idx_org_executives_org_brand
  ON org_executives (org_id, brand_id);

-- Detection stage will scan the registry by brand.
CREATE INDEX IF NOT EXISTS idx_org_executives_brand
  ON org_executives (brand_id);
