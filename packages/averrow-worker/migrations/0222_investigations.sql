-- 0222: Investigations / Cases — the tenant analyst's case object.
--
-- TENANT_ANALYST_UX_RESEARCH_2026-06 #7 (§5.6). A case groups related
-- signals/threats/takedowns under one investigation with a status, an
-- owner, a notes timeline, and an audit trail — the "action a whole
-- cluster at once" surface (BrandShield AI.ClusterX / Doppel Threat
-- Graph precedent). Additive: three new tables, no change to existing
-- ones. org_id is INTEGER to match organizations(id) + org_brands.
-- Child rows cascade on case delete.

CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',          -- open | monitoring | closed
  severity TEXT DEFAULT 'medium',               -- critical | high | medium | low
  assigned_to TEXT REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT
);

-- Polymorphic membership: an item is an alert / threat / takedown by id.
-- No FK on item_id (it spans three tables); UNIQUE prevents double-linking.
CREATE TABLE IF NOT EXISTS investigation_items (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,                       -- alert | threat | takedown
  item_id TEXT NOT NULL,
  note TEXT,
  added_by TEXT REFERENCES users(id),
  added_at TEXT DEFAULT (datetime('now')),
  UNIQUE(investigation_id, item_type, item_id)
);

CREATE TABLE IF NOT EXISTS investigation_notes (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_investigations_org ON investigations(org_id);
CREATE INDEX IF NOT EXISTS idx_investigations_status ON investigations(status);
CREATE INDEX IF NOT EXISTS idx_inv_items_inv ON investigation_items(investigation_id);
CREATE INDEX IF NOT EXISTS idx_inv_items_lookup ON investigation_items(item_type, item_id);
CREATE INDEX IF NOT EXISTS idx_inv_notes_inv ON investigation_notes(investigation_id);
