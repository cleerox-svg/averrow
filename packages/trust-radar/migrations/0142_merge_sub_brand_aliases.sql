-- Migration 0142 — merge infrastructure sub-brand rows into masters.
--
-- Audit 2026-05-06 (audit C10) caught "AMAZONSES" rendered as a
-- standalone brand on a Takedowns card. Amazon SES is AWS email
-- infrastructure, not a brand. Same problem in the wild for other
-- service / CDN sub-domains that Haiku occasionally tags as brands:
-- cloudfront.net, googleapis.com, gstatic.com, mzstatic.com,
-- nflxvideo.net, etc.
--
-- analyst.ts now runs `resolveMasterBrandName()` before INSERT so
-- new threats fold correctly. This migration cleans up the existing
-- alias rows by repointing threats / takedowns / etc. to the master
-- and deleting the alias.
--
-- Only INFRASTRUCTURE / SERVICE sub-brands are merged here.
-- Consumer-facing sub-brands like Outlook, Instagram, WhatsApp,
-- YouTube keep their own rows — they have independent brand identity
-- to customers. The list below is intentionally conservative.
--
-- D1's migration runner executes statements via separate API calls,
-- so CREATE TEMP TABLE doesn't persist across statements. Use
-- regular tables instead, dropped at the end.

DROP TABLE IF EXISTS _brand_alias_map_0142;
DROP TABLE IF EXISTS _brand_dedup_0142;

CREATE TABLE _brand_alias_map_0142 (
  alias_lower  TEXT NOT NULL,
  master_lower TEXT NOT NULL
);

INSERT INTO _brand_alias_map_0142 (alias_lower, master_lower) VALUES
  ('amazonses',         'amazon'),
  ('amazonaws',         'amazon'),
  ('cloudfront',        'amazon'),
  ('googleapis',        'google'),
  ('gstatic',           'google'),
  ('googleusercontent', 'google'),
  ('googlesyndication', 'google'),
  ('googleadservices',  'google'),
  ('google-analytics',  'google'),
  ('mzstatic',          'apple'),
  ('apple-dns',         'apple'),
  ('fbcdn',             'facebook'),
  ('nflxvideo',         'netflix'),
  ('nflximg',           'netflix'),
  ('nflxext',           'netflix'),
  ('nflxso',            'netflix'),
  ('rbxcdn',            'roblox'),
  ('paypalobjects',     'paypal'),
  ('braintreegateway',  'paypal');

CREATE TABLE _brand_dedup_0142 (
  alias_id  TEXT,
  master_id TEXT
);

-- Only emit rows when BOTH alias and master brands exist.
INSERT INTO _brand_dedup_0142 (alias_id, master_id)
SELECT
  alias.id  AS alias_id,
  master.id AS master_id
FROM _brand_alias_map_0142 m
JOIN brands alias  ON LOWER(alias.name)  = m.alias_lower
JOIN brands master ON LOWER(master.name) = m.master_lower
WHERE alias.id != master.id;

-- Repoint threats.target_brand_id.
UPDATE threats
SET target_brand_id = (
  SELECT master_id FROM _brand_dedup_0142 WHERE alias_id = threats.target_brand_id
)
WHERE target_brand_id IN (SELECT alias_id FROM _brand_dedup_0142);

-- threat_cube_brand's PK includes target_brand_id; UPDATE collides
-- with pre-existing master-id rows. Drop the alias rows instead.
-- cube-healer (cron 12 */6 * * *) rebuilds 30 days of brand cubes
-- from threats every 6 hours, picking up the now-master id naturally.
DELETE FROM threat_cube_brand
WHERE target_brand_id IN (SELECT alias_id FROM _brand_dedup_0142);

-- takedown_requests + alerts use `brand_id` (not target_brand_id);
-- see 0029_alerts.sql + 0039_takedown_requests.sql.
UPDATE takedown_requests
SET brand_id = (
  SELECT master_id FROM _brand_dedup_0142 WHERE alias_id = takedown_requests.brand_id
)
WHERE brand_id IN (SELECT alias_id FROM _brand_dedup_0142);

UPDATE alerts
SET brand_id = (
  SELECT master_id FROM _brand_dedup_0142 WHERE alias_id = alerts.brand_id
)
WHERE brand_id IN (SELECT alias_id FROM _brand_dedup_0142);

-- org_brands.brand_id is TEXT post-0043 (was INTEGER, fixed there).
UPDATE org_brands
SET brand_id = (
  SELECT master_id FROM _brand_dedup_0142 WHERE alias_id = org_brands.brand_id
)
WHERE brand_id IN (SELECT alias_id FROM _brand_dedup_0142);

-- Delete the now-orphaned alias brands. D1 doesn't enforce FKs, so
-- references in tables we didn't repoint (sales_leads,
-- email_security_posture, threat_signals_and_assessments) become
-- dangling — acceptable since those surfaces don't render brand
-- names without joining brands.id (which now returns nothing for
-- the alias).
DELETE FROM brands WHERE id IN (SELECT alias_id FROM _brand_dedup_0142);

DROP TABLE _brand_dedup_0142;
DROP TABLE _brand_alias_map_0142;
