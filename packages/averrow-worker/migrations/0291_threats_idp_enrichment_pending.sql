-- 0291_threats_idp_enrichment_pending.sql — IdP-first enrichment slices
--
-- VirusTotal, SecLookup and Pulsedive now read a reserved slice of
-- identity-provider-impersonation threats (technique IN
-- IDP_FAMILY_TECHNIQUES) before their severity-ordered batch
-- (lib/idp-enrichment-priority.ts). Each slice gets a partial index:
--
--   predicate  <flag> = 0 AND technique IS NOT NULL
--   key        created_at DESC (the slice's 7-day window + ORDER BY)
--
-- threats.technique (migration 0205) is NULL on almost every row, so each
-- index holds only unchecked, technique-tagged rows — a tiny write/storage
-- cost. The slice query's `technique IN (?, …)` implies `technique IS NOT
-- NULL` (it also states it explicitly), so the partial predicate matches;
-- IN-list membership is a residual on the few index hits. The existing
-- idx_threats_technique_created (0288) would have to visit every IdP row of
-- the window, checked or not, on every run.
--
-- EXPLAIN QUERY PLAN (pinned in test/idp-enrichment-priority.test.ts):
--   SEARCH threats USING INDEX idx_threats_idp_vt_pending (created_at>?)
--   SEARCH threats USING INDEX idx_threats_idp_seclookup_pending (created_at>?)
--   SEARCH threats USING INDEX idx_threats_idp_pulsedive_pending (created_at>?)
--
-- Additive only.

CREATE INDEX IF NOT EXISTS idx_threats_idp_vt_pending
  ON threats(created_at DESC)
  WHERE vt_checked = 0
    AND technique IS NOT NULL
    AND malicious_domain IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_threats_idp_seclookup_pending
  ON threats(created_at DESC)
  WHERE seclookup_checked = 0
    AND technique IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_threats_idp_pulsedive_pending
  ON threats(created_at DESC)
  WHERE pulsedive_checked = 0
    AND technique IS NOT NULL;
