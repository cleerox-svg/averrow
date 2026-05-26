-- Migration 0205: Technique + named-threat attribution on threats
--
-- threats.threat_type has a fixed CHECK constraint (the 5 base types).
-- Rather than recreate the table to add 'device_code_phishing' as a
-- type, we keep such threats as threat_type='phishing' and carry the
-- finer-grained TTP in a new nullable `technique` column, plus a link
-- to the named-threat catalog (migration 0204) in `named_threat_id`.
--
-- Both are ADD COLUMN only (no DROP/ALTER of existing columns).

ALTER TABLE threats ADD COLUMN technique TEXT;
ALTER TABLE threats ADD COLUMN named_threat_id TEXT REFERENCES named_threats(id);

CREATE INDEX IF NOT EXISTS idx_threats_technique ON threats(technique);
CREATE INDEX IF NOT EXISTS idx_threats_named_threat ON threats(named_threat_id);
