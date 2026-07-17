-- Dark-web mention monitoring
-- Creates `dark_web_mentions` for findings from paste archives (PSBDMP first;
-- Telegram / HIBP / Flare / DarkOwl land in later slices via the `source`
-- column). `brands.executive_names` already exists (0036_unify_brand_social);
-- we reuse it for the "executive" watch-term type and do not add new columns
-- to brands.

CREATE TABLE IF NOT EXISTS dark_web_mentions (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,

  -- Source identity (extensible across providers)
  source TEXT NOT NULL,                   -- 'pastebin' | 'telegram' | 'hibp' | 'flare' | 'darkowl' | ...
  source_url TEXT NOT NULL,               -- link to the paste / message / breach record
  source_channel TEXT,                    -- channel name, paste id, forum name, etc.
  source_author TEXT,                     -- poster username when known
  posted_at TEXT,                         -- original post timestamp (source clock)

  -- Content
  content_snippet TEXT,                   -- truncated excerpt (<=500 chars)
  content_full_hash TEXT,                 -- SHA256 of full content for future dedup across sources

  -- What matched
  matched_terms TEXT,                     -- JSON array of the brand's watch terms that matched
  match_type TEXT,                        -- 'brand_name' | 'domain' | 'executive' | 'actor_alias' | 'mixed'

  -- Classification
  classification TEXT DEFAULT 'unknown',  -- unknown | confirmed | suspicious | false_positive | resolved
  classified_by TEXT,                     -- system | ai | manual
  classification_confidence REAL,
  classification_reason TEXT,

  -- AI assessment (populated only for rows flagged for review)
  ai_assessment TEXT,
  ai_confidence REAL,
  ai_action TEXT,                         -- safe | review | escalate | takedown
  ai_assessed_at TEXT,

  -- Risk signals
  severity TEXT DEFAULT 'LOW',            -- LOW | MEDIUM | HIGH | CRITICAL
  status TEXT DEFAULT 'active',           -- active | resolved | false_positive | investigating

  -- Timestamps
  first_seen TEXT DEFAULT (datetime('now')),
  last_seen TEXT,
  last_checked TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Dedup: one row per (brand, source, source_url). Re-encounters update the
-- existing row's last_seen / last_checked instead of inserting duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dark_web_mentions_uniq
  ON dark_web_mentions (brand_id, source, source_url);

CREATE INDEX IF NOT EXISTS idx_dark_web_mentions_brand
  ON dark_web_mentions (brand_id);

CREATE INDEX IF NOT EXISTS idx_dark_web_mentions_active_severity
  ON dark_web_mentions (brand_id, severity)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_dark_web_mentions_classification
  ON dark_web_mentions (classification, status);

CREATE INDEX IF NOT EXISTS idx_dark_web_mentions_source
  ON dark_web_mentions (source, status);
