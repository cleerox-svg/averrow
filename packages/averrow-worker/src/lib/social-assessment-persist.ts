/**
 * Write a social_ai_assessor result onto a `social_profiles` row (G26).
 *
 * Shared by the two callers — the social_monitor scanner
 * (`scanners/social-monitor.ts`) and the staff re-assess endpoint
 * (`handlers/brands.ts` handleReassessSocialProfile) — so the rule below
 * cannot drift between them.
 *
 * The rule: only a real AI assessment (`aiSucceeded === true`) is written.
 * When the assessor fell back — a deliberate skip under
 * `AI_MODE=rules_only` / budget throttle, a failed call, or an invalid
 * reply — NOTHING is written. The row keeps the deterministic result the
 * impersonation scorer produced (classification, confidence, severity,
 * `impersonation_signals`, `impersonation_score`), and no
 * `classification_reason` / `ai_*` text is stored. Before this, the
 * fallback overwrote all of those with fixed "AI assessment was
 * unavailable" text that the tenant rendered and Sparrow/takedown
 * evidence reused, and reclassified handles it didn't recognise as
 * `legitimate`.
 *
 * Manual classifications (`classified_by = 'manual'`) are kept on the AI
 * path too, as before.
 */

import type { SocialAiAssessorOutput } from "../agents/social-ai-assessor";

/** Which row to update: by (brand, platform, handle) from the scanner, or by id. */
export type SocialProfileTarget =
  | { kind: "handle"; brandId: string; platform: string; handle: string }
  | { kind: "id"; brandId: string; profileId: string };

/** Minimal prepared-statement surface (D1Database). */
interface WriteDb {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<unknown> };
  };
}

/** True when the assessment may replace the rule-based result on the row. */
export function shouldApplySocialAssessment(assessment: SocialAiAssessorOutput): boolean {
  return assessment.aiSucceeded === true && assessment.fallbackReason === null;
}

const SET_CLAUSE = `
  ai_assessment = ?,
  ai_confidence = ?,
  ai_action = ?,
  ai_evidence_draft = ?,
  classification = CASE
    WHEN classified_by = 'manual' THEN classification
    ELSE ?
  END,
  classification_confidence = CASE
    WHEN classified_by = 'manual' THEN classification_confidence
    ELSE ?
  END,
  classification_reason = ?,
  impersonation_signals = ?,
  severity = CASE
    WHEN ? >= 0.9 THEN 'CRITICAL'
    WHEN ? >= 0.7 THEN 'HIGH'
    WHEN ? >= 0.4 THEN 'MEDIUM'
    ELSE 'LOW'
  END,
  ai_assessed_at = ?,
  updated_at = ?`;

export const SOCIAL_ASSESSMENT_UPDATE_BY_HANDLE_SQL =
  `UPDATE social_profiles SET${SET_CLAUSE}
   WHERE brand_id = ? AND platform = ? AND handle = ?`;

export const SOCIAL_ASSESSMENT_UPDATE_BY_ID_SQL =
  `UPDATE social_profiles SET${SET_CLAUSE}
   WHERE id = ? AND brand_id = ?`;

/**
 * Persist an AI assessment. Returns `true` when the row was updated,
 * `false` when the assessment was a fallback and the rule-based row was
 * deliberately left untouched.
 */
export async function persistSocialAssessment(
  db: WriteDb,
  assessment: SocialAiAssessorOutput,
  target: SocialProfileTarget,
  nowIso: string,
): Promise<boolean> {
  if (!shouldApplySocialAssessment(assessment)) return false;

  const values: unknown[] = [
    assessment.reasoning,
    assessment.confidence,
    assessment.action,
    assessment.evidenceDraft,
    assessment.classification,
    assessment.confidence,
    assessment.reasoning,
    JSON.stringify([...assessment.signals, ...assessment.crossCorrelations]),
    assessment.confidence, assessment.confidence, assessment.confidence,
    nowIso,
    nowIso,
  ];

  if (target.kind === "handle") {
    await db.prepare(SOCIAL_ASSESSMENT_UPDATE_BY_HANDLE_SQL)
      .bind(...values, target.brandId, target.platform, target.handle)
      .run();
  } else {
    await db.prepare(SOCIAL_ASSESSMENT_UPDATE_BY_ID_SQL)
      .bind(...values, target.profileId, target.brandId)
      .run();
  }
  return true;
}
