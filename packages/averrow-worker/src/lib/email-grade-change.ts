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
 * A not-checked row is never the baseline. When the previous scan's SPF
 * was not checked (spf_exists NULL), the baseline is that scan with its SPF
 * columns replaced by the brand's last CHECKED scan's (same rubric), and
 * both grades are re-computed (loadGradeBaseline) — so "-all (A) → root
 * failure (lower) → +all" alerts on the third scan, and a non-SPF change
 * already reported against the not-checked scan does not alert twice.
 *
 * The rule needs the score function, so it runs in JS: the SQL below finds
 * candidates (bounded to brands scanned in the last 23h — seeks
 * idx_brands_email_scan_due + idx_ess_brand_scanned; see the caller for the
 * window/dedupe rationale) and findEmailGradeChanges filters them, reading
 * two rows per candidate (+1 when the previous scan was not checked). The
 * "current" scan is the one that set brands.email_security_scanned_at.
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
         b.email_security_scanned_at AS current_scanned_at,
         ess.email_security_grade AS previous_grade, ess.id AS previous_scan_id,
         ess.scanned_at AS previous_scanned_at
  FROM brands b
  JOIN email_security_scans ess ON ess.brand_id = b.id
  WHERE b.email_security_scanned_at >= datetime('now', '-23 hours')
    AND b.email_security_grade IS NOT NULL
    AND ess.email_security_grade IS NOT NULL
    -- A not-checked previous scan is a candidate even at the same grade:
    -- its grade is not the baseline (see header).
    AND (b.email_security_grade != ess.email_security_grade OR ess.spf_exists IS NULL)
    AND ess.scanned_at < b.email_security_scanned_at
    AND ess.scanned_at = (
      SELECT MAX(e2.scanned_at) FROM email_security_scans e2
      WHERE e2.brand_id = b.id AND e2.scanned_at < b.email_security_scanned_at
    )
    AND ess.score_rubric_version = ?
