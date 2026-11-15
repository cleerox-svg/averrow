/**
 * Email-security grade-change detection (orchestrator hourly tick) and the
 * shared "is this a real change?" rules Cartographer's notification uses.
 *
 * Rubric rule. A pair is only a real change when BOTH scans were graded
 * under the current scoring rubric (EMAIL_SCORE_RUBRIC_VERSION,
 * email-security.ts): the brands row always holds the newest scan's grade,
 * so requiring the PREVIOUS scan row to carry the current version means the
 * first rescan after a rubric change updates the stored grade silently
 * instead of telling the customer their protection changed when their DNS
 * did not. Pre-versioned rows store NULL and never match.
 *
 * SPF uncertainty rule (rubric 3, migration 0332). The SPF check can be
 * uncertain: the include-tree walk ended `unknown` (a DoH lookup timed out,
 * a cap was hit), or the root lookup failed and SPF was not checked. A grade
 * that moved only because of what could be READ is not a change in the
 * brand's DNS, so isSpfUncertaintyOnlyGradeChange suppresses a pair ONLY
 * when SPF uncertainty fully explains it:
 *   1. Neither scan uncertain → never suppressed.
 *   2. Both SPF checks ran (no "not checked") → the root-record facts must
 *      be unchanged (spf_exists, the domain's own record text — which holds
 *      its `all` qualifier — and multiple records); any root change is a
 *      real DNS change and is never suppressed. The current scan is then
 *      re-scored with its walk-derived SPF part (lookup count / limit, loop,
 *      void lookups, tree findings, and the redirect-derived `all` when the
 *      record has none of its own) held to the previous scan's.
 *   3. One side not checked (root lookup failed) → the current scan is
 *      re-scored with the previous scan's whole SPF part.
 *   Suppressed only if that re-scored grade equals the previous grade — so
 *   a DMARC/DKIM/MX change that coincides with an SPF timeout still alerts.
 * Brand scans carry the last CHECKED scan's SPF forward over a root lookup
 * failure (previousSpfLoader), so a "not checked" row only exists for a
 * brand with no earlier checked scan (or when that read failed).
 *
 * The rule needs the score function, so it runs in JS: the SQL below finds
 * candidates (bounded to brands scanned in the last 23h — seeks
 * idx_brands_email_scan_due + idx_ess_brand_scanned; see the caller for the
 * window/dedupe rationale) and findEmailGradeChanges filters them, reading
 * two rows per candidate (candidates are brands whose grade changed — few).
 */

import {
  EMAIL_SCORE_RUBRIC_VERSION,
  SPF_ROOT_FINDING_CODES,
  STORED_EMAIL_SCAN_COLUMNS,
  calculateEmailSecurityScore,
  scanInputFromStoredRow,
  storedRowFromResult,
  type EmailSecurityResult,
  type SpfResult,
  type StoredEmailScanRow,
} from '../email-security';
import { parseSpfRecord } from './spf-record';

export interface EmailGradeChange {
  brand_id: string;
  name: string;
  current_grade: string;
  previous_grade: string;
}

