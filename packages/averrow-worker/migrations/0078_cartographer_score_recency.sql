-- Add recency tracking columns to hosting_providers so cartographer
-- can skip re-scoring providers whose data hasn't changed materially.

ALTER TABLE hosting_providers ADD COLUMN last_scored_at TEXT;
ALTER TABLE hosting_providers ADD COLUMN last_score INTEGER;
ALTER TABLE hosting_providers ADD COLUMN last_score_threat_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_hosting_providers_score_recency
  ON hosting_providers(last_scored_at)
  WHERE total_threat_count > 0;
