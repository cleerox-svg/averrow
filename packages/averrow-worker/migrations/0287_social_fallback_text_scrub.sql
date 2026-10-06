-- G26 (docs/DISCLOSURE_REGISTER.md, L27): repair social_profiles rows the
-- social_ai_assessor's old algorithmic fallback overwrote.
--
-- Under AI_MODE=rules_only every assessment fell back, and the fallback
-- wrote fixed text over the rule-based result: classification_reason /
-- ai_assessment "…AI assessment was unavailable…" (rendered to tenants,
-- reused as takedown evidence), impersonation_signals "AI assessment
-- unavailable", an ai_confidence / ai_action / ai_assessed_at that claim an
-- AI assessment happened, and — for handles that don't contain the brand
-- name — classification 'legitimate' with severity LOW. The code no longer
-- writes any of this (lib/social-assessment-persist.ts).
--
-- Matching is on the two EXACT fallback strings the old code wrote, so no
-- real AI reasoning is touched. Classification is restored only on rows
-- whose original writer is known from classified_by (the fallback never
-- changed that column); manual and auto_discovery rows keep their
-- classification:
--   classified_by = 'system' — the scanner's official-handle check row,
--     born classification 'official', confidence NULL, severity 'LOW'.
--   classified_by = 'ai'     — the scanner's impersonation-scan row, born
--     from impersonation_score (scanners/social-monitor.ts: >= 0.7
--     impersonation else suspicious; confidence = score; severity
--     thresholds 0.9 / 0.7 / 0.4 from impersonation-scorer.ts).
-- The scorer's original signal strings were overwritten and can't be
-- recovered here; they are reset to '[]' and the next scan rewrites them.
--
-- Idempotent: a second run matches no rows.

-- 1a. Official-handle check rows back to 'official'.
UPDATE social_profiles SET
  classification = 'official',
  classification_confidence = NULL,
  severity = 'LOW'
WHERE classified_by = 'system'
  AND classification_reason IN (
    'Handle resembles brand name but AI assessment was unavailable. Flagged for manual review.',
    'AI assessment was unavailable. Low-confidence algorithmic fallback applied.'
  );

-- 1b. Impersonation-scan rows back to the score-derived classification.
UPDATE social_profiles SET
  classification = CASE WHEN impersonation_score >= 0.7 THEN 'impersonation' ELSE 'suspicious' END,
  classification_confidence = impersonation_score,
  severity = CASE
    WHEN impersonation_score >= 0.9 THEN 'CRITICAL'
    WHEN impersonation_score >= 0.7 THEN 'HIGH'
    WHEN impersonation_score >= 0.4 THEN 'MEDIUM'
    ELSE 'LOW'
  END
WHERE classified_by = 'ai'
  AND classification_reason IN (
    'Handle resembles brand name but AI assessment was unavailable. Flagged for manual review.',
    'AI assessment was unavailable. Low-confidence algorithmic fallback applied.'
  );

-- 2. Drop the fallback signal strings.
UPDATE social_profiles SET impersonation_signals = '[]'
WHERE impersonation_signals IN (
  '["Handle contains brand name","Not verified","AI assessment unavailable"]',
  '["AI assessment unavailable — algorithmic fallback"]'
);

-- 3. Clear the fallback text and the AI fields that claim an assessment ran.
UPDATE social_profiles SET
  classification_reason = NULL,
  ai_assessment = NULL,
  ai_confidence = NULL,
  ai_action = NULL,
  ai_assessed_at = NULL
WHERE classification_reason IN (
    'Handle resembles brand name but AI assessment was unavailable. Flagged for manual review.',
    'AI assessment was unavailable. Low-confidence algorithmic fallback applied.'
  )
  OR ai_assessment IN (
    'Handle resembles brand name but AI assessment was unavailable. Flagged for manual review.',
    'AI assessment was unavailable. Low-confidence algorithmic fallback applied.'
  );
