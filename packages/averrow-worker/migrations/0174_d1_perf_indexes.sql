-- Phase 3 D1 spend reduction — PR-C: targeted indexes for the
-- highest-cost residual queries after the cube migration (PR-B).
-- The 2026-05-12 1-hour diagnostic showed three queries scanning
-- the threats / brands tables instead of seeking indexes that
-- could trivially exist.
--
-- ── idx_threats_unresolved_domain ─────────────────────────
-- Query #1 (3.69M reads/h, 48 execs/h, 7.82k writes/h):
--   UPDATE threats SET attempted_resolve_at = datetime('now')
--    WHERE malicious_domain IN (?,?,...50×) AND ip_address IS NULL
-- The bulk DNS-resolver attempted_resolve_at stamp fires every
-- ~75 seconds on a 50-domain batch. `idx_threats_domain` covers
-- malicious_domain but the planner falls back to a scan because
-- `ip_address IS NULL` isn't selective enough. A partial index
-- on malicious_domain with the IS NULL predicate baked in is the
-- canonical fix — each batch becomes 50 indexed seeks.
--
-- ── idx_threats_stuck_geo ─────────────────────────────────
-- Cartographer Phase 0.5 (lib/geoip-mmdb caller) selects up to
-- 500 stuck-geo threats per tick from a 265k-row table. Without
-- this index the planner has been falling back to the
-- created_at scan + per-row null check. Partial index trims the
-- index to only the rows that qualify, which is a tiny fraction
-- of the table.
--
-- Note: `enrichment_attempts < 8` is NOT in the partial WHERE —
-- partial index predicates must be deterministic and we want
-- the index to remain useful if that bound changes in code.
--
-- ── idx_brands_email_scan_due ─────────────────────────────
-- Query #10 (412k reads/h, 3 execs/h):
--   SELECT b.id, COALESCE(b.canonical_domain, LOWER(b.name)) AS domain, ...
--     FROM brands b
--    WHERE ... AND (b.email_security_scanned_at IS NULL
--                   OR b.email_security_scanned_at < datetime('now', '-7 days'))
--    ORDER BY b.email_security_scanned_at ASC NULLS FIRST
--    LIMIT ?
-- Picks the next batch of brands to scan. With ~9.6k brands and
-- no index on email_security_scanned_at the ORDER BY required
-- a full sort. ASC default has NULLS FIRST in SQLite which
-- matches the ORDER BY exactly.

CREATE INDEX IF NOT EXISTS idx_threats_unresolved_domain
  ON threats(malicious_domain)
  WHERE ip_address IS NULL;

CREATE INDEX IF NOT EXISTS idx_threats_stuck_geo
  ON threats(created_at DESC)
  WHERE lat IS NULL
    AND ip_address IS NOT NULL
    AND ip_address != '';

CREATE INDEX IF NOT EXISTS idx_brands_email_scan_due
  ON brands(email_security_scanned_at);
