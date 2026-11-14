/**
 * Email-security grade-change detection (orchestrator hourly tick).
 *
 * Compares each recently scanned brand's current grade
 * (brands.email_security_grade) with its previous scan row. A pair is only
 * a real change when BOTH were graded under the current scoring rubric
 * (EMAIL_SCORE_RUBRIC_VERSION, email-security.ts): the brands row always
 * holds the newest scan's grade, so requiring the PREVIOUS scan row to carry
 * the current version means the first rescan after a rubric change updates
 * the stored grade silently instead of telling the customer their
 * protection changed when their DNS did not. Pre-versioned rows store NULL
 * and never match.
 *
 * Bounded to brands scanned in the last 23h (seeks
 * idx_brands_email_scan_due + idx_ess_brand_scanned) — see the caller for
 * the window/dedupe rationale.
 */

import { EMAIL_SCORE_RUBRIC_VERSION } from '../email-security';

export interface EmailGradeChange {
  brand_id: string;
  name: string;
  current_grade: string;
  previous_grade: string;
}

export const EMAIL_GRADE_CHANGES_SQL = `
  SELECT b.id AS brand_id, b.name, b.email_security_grade AS current_grade,
         ess.email_security_grade AS previous_grade
  FROM brands b
  JOIN email_security_scans ess ON ess.brand_id = b.id
  WHERE b.email_security_scanned_at >= datetime('now', '-23 hours')
    AND b.email_security_grade IS NOT NULL
    AND ess.email_security_grade IS NOT NULL
    AND b.email_security_grade != ess.email_security_grade
    AND ess.scanned_at < b.email_security_scanned_at
    AND ess.scanned_at = (
      SELECT MAX(e2.scanned_at) FROM email_security_scans e2
      WHERE e2.brand_id = b.id AND e2.scanned_at < b.email_security_scanned_at
    )
    AND ess.score_rubric_version = ?
`;

export async function findEmailGradeChanges(
  db: D1Database,
  rubricVersion: number = EMAIL_SCORE_RUBRIC_VERSION,
): Promise<EmailGradeChange[]> {
  const res = await db.prepare(EMAIL_GRADE_CHANGES_SQL).bind(rubricVersion).all<EmailGradeChange>();
  return res.results;
}

/**
 * Cartographer's band-crossing notification: true when the previous grade
 * was computed under a different (or unknown/NULL) rubric — the change is
 * then a rubric artefact and must not notify.
 */
export function isRubricOnlyGradeChange(previousRubricVersion: number | null | undefined): boolean {
  return previousRubricVersion !== EMAIL_SCORE_RUBRIC_VERSION;
}
