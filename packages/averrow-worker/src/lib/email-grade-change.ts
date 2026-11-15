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
 * Dangling-include rule (rubric 4). An `include_target_unverified` finding
 * (RDAP could not confirm whether an NXDOMAIN include target is
 * registered) on the CURRENT scan is NOT treated as a walk-unknown scan:
 * only the dangling-include verdict is held — the current scan is re-scored
 * with the previous scan's `include_target_unregistered` / `_unverified` /
 * `_newly_registered` finding in place of its own, with the root facts
 * required unchanged. Suppressed only if that equals the previous grade, so
 * a real downgrade elsewhere in the same tree (lookup limit newly exceeded,
 * an include now `+all`) still alerts. The hold is one-way: previous
 * `unverified` → current `unregistered` is the first CONFIRMATION and
 * alerts, unless the most recent earlier scan with a certain verdict for
 * that name was also unregistered (it was alerted then and only went
 * unverified in between) — the caller reads that history
 * (danglingEscalationAlreadyAlerted, ≤ 10 rows, only for that transition).
 * Newly-registered rule (rubric 4). `include_target_newly_registered`
 * keeps SPF at 0 for ≤ 30 days after an unregistered include target is
 * registered (takeover guard, email-security.ts). A grade change explained
 * only by that finding appearing or lapsing (root record unchanged) is
 * suppressed: the current scan is re-scored with the previous scan's whole
 * dangling verdict family (unregistered / unverified / newly registered). So a takeover never sends an "improved"
 * notification, neither when it happens nor when the 30 days run out.
 * Removing the include from the domain's own record changes the root facts
 * and does alert; an include removed further down the tree (a vendor's
 * record) does not — accepted.
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
  parseStoredSpfFindings,
  scanInputFromStoredRow,
  spfFromStoredRow,
  storedSpfWalkStatus,
  storedRowFromResult,
  type EmailSecurityResult,
  type SpfFindingCode,
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

/** Earlier checked scans (newest first), for the dangling escalation rule. */
const PRIOR_DANGLING_SCANS_SQL = `
  SELECT spf_walk_status, spf_findings FROM email_security_scans
  WHERE brand_id = ? AND spf_exists IS NOT NULL AND score_rubric_version = ? AND scanned_at < ?
  ORDER BY scanned_at DESC LIMIT 10`;

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
    if (baseline && current) {
      const escalationAlreadyAlerted = await danglingEscalationAlreadyAlerted(
        db, c.brand_id, baseline, current, c.previous_scanned_at, rubricVersion);
      if (isSpfUncertaintyOnlyGradeChange(baseline, current, { escalationAlreadyAlerted })) continue;
    }
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
  // A carried pre-0332 row has real SPF values but no walk data.
  // (An unverified dangling include is NOT walk uncertainty: it is held on
  // its own — holdDanglingVerdict.)
  return spf.walkStatus === 'unknown' || spf.walkStatus === 'carried_legacy' ? 'walk_unknown' : 'certain';
}

const DANGLING_CODES = new Set<SpfFindingCode>([
  'include_target_unregistered', 'include_target_unverified', 'include_target_newly_registered',
]);

function hasUnverifiedInclude(spf: SpfResult): boolean {
  return (spf.findings ?? []).some((f) => f.code === 'include_target_unverified');
}

function namesOf(spf: SpfResult, code: SpfFindingCode): Set<string> {
  const out = new Set<string>();
  for (const f of spf.findings ?? []) if (f.code === code) for (const n of f.names ?? []) out.add(n);
  return out;
}

/** The name that went from `include_target_unverified` (previous) to
 *  `include_target_unregistered` (current), or null. */
export function danglingEscalationName(previous: SpfResult, current: SpfResult): string | null {
  const unverified = namesOf(previous, 'include_target_unverified');
  const prevUnregistered = namesOf(previous, 'include_target_unregistered');
  for (const n of namesOf(current, 'include_target_unregistered')) {
    if (unverified.has(n) && !prevUnregistered.has(n)) return n;
  }
  return null;
}

/** Dangling verdict a stored scan is CERTAIN of for `name`: 'unregistered'
 *  (unregistered or newly registered — SPF was 0 and that was alerted),
 *  'other' (a complete walk with no unverified verdict for it), or null
 *  (unverified, or the walk was incomplete). */
export function certainDanglingVerdict(spf: SpfResult, name: string): 'unregistered' | 'other' | null {
  if (namesOf(spf, 'include_target_unverified').has(name)) return null;
  if (namesOf(spf, 'include_target_unregistered').has(name)
    || namesOf(spf, 'include_target_newly_registered').has(name)) return 'unregistered';
  return spf.walkStatus === 'complete' ? 'other' : null;
}

/**
 * For a previous `unverified` → current `unregistered` pair: true when the
 * most recent scan before `beforeScannedAt` with a certain verdict for that
 * name was also unregistered (already alerted). One read of ≤ 10 rows, made
 * only for that transition; false otherwise (or on a read error → alert).
 */
