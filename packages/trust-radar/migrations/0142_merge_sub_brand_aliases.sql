-- Migration 0142 — merge infrastructure sub-brand rows into masters.
--
-- Audit 2026-05-06 (audit C10) caught "AMAZONSES" rendered as a
-- standalone brand on a Takedowns card. Amazon SES is AWS email
-- infrastructure, not a brand. Same problem possible for other
-- service / CDN sub-domains that Haiku occasionally tags as brands.
--
-- analyst.ts now runs `resolveMasterBrandName()` before INSERT so
-- new threats fold correctly. This migration cleans up existing
-- alias brand rows by repointing FKs (threats / takedowns / alerts /
-- org_brands) to the master and deleting the alias.
--
-- D1 CONSTRAINTS that shape this file:
--   1. CREATE TEMP TABLE doesn't persist across statements (each
--      statement is a separate API call). Use no temp tables here.
--   2. Each statement has a tight CPU budget. The earlier "single
--      big UPDATE on threats with IN-subquery" hit code 7429
--      (D1 DB exceeded its CPU time limit). Split into per-alias
--      UPDATEs scoped to ONE alias_id at a time so each statement
--      does an indexed lookup on threats(target_brand_id) for
--      a single value rather than scanning a multi-value IN list.
--
-- Pattern per alias (alias_lower, master_lower):
--   UPDATE threats SET target_brand_id = master.id
--     WHERE target_brand_id = alias.id AND EXISTS(master);
--   DELETE FROM threat_cube_brand WHERE target_brand_id = alias.id;
--   UPDATE takedown_requests / alerts / org_brands similarly;
--   DELETE FROM brands WHERE id = alias.id;
--
-- The EXISTS guard prevents writing target_brand_id = NULL when
-- the master brand row doesn't exist (alerts.brand_id is NOT NULL
-- declared). Each block is a no-op if the alias doesn't exist in
-- production — safe to keep the full conservative list.
--
-- Only INFRASTRUCTURE / SERVICE sub-brands are merged here.
-- Consumer-facing sub-brands (Outlook, Instagram, WhatsApp,
-- YouTube) keep their own rows.

-- ─── amazonses → amazon ────────────────────────────────────────
UPDATE threats SET target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazonses' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
DELETE FROM threat_cube_brand
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazonses' LIMIT 1);
UPDATE takedown_requests SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazonses' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
UPDATE alerts SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazonses' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
UPDATE org_brands SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazonses' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
DELETE FROM brands WHERE LOWER(name) = 'amazonses';

-- ─── amazonaws → amazon ────────────────────────────────────────
UPDATE threats SET target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazonaws' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
DELETE FROM threat_cube_brand
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazonaws' LIMIT 1);
UPDATE takedown_requests SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazonaws' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
UPDATE alerts SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazonaws' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
UPDATE org_brands SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazonaws' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
DELETE FROM brands WHERE LOWER(name) = 'amazonaws';

-- ─── cloudfront → amazon ───────────────────────────────────────
UPDATE threats SET target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'cloudfront' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
DELETE FROM threat_cube_brand
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'cloudfront' LIMIT 1);
UPDATE takedown_requests SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'cloudfront' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
UPDATE alerts SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'cloudfront' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
UPDATE org_brands SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'amazon' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'cloudfront' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'amazon');
DELETE FROM brands WHERE LOWER(name) = 'cloudfront';

-- ─── googleapis → google ───────────────────────────────────────
UPDATE threats SET target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'googleapis' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
DELETE FROM threat_cube_brand
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'googleapis' LIMIT 1);
UPDATE takedown_requests SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'googleapis' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
UPDATE alerts SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'googleapis' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
UPDATE org_brands SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'googleapis' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
DELETE FROM brands WHERE LOWER(name) = 'googleapis';

-- ─── gstatic → google ──────────────────────────────────────────
UPDATE threats SET target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'gstatic' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
DELETE FROM threat_cube_brand
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'gstatic' LIMIT 1);
UPDATE takedown_requests SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'gstatic' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
UPDATE alerts SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'gstatic' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
UPDATE org_brands SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'gstatic' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
DELETE FROM brands WHERE LOWER(name) = 'gstatic';

-- ─── googleusercontent → google ────────────────────────────────
UPDATE threats SET target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'googleusercontent' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
DELETE FROM threat_cube_brand
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'googleusercontent' LIMIT 1);
UPDATE takedown_requests SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'googleusercontent' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
UPDATE alerts SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'googleusercontent' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
UPDATE org_brands SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'google' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'googleusercontent' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'google');
DELETE FROM brands WHERE LOWER(name) = 'googleusercontent';

-- ─── mzstatic → apple ──────────────────────────────────────────
UPDATE threats SET target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'apple' LIMIT 1)
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'mzstatic' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'apple');
DELETE FROM threat_cube_brand
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'mzstatic' LIMIT 1);
UPDATE takedown_requests SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'apple' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'mzstatic' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'apple');
UPDATE alerts SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'apple' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'mzstatic' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'apple');
UPDATE org_brands SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'apple' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'mzstatic' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'apple');
DELETE FROM brands WHERE LOWER(name) = 'mzstatic';

-- ─── fbcdn → facebook ──────────────────────────────────────────
UPDATE threats SET target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'facebook' LIMIT 1)
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'fbcdn' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'facebook');
DELETE FROM threat_cube_brand
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'fbcdn' LIMIT 1);
UPDATE takedown_requests SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'facebook' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'fbcdn' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'facebook');
UPDATE alerts SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'facebook' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'fbcdn' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'facebook');
UPDATE org_brands SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'facebook' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'fbcdn' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'facebook');
DELETE FROM brands WHERE LOWER(name) = 'fbcdn';

-- ─── rbxcdn → roblox ───────────────────────────────────────────
UPDATE threats SET target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'roblox' LIMIT 1)
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'rbxcdn' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'roblox');
DELETE FROM threat_cube_brand
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'rbxcdn' LIMIT 1);
UPDATE takedown_requests SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'roblox' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'rbxcdn' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'roblox');
UPDATE alerts SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'roblox' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'rbxcdn' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'roblox');
UPDATE org_brands SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'roblox' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'rbxcdn' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'roblox');
DELETE FROM brands WHERE LOWER(name) = 'rbxcdn';

-- ─── paypalobjects → paypal ────────────────────────────────────
UPDATE threats SET target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'paypal' LIMIT 1)
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'paypalobjects' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'paypal');
DELETE FROM threat_cube_brand
  WHERE target_brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'paypalobjects' LIMIT 1);
UPDATE takedown_requests SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'paypal' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'paypalobjects' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'paypal');
UPDATE alerts SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'paypal' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'paypalobjects' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'paypal');
UPDATE org_brands SET brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'paypal' LIMIT 1)
  WHERE brand_id = (SELECT id FROM brands WHERE LOWER(name) = 'paypalobjects' LIMIT 1)
    AND EXISTS (SELECT 1 FROM brands WHERE LOWER(name) = 'paypal');
DELETE FROM brands WHERE LOWER(name) = 'paypalobjects';
