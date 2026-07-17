-- 0156_brand_tiering.sql
-- brands.tier — sprawl management for the 100K-brand catalog.
--
-- Without tiering, the brands list dilutes once we cross 50K rows:
-- most Tranco-imported brands have zero threats and zero customer
-- interest. Surfacing all of them on the operator UI by default makes
-- the page useless. Tiering puts a control valve in place.
--
--   tracked   — passively watched (no threats, no customer interest).
--               Default for Tranco-imported brands. Hidden from the
--               default brands list view.
--   monitored — has threats > 0 OR fit_score above threshold OR
--               appears in CT-driven candidate set. Brands the platform
--               actively cares about. Default visibility.
--   customer  — bound to an org via org_brands. Highest-priority
--               surface; always visible.
--
-- The /brands-v3 list defaults to tier IN ('monitored', 'customer');
-- "show everything" is opt-in. Sales prospecting (the Prospects tab)
-- can elevate `tracked` rows when their fit_score warrants it without
-- promoting them to `monitored`.

ALTER TABLE brands ADD COLUMN tier TEXT NOT NULL DEFAULT 'tracked'
  CHECK (tier IN ('tracked', 'monitored', 'customer'));

CREATE INDEX IF NOT EXISTS idx_brands_tier ON brands(tier);

-- Backfill: brands already bound to an org are 'customer'.
UPDATE brands SET tier = 'customer'
WHERE id IN (SELECT DISTINCT brand_id FROM org_brands);

-- Backfill: brands with active threat history are 'monitored' (unless customer).
UPDATE brands SET tier = 'monitored'
WHERE tier = 'tracked' AND threat_count > 0;
