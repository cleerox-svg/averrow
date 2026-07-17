-- ─── Lowercase `alerts.severity` ─────────────────────────────────
-- The notifications system stores severity as lowercase
-- ('critical' | 'high' | 'medium' | 'low' | 'info') which matches the
-- design-system tokens (--sev-critical, etc.). The alerts table was
-- written before that convention landed and uses uppercase
-- ('CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW').
--
-- Both severity values mean the same thing — the inconsistency just
-- forces every UI surface to do `severity.toLowerCase()` or carry an
-- ad-hoc `severityBadgeMap`. This migration normalizes existing rows
-- to lowercase. Migration 0121 follows with a CHECK constraint
-- enforcing the lowercase enum going forward.
--
-- Idempotent: rows already lowercase are unaffected.

UPDATE alerts SET severity = LOWER(severity)
  WHERE severity = UPPER(severity)
    AND severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');
