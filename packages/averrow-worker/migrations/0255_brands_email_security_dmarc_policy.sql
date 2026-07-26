-- 0255_brands_email_security_dmarc_policy.sql
-- D1 read-spend Fix #4 — denormalize latest-scan DMARC policy onto brands.
--
-- The email-security stats handler (handlers/emailSecurity.ts) computed its
-- DMARC-policy distribution with a correlated
--   id IN (SELECT MAX(id) FROM email_security_scans GROUP BY brand_id)
-- scan over the ENTIRE, insert-only `email_security_scans` history
-- (saveEmailSecurityScan appends a row per scan, never updates). That was
-- the single heaviest read on the platform (~43.8M reads/24h) and grows
-- unbounded with scan volume.
--
-- `brands` already carries the other denormalized latest-scan fields
-- (email_security_score / email_security_grade / email_security_scanned_at,
-- migration 0020) written right after saveEmailSecurityScan at both scan
-- call sites (agents/cartographer.ts, cron/orchestrator.ts). This adds the
-- matching dmarc_policy column so the distribution reads a single
-- pre-computed column on `brands` (WHERE email_security_score IS NOT NULL)
-- instead of scanning scan history.
--
-- ADD COLUMN only — never alter/drop existing columns. Mirrors the
-- `email_security_grade TEXT` naming from migration 0020. No index: the
-- reader is a full GROUP BY over the ~scanned brands subset, not a
-- point/range lookup on this column, so an index would only add write
-- amplification on `brands` for zero read benefit.

ALTER TABLE brands ADD COLUMN email_security_dmarc_policy TEXT DEFAULT NULL;

-- One-time idempotent backfill from the current latest scan per brand.
-- Join is brands.id <-> email_security_scans.brand_id (FK from 0020).
-- Only touches brands that actually have a scan; brands with no scan
-- row are left NULL (identical to how a never-scanned brand would look
-- after a normal scan-driven write). Safe to re-run.
UPDATE brands SET email_security_dmarc_policy = (
  SELECT ess.dmarc_policy
  FROM email_security_scans ess
  WHERE ess.id = (
    SELECT MAX(id) FROM email_security_scans WHERE brand_id = brands.id
  )
) WHERE EXISTS (
  SELECT 1 FROM email_security_scans e2 WHERE e2.brand_id = brands.id
);
