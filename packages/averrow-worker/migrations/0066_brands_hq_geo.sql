-- Brand HQ geolocation + enrichment metadata
ALTER TABLE brands ADD COLUMN hq_lat      REAL;
ALTER TABLE brands ADD COLUMN hq_lng      REAL;
ALTER TABLE brands ADD COLUMN hq_country  TEXT;
ALTER TABLE brands ADD COLUMN hq_ip       TEXT;
ALTER TABLE brands ADD COLUMN enriched_at TEXT;
