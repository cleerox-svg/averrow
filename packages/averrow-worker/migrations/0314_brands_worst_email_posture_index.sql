-- 0314: partial index for the email-security "worst-protected brands" list.
--
-- handlers/emailSecurity.ts (worst_brands in /api/email-security/stats,
-- also reached via the admin dashboard warm) runs:
--
--   SELECT ... FROM brands b
--   WHERE b.email_security_score IS NOT NULL
--     AND b.email_security_grade IN ('F', 'D', 'C')
--   ORDER BY b.email_security_score ASC
--   LIMIT 200
--
-- With no index on email_security_score this scans all of `brands`
-- (~132K rows) and sorts in a temp b-tree on every cache miss. Keyed on
-- the ORDER BY column and restricted to exactly the query's WHERE terms
-- (SQLite uses a partial index only when the query's WHERE contains the
-- index's WHERE terms), the planner walks the index in score order and
-- stops after 200 entries + 200 table lookups.
--
-- Write cost: an index entry only for F/D/C-graded brands, updated when
-- the weekly email-security rescan changes a score or grade.
--
-- Additive only; idempotent.
CREATE INDEX IF NOT EXISTS idx_brands_worst_email_posture
  ON brands(email_security_score)
  WHERE email_security_score IS NOT NULL AND email_security_grade IN ('F', 'D', 'C');
