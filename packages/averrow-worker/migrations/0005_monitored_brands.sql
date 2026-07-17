-- Trust Radar v2 — Brand Monitoring Table
-- monitored_brands

CREATE TABLE IF NOT EXISTS monitored_brands (
  brand_id   TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL DEFAULT '__internal__',  -- '__internal__' for internal monitoring, UUID for tenant scoping
  added_by   TEXT NOT NULL REFERENCES users(id),
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  notes      TEXT,
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('active', 'clean', 'new', 'removed')),
  removed_at TEXT,
  PRIMARY KEY (brand_id, tenant_id)
);

CREATE INDEX idx_monitored_status ON monitored_brands(status);
CREATE INDEX idx_monitored_tenant ON monitored_brands(tenant_id);
