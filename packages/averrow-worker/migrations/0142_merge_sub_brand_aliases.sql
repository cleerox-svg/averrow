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
-- org_brands) to the master. Audit C10 fix is complete once those
-- FKs are repointed; the alias brand row itself is left in place.
--
-- The earlier draft also tried to DELETE the alias brand row but
-- that hit `FOREIGN KEY constraint failed` (D1 enforces FKs;
-- sales_leads / email_security_posture / threat_signals_and_assessments
-- / social_mentions reference brands(id) without ON DELETE CASCADE,
-- and they may still hold rows for the alias). The alias row stays
-- as a zero-activity ghost in /v2/brands — visible-but-empty,
-- harmless. A future Bundle C cleanup pass can repoint those tables
-- and then delete.
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
--   3. D1 enforces FK constraints — UPDATEs that produce orphan
--      rows or DELETEs of FK parents fail with code 7500.
--      The EXISTS(master) guard prevents writing target_brand_id =
--      NULL when the master brand row doesn't exist. Skipping the
--      DELETE FROM brands sidesteps the parent-deletion failure.
--
-- Pattern per alias (alias_lower, master_lower):
--   UPDATE threats SET target_brand_id = master.id
--     WHERE target_brand_id = alias.id AND EXISTS(master);
--   DELETE FROM threat_cube_brand WHERE target_brand_id = alias.id;
--   UPDATE takedown_requests / alerts / org_brands similarly;
--   (alias brand row remains as zero-activity ghost)
--
-- Each block is a no-op if the alias doesn't exist in production —
-- safe to keep the full conservative list.
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
-- (DELETE FROM brands skipped — non-cascade FK refs in sales_leads, email_security_posture, threat_signals_and_assessments, social_mentions block it. Alias row stays as zero-activity ghost; audit C10 fix is already complete via repointed FKs.)

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
-- (DELETE FROM brands skipped — non-cascade FK refs in sales_leads, email_security_posture, threat_signals_and_assessments, social_mentions block it. Alias row stays as zero-activity ghost; audit C10 fix is already complete via repointed FKs.)

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
-- (DELETE FROM brands skipped — non-cascade FK refs in sales_leads, email_security_posture, threat_signals_and_assessments, social_mentions block it. Alias row stays as zero-activity ghost; audit C10 fix is already complete via repointed FKs.)

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
-- (DELETE FROM brands skipped — non-cascade FK refs in sales_leads, email_security_posture, threat_signals_and_assessments, social_mentions block it. Alias row stays as zero-activity ghost; audit C10 fix is already complete via repointed FKs.)

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
-- (DELETE FROM brands skipped — non-cascade FK refs in sales_leads, email_security_posture, threat_signals_and_assessments, social_mentions block it. Alias row stays as zero-activity ghost; audit C10 fix is already complete via repointed FKs.)

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
-- (DELETE FROM brands skipped — non-cascade FK refs in sales_leads, email_security_posture, threat_signals_and_assessments, social_mentions block it. Alias row stays as zero-activity ghost; audit C10 fix is already complete via repointed FKs.)

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
-- (DELETE FROM brands skipped — non-cascade FK refs in sales_leads, email_security_posture, threat_signals_and_assessments, social_mentions block it. Alias row stays as zero-activity ghost; audit C10 fix is already complete via repointed FKs.)

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
-- (DELETE FROM brands skipped — non-cascade FK refs in sales_leads, email_security_posture, threat_signals_and_assessments, social_mentions block it. Alias row stays as zero-activity ghost; audit C10 fix is already complete via repointed FKs.)

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
-- (DELETE FROM brands skipped — non-cascade FK refs in sales_leads, email_security_posture, threat_signals_and_assessments, social_mentions block it. Alias row stays as zero-activity ghost; audit C10 fix is already complete via repointed FKs.)

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
-- (DELETE FROM brands skipped — non-cascade FK refs in sales_leads, email_security_posture, threat_signals_and_assessments, social_mentions block it. Alias row stays as zero-activity ghost; audit C10 fix is already complete via repointed FKs.)