export const EMAIL_GRADE_CHANGES_SQL = `
  SELECT b.id AS brand_id, b.name, b.email_security_grade AS current_grade,
         ess.email_security_grade AS previous_grade, ess.id AS previous_scan_id
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

const SCAN_BY_ID_SQL = `SELECT ${STORED_EMAIL_SCAN_COLUMNS} FROM email_security_scans WHERE id = ?`;
const LATEST_SCAN_SQL = `
  SELECT ${STORED_EMAIL_SCAN_COLUMNS} FROM email_security_scans
  WHERE brand_id = ? ORDER BY scanned_at DESC LIMIT 1`;

export async function findEmailGradeChanges(
  db: D1Database,
  rubricVersion: number = EMAIL_SCORE_RUBRIC_VERSION,
): Promise<EmailGradeChange[]> {
  const res = await db.prepare(EMAIL_GRADE_CHANGES_SQL).bind(rubricVersion)
    .all<EmailGradeChange & { previous_scan_id: number }>();
  const out: EmailGradeChange[] = [];
  for (const c of res.results) {
    const [previous, current] = await Promise.all([
      db.prepare(SCAN_BY_ID_SQL).bind(c.previous_scan_id).first<StoredEmailScanRow>(),
      db.prepare(LATEST_SCAN_SQL).bind(c.brand_id).first<StoredEmailScanRow>(),
    ]);
    if (previous && current && isSpfUncertaintyOnlyGradeChange(previous, current)) continue;
    out.push({ brand_id: c.brand_id, name: c.name, current_grade: c.current_grade, previous_grade: c.previous_grade });
  }
  return out;
}

/**
 * Cartographer's band-crossing notification: true when the previous grade
 * was computed under a different (or unknown/NULL) rubric — the change is
 * then a rubric artefact and must not notify.
 */
export function isRubricOnlyGradeChange(previousRubricVersion: number | null | undefined): boolean {
  return previousRubricVersion !== EMAIL_SCORE_RUBRIC_VERSION;
}

type SpfCertainty = 'certain' | 'walk_unknown' | 'not_checked';

function spfCertainty(spf: SpfResult): SpfCertainty {
  if (spf.rootError) return 'not_checked';
  return spf.walkStatus === 'unknown' ? 'walk_unknown' : 'certain';
}

function normRecord(r: string): string {
  return r.trim().replace(/\s+/g, ' ').toLowerCase();
}

function hasMultipleRecords(spf: SpfResult): boolean {
  return (spf.findings ?? []).some((f) => f.code === 'multiple_records');
}

/** The domain's own SPF record is unchanged between two checked scans. */
export function sameSpfRootFacts(previous: SpfResult, current: SpfResult): boolean {
  if (previous.exists !== current.exists) return false;
  if (hasMultipleRecords(previous) !== hasMultipleRecords(current)) return false;
  if (previous.raw && current.raw) return normRecord(previous.raw) === normRecord(current.raw);
  return previous.policy === current.policy && !previous.raw === !current.raw;
}

/** `current` with its walk-derived part replaced by `previous`'s. */
function holdWalkPart(current: SpfResult, previous: SpfResult): SpfResult {
  const ownAll = current.raw ? parseSpfRecord(current.raw)?.allQualifier ?? null : null;
  return {
    ...current,
    tooManyLookups: previous.tooManyLookups,
    lookupCount: previous.lookupCount,
    voidLookups: previous.voidLookups,
    // The record's own `all` is a root fact; a redirect-derived one is not.
    policy: ownAll !== null ? current.policy : previous.policy,
    findings: [
      ...(current.findings ?? []).filter((f) => SPF_ROOT_FINDING_CODES.has(f.code)),
      ...(previous.findings ?? []).filter((f) => !SPF_ROOT_FINDING_CODES.has(f.code)),
    ],
  };
}

/**
 * True when the grade difference between two stored scans (both under the
 * current rubric) is fully explained by SPF-check uncertainty — see the
 * header for the rule. Both rows go through scanInputFromStoredRow and
 * calculateEmailSecurityScore, so they are compared on equal terms.
 */
export function isSpfUncertaintyOnlyGradeChange(
  previousRow: StoredEmailScanRow,
  currentRow: StoredEmailScanRow,
): boolean {
  const previous = scanInputFromStoredRow(previousRow);
  const current = scanInputFromStoredRow(currentRow);
  const pc = spfCertainty(previous.spf);
  const cc = spfCertainty(current.spf);
  if (pc === 'certain' && cc === 'certain') return false;

  let heldSpf: SpfResult;
  if (pc === 'not_checked' || cc === 'not_checked') {
    heldSpf = previous.spf;
  } else {
    if (!sameSpfRootFacts(previous.spf, current.spf)) return false;
    heldSpf = holdWalkPart(current.spf, previous.spf);
  }
  const rescored = calculateEmailSecurityScore({ ...current, spf: heldSpf }).grade;
  return rescored === calculateEmailSecurityScore(previous).grade;
}

/**
 * Cartographer form: a fresh scan result against the previous stored row
 * (converted with storedRowFromResult, i.e. exactly what was just saved).
 * No previous row → not an uncertainty-only change.
 */
export function isSpfUncertaintyOnlyChange(
  previousRow: StoredEmailScanRow | undefined,
  current: EmailSecurityResult,
): boolean {
  return !!previousRow && isSpfUncertaintyOnlyGradeChange(previousRow, storedRowFromResult(current));
}