`;

const SCAN_BY_ID_SQL = `SELECT ${STORED_EMAIL_SCAN_COLUMNS} FROM email_security_scans WHERE id = ?`;
/** The scan that set brands.email_security_scanned_at (saved just before
 *  the brands UPDATE, so its scanned_at is <= the brand's). */
const CURRENT_SCAN_SQL = `
  SELECT ${STORED_EMAIL_SCAN_COLUMNS} FROM email_security_scans
  WHERE brand_id = ? AND scanned_at <= ? ORDER BY scanned_at DESC LIMIT 1`;
/** The brand's last scan whose SPF was checked, before `scanned_at`. */
const LAST_CHECKED_SCAN_SQL = `
  SELECT ${STORED_EMAIL_SCAN_COLUMNS} FROM email_security_scans
  WHERE brand_id = ? AND spf_exists IS NOT NULL AND score_rubric_version = ? AND scanned_at < ?
  ORDER BY scanned_at DESC LIMIT 1`;

/** Grade of a stored row under the current scorer. */
export function gradeOfStoredRow(row: StoredEmailScanRow): string {
  return calculateEmailSecurityScore(scanInputFromStoredRow(row)).grade;
}

/** `row` with its SPF columns taken from `spfFrom`. */
export function withSpfColumnsOf(row: StoredEmailScanRow, spfFrom: StoredEmailScanRow): StoredEmailScanRow {
  return {
    ...row,
    spf_exists: spfFrom.spf_exists,
    spf_policy: spfFrom.spf_policy,
    spf_too_many_lookups: spfFrom.spf_too_many_lookups,
    spf_raw: spfFrom.spf_raw ?? null,
    spf_lookup_count: spfFrom.spf_lookup_count ?? null,
    spf_void_lookups: spfFrom.spf_void_lookups ?? null,
    spf_walk_status: spfFrom.spf_walk_status ?? null,
    spf_findings: spfFrom.spf_findings ?? null,
  };
}

/**
 * Baseline for a grade comparison whose previous scan did NOT check SPF:
 * that scan with the SPF columns of the brand's last checked scan before
 * it (current rubric). Null when the previous scan was checked or no
 * checked scan exists (the previous row then stays the baseline).
 */
export async function loadGradeBaseline(
  db: D1Database,
  brandId: string | number,
  previousRow: StoredEmailScanRow,
  previousScannedAt: string,
  rubricVersion: number = EMAIL_SCORE_RUBRIC_VERSION,
): Promise<StoredEmailScanRow | null> {
  if (previousRow.spf_exists !== null) return null;
  const checked = await db.prepare(LAST_CHECKED_SCAN_SQL)
    .bind(brandId, rubricVersion, previousScannedAt).first<StoredEmailScanRow>();
  return checked ? withSpfColumnsOf(previousRow, checked) : null;
}

export async function findEmailGradeChanges(
  db: D1Database,
  rubricVersion: number = EMAIL_SCORE_RUBRIC_VERSION,
): Promise<EmailGradeChange[]> {
  const res = await db.prepare(EMAIL_GRADE_CHANGES_SQL).bind(rubricVersion).all<EmailGradeChange & {
    previous_scan_id: number; previous_scanned_at: string; current_scanned_at: string;
  }>();
  const out: EmailGradeChange[] = [];
  for (const c of res.results) {
    const [previous, current] = await Promise.all([
      db.prepare(SCAN_BY_ID_SQL).bind(c.previous_scan_id).first<StoredEmailScanRow>(),
      db.prepare(CURRENT_SCAN_SQL).bind(c.brand_id, c.current_scanned_at).first<StoredEmailScanRow>(),
    ]);
    let previousGrade = c.previous_grade;
    let currentGrade = c.current_grade;
    let baseline = previous;
    if (previous && current) {
      const substituted = await loadGradeBaseline(db, c.brand_id, previous, c.previous_scanned_at, rubricVersion);
      if (substituted) {
        baseline = substituted;
        previousGrade = gradeOfStoredRow(substituted);
        currentGrade = gradeOfStoredRow(current);
      }
    }
    if (previousGrade === currentGrade) continue;
    if (baseline && current && isSpfUncertaintyOnlyGradeChange(baseline, current)) continue;
    out.push({ brand_id: c.brand_id, name: c.name, current_grade: currentGrade, previous_grade: previousGrade });
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
  // An RDAP lookup that could not confirm a dangling include (rubric 4):
  // the include_target_unregistered finding may be missing only for that reason.
  if ((spf.findings ?? []).some((f) => f.code === 'include_target_unverified')) return 'walk_unknown';
  // A carried pre-0332 row has real SPF values but no walk data.
  return spf.walkStatus === 'unknown' || spf.walkStatus === 'carried_legacy' ? 'walk_unknown' : 'certain';
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

/**
 * Cartographer's grade-change decision for a fresh scan `result` against
 * the brand's previous stored scan (read before this scan was saved) and
 * the grade the brand row held. A not-checked previous scan is replaced by
 * loadGradeBaseline (grades then re-computed for both sides); a change SPF
 * uncertainty fully explains is not a change. The rubric check stays with
 * the caller.
 */
export async function resolveScanGradeChange(
  db: D1Database,
  brandId: string | number,
  previousScan: (StoredEmailScanRow & { scanned_at: string }) | undefined,
  existingGrade: string | null,
  result: EmailSecurityResult,
): Promise<{ isChange: boolean; previousGrade: string | null; currentGrade: string }> {
  let baseline: StoredEmailScanRow | undefined = previousScan;
  let previousGrade = existingGrade;
  let currentGrade = result.grade;
  if (previousScan) {
    const substituted = await loadGradeBaseline(db, brandId, previousScan, previousScan.scanned_at);
    if (substituted) {
      baseline = substituted;
      previousGrade = gradeOfStoredRow(substituted);
      currentGrade = gradeOfStoredRow(storedRowFromResult(result));
    }
  }
  const isChange = !!previousGrade && previousGrade !== currentGrade
    && !isSpfUncertaintyOnlyChange(baseline, result);
  return { isChange, previousGrade, currentGrade };
}
