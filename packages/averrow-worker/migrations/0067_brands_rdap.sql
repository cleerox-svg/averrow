-- Brand RDAP + sector classification metadata
ALTER TABLE brands ADD COLUMN registrar         TEXT;
ALTER TABLE brands ADD COLUMN registered_at     TEXT;
ALTER TABLE brands ADD COLUMN expires_at        TEXT;
ALTER TABLE brands ADD COLUMN registrant_country TEXT;
ALTER TABLE brands ADD COLUMN sector_classified_at TEXT;
