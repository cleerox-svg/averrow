/**
 * Rule-based social scan writes onto `social_profiles`, plus the shared
 * "a human classified this row" predicate.
 *
 * Who writes `social_profiles.classified_by`:
 *   - `'system'`         — the scanner's official-handle check row
 *   - `'ai'`             — the scanner's impersonation-scan row (the rules
 *                          path has always stamped `'ai'`; prod rows carry it)
 *   - `'auto_discovery'` — website social-link discovery
 *   - a user id          — the staff PATCH in `handlers/brands.ts`
 *                          (handleUpdateSocialProfile stores `userId`, never
 *                          the literal `'manual'`)
 *
 * So "human-classified" is any non-null value outside the machine set. A
 * guard keyed on `classified_by = 'manual'` never matched a real row and let
 * every scan overwrite a person's decision.
 *
 * Callers: `scanners/social-monitor.ts` (cron batch) and
 * `handlers/socialMonitor.ts` (on-demand scan) share
 * `upsertSocialScanImpersonation` so the rule cannot drift between them.
 */

/** `classified_by` values written by machines. Anything else non-null is a person. */
export const MACHINE_CLASSIFIERS = ["system", "ai", "auto_discovery"] as const;

/**
 * SQL predicate over the row's CURRENT `classified_by` (in an UPDATE, or in
 * an upsert's `DO UPDATE SET`, an unqualified column is the existing row).
 * Constant text, no bound values.
 */
export const HUMAN_CLASSIFIED_SQL =
  `(classified_by IS NOT NULL AND classified_by NOT IN ('system', 'ai', 'auto_discovery'))`;

/** TS mirror of HUMAN_CLASSIFIED_SQL. */
export function isHumanClassifiedBy(classifiedBy: string | null | undefined): boolean {
  return classifiedBy != null && !(MACHINE_CLASSIFIERS as readonly string[]).includes(classifiedBy);
}

/** Score → classification for an impersonation-scan hit (unchanged threshold). */
export function socialScanClassification(score: number): "impersonation" | "suspicious" {
  return score >= 0.7 ? "impersonation" : "suspicious";
}

/**
 * Deterministic, customer-readable reason built from the scorer's signals
 * (which describe only observed facts — see scanners/impersonation-scorer.ts).
 * `null` when there is nothing to say, so the column stays NULL.
 */
export function buildRulesClassificationReason(signals: readonly string[]): string | null {
  const parts = signals.map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const joined = parts
    .map((s, i) => (i === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1)))
    .join("; ");
  return joined.endsWith(".") ? joined : `${joined}.`;
}

export const SOCIAL_SCAN_IMPERSONATION_UPSERT_SQL = `
  INSERT INTO social_profiles
    (id, brand_id, platform, handle, profile_url, display_name,
     classification, classified_by, classification_confidence, classification_reason,
     impersonation_score, impersonation_signals, severity, status, last_checked)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, ?, ?, 'active', datetime('now'))
  ON CONFLICT (brand_id, platform, handle) DO UPDATE SET
    impersonation_score = excluded.impersonation_score,
    impersonation_signals = excluded.impersonation_signals,
    severity = excluded.severity,
    classification = CASE
      WHEN ${HUMAN_CLASSIFIED_SQL} THEN classification
      ELSE excluded.classification
    END,
    classification_confidence = CASE
      WHEN ${HUMAN_CLASSIFIED_SQL} THEN classification_confidence
      ELSE excluded.classification_confidence
    END,
    classification_reason = CASE
      WHEN ${HUMAN_CLASSIFIED_SQL} THEN classification_reason
      ELSE excluded.classification_reason
    END,
    last_checked = datetime('now'),
    updated_at = datetime('now')`;

export interface SocialScanImpersonationRow {
  brandId: string;
  platform: string;
  handle: string;
  profileUrl: string | null;
  displayName: string | null;
  score: number;
  signals: string[];
  severity: string;
}

/** Minimal prepared-statement surface (D1Database). */
interface WriteDb {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<unknown> };
  };
}

/**
 * Upsert one impersonation-scan hit. Score, signals and severity are
 * observations and always refresh; classification, confidence and reason
 * refresh only when no person has classified the row.
 */
export async function upsertSocialScanImpersonation(
  db: WriteDb,
  profileId: string,
  row: SocialScanImpersonationRow,
): Promise<void> {
  await db.prepare(SOCIAL_SCAN_IMPERSONATION_UPSERT_SQL).bind(
    profileId, row.brandId, row.platform, row.handle,
    row.profileUrl,
    row.displayName,
    socialScanClassification(row.score),
    row.score,
    buildRulesClassificationReason(row.signals),
    row.score,
    JSON.stringify(row.signals),
    row.severity,
  ).run();
}

/**
 * Discovery upsert (website social links → `official`). A person's
 * classification is kept; otherwise the row becomes official/auto_discovery.
 */
export const SOCIAL_DISCOVERY_UPSERT_SQL = `
  INSERT INTO social_profiles
    (id, brand_id, platform, handle, profile_url, classification,
     classified_by, classification_confidence, last_checked, status)
  VALUES (?, ?, ?, ?, ?, 'official', 'auto_discovery', ?, datetime('now'), 'active')
  ON CONFLICT (brand_id, platform, handle) DO UPDATE SET
    classification = CASE
      WHEN ${HUMAN_CLASSIFIED_SQL} THEN classification
      ELSE 'official'
    END,
    classified_by = CASE
      WHEN ${HUMAN_CLASSIFIED_SQL} THEN classified_by
      ELSE 'auto_discovery'
    END,
    classification_confidence = CASE
      WHEN ${HUMAN_CLASSIFIED_SQL} THEN classification_confidence
      ELSE excluded.classification_confidence
    END,
    profile_url = excluded.profile_url,
    last_checked = datetime('now'),
    updated_at = datetime('now')`;
