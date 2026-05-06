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

-- alias_name → master_name mapping. Names match the Title-cased form
-- analyst.ts produces (`brand_<name>` id is derived by lowercase).
CREATE TEMP TABLE brand_alias_map (
  alias_lower  TEXT NOT NULL,
  master_lower TEXT NOT NULL
);
INSERT INTO brand_alias_map VALUES
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

-- Build alias_brand_id → master_brand_id mapping. Only emit a row
-- when BOTH the alias brand and the master brand exist; otherwise
-- there's no merge to perform.
CREATE TEMP TABLE brand_dedup AS
SELECT
  alias.id  AS alias_id,
  master.id AS master_id
FROM brand_alias_map m
JOIN brands alias  ON LOWER(alias.name)  = m.alias_lower
JOIN brands master ON LOWER(master.name) = m.master_lower
WHERE alias.id != master.id;

-- Repoint every FK that holds target_brand_id.
UPDATE threats
SET target_brand_id = (
  SELECT master_id FROM brand_dedup WHERE alias_id = threats.target_brand_id
)
WHERE target_brand_id IN (SELECT alias_id FROM brand_dedup);

UPDATE threat_cube_brand
SET target_brand_id = (
  SELECT master_id FROM brand_dedup WHERE alias_id = threat_cube_brand.target_brand_id
)
WHERE target_brand_id IN (SELECT alias_id FROM brand_dedup);

-- takedown_requests + alerts use `brand_id` (not target_brand_id);
-- threats + threat_cube_brand use `target_brand_id`. See migration
-- 0043 (brand_id type fix) for the takedown_requests + org_brands
-- column shape.
UPDATE takedown_requests
SET brand_id = (
  SELECT master_id FROM brand_dedup WHERE alias_id = takedown_requests.brand_id
)
WHERE brand_id IN (SELECT alias_id FROM brand_dedup);

UPDATE alerts
SET brand_id = (
  SELECT master_id FROM brand_dedup WHERE alias_id = alerts.brand_id
)
WHERE brand_id IN (SELECT alias_id FROM brand_dedup);

-- org_brands has its own brand_id column.
UPDATE org_brands
SET brand_id = (
  SELECT master_id FROM brand_dedup WHERE alias_id = org_brands.brand_id
)
WHERE brand_id IN (SELECT alias_id FROM brand_dedup);

-- Delete the now-orphaned alias brands.
DELETE FROM brands WHERE id IN (SELECT alias_id FROM brand_dedup);

DROP TABLE brand_dedup;
DROP TABLE brand_alias_map;