export async function danglingEscalationAlreadyAlerted(
  db: D1Database,
  brandId: string | number,
  baseline: StoredEmailScanRow,
  current: StoredEmailScanRow,
  beforeScannedAt: string,
  rubricVersion: number = EMAIL_SCORE_RUBRIC_VERSION,
): Promise<boolean> {
  const name = danglingEscalationName(spfFromStoredRow(baseline), spfFromStoredRow(current));
  if (!name) return false;
  try {
    const rows = await db.prepare(PRIOR_DANGLING_SCANS_SQL).bind(brandId, rubricVersion, beforeScannedAt)
      .all<Pick<StoredEmailScanRow, 'spf_walk_status' | 'spf_findings'>>();
    for (const r of rows.results ?? []) {
      const verdict = certainDanglingVerdict({
        exists: true, policy: null, includes: 0, tooManyLookups: false, raw: null,
        walkStatus: storedSpfWalkStatus(r.spf_walk_status), findings: parseStoredSpfFindings(r.spf_findings),
      }, name);
      if (verdict !== null) return verdict === 'unregistered';
    }
  } catch {
    // unknown history → alert
  }
  return false;
}

function hasNewlyRegistered(spf: SpfResult): boolean {
  return (spf.findings ?? []).some((f) => f.code === 'include_target_newly_registered');
}

/** `current` with its whole dangling-include verdict family (unregistered /
 *  unverified / newly registered) replaced by `previous`'s; every other part
 *  of `current` is kept. */
function holdDanglingVerdict(current: SpfResult, previous: SpfResult): SpfResult {
  return {
    ...current,
    findings: [
      ...(current.findings ?? []).filter((f) => !DANGLING_CODES.has(f.code)),
      ...(previous.findings ?? []).filter((f) => DANGLING_CODES.has(f.code)),
    ],
  };
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
  opts: { escalationAlreadyAlerted?: boolean } = {},
): boolean {
  const previous = scanInputFromStoredRow(previousRow);
  const current = scanInputFromStoredRow(currentRow);
  const previousGrade = calculateEmailSecurityScore(previous).grade;
  // Previous unverified → current unregistered: the first confirmation
  // alerts, unless an earlier certain verdict was already unregistered.
  if (danglingEscalationName(previous.spf, current.spf) !== null) {
    if (!opts.escalationAlreadyAlerted) return false;
    if (!sameSpfRootFacts(previous.spf, current.spf)) return false;
    const previousAsConfirmed = holdDanglingVerdict(previous.spf, current.spf);
    return calculateEmailSecurityScore({ ...previous, spf: previousAsConfirmed }).grade
      === calculateEmailSecurityScore(current).grade;
  }
  // An unverified dangling include on the CURRENT scan (RDAP could not
  // confirm, rubric 4) holds ONLY the dangling-include verdict to the
  // previous scan's: the current scan is re-scored with the previous
  // verdict, so a real change elsewhere in the same tree (e.g. the lookup
  // limit newly exceeded) still alerts.
  let held = false;
  let currentSpf = current.spf;
  if (hasUnverifiedInclude(current.spf)) {
    currentSpf = holdDanglingVerdict(currentSpf, previous.spf);
    held = true;
  }
  // A newly-registered include target appearing or lapsing (takeover guard)
  // with the domain's own record unchanged: the WHOLE dangling family is
  // swapped from the previous scan (as above), so an appearing finding
  // (previous unregistered) keeps SPF at 0 and a lapsing one re-adds it —
  // either way any other change in the same scan still shows.
  if (hasNewlyRegistered(previous.spf) !== hasNewlyRegistered(currentSpf)
      && sameSpfRootFacts(previous.spf, currentSpf)) {
    currentSpf = holdDanglingVerdict(currentSpf, previous.spf);
    held = true;
  }
  const pc = spfCertainty(previous.spf);
  const cc = spfCertainty(currentSpf);
  if (pc === 'certain' && cc === 'certain') {
    if (!held) return false;
    if (!sameSpfRootFacts(previous.spf, currentSpf)) return false;
    return calculateEmailSecurityScore({ ...current, spf: currentSpf }).grade === previousGrade;
  }

  let heldSpf: SpfResult;
  if (pc === 'not_checked' || cc === 'not_checked') {
    heldSpf = previous.spf;
  } else {
    if (!sameSpfRootFacts(previous.spf, currentSpf)) return false;
    heldSpf = holdWalkPart(currentSpf, previous.spf);
  }
  const rescored = calculateEmailSecurityScore({ ...current, spf: heldSpf }).grade;
  return rescored === previousGrade;
}

/**
 * Cartographer form: a fresh scan result against the previous stored row
 * (converted with storedRowFromResult, i.e. exactly what was just saved).
 * No previous row → not an uncertainty-only change.
 */
export function isSpfUncertaintyOnlyChange(
  previousRow: StoredEmailScanRow | undefined,
  current: EmailSecurityResult,
  opts: { escalationAlreadyAlerted?: boolean } = {},
): boolean {
  return !!previousRow && isSpfUncertaintyOnlyGradeChange(previousRow, storedRowFromResult(current), opts);
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
  let escalationAlreadyAlerted = false;
  if (previousScan && baseline && previousGrade && previousGrade !== currentGrade) {
    escalationAlreadyAlerted = await danglingEscalationAlreadyAlerted(
      db, brandId, baseline, storedRowFromResult(result), previousScan.scanned_at);
  }
  const isChange = !!previousGrade && previousGrade !== currentGrade
    && !isSpfUncertaintyOnlyChange(baseline, result, { escalationAlreadyAlerted });
  return { isChange, previousGrade, currentGrade };
}
