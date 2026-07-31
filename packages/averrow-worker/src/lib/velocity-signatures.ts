// Averrow — weaponization-velocity signature (rec 5, v1). PURE core.
//
// Spec: T5.1 weaponization-velocity semantics spec. Doctrine:
// docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md §3.4 (rec 5).
//
// `decideWeaponizationVelocity` measures how fast an operator turned a
// registered domain into a live threat: the whole-hours delta between
// `first_seen` (when the platform first observed the threat live) and
// `domain_created_at` (WHOIS registration), bucketed into a low-cardinality
// band. It is the temporal analogue of `domain_age_days` and shares its
// "static snapshot at detection" semantics — both timestamps are immutable
// once written, so the delta is compute-once.
//
// PURE: no I/O, no env, no ambient clock. `first_seen` is passed in (it is a
// column value, not `now`). All null/garbage guards live here so they are
// unit-testable in one place (mirrors `decideInfraMovement` /
// `measureCapture`). No `any`.
//
// Metadata/evidence ONLY (spec §3, doctrine §3.1): the returned flag MUST
// NEVER gate `lib/alert-triage.ts` dismissals or `lib/alert-ai-judge.ts`
// auto-dismissals. It is a queue-coloring / evidence attribute, never a
// decision. `normal` and `NULL` are NOT exculpatory; `very_fast` is NOT by
// itself incriminating.

// ─── Calibration (single exported block; tunable) ────────────────────────

export const WEAPONIZATION_VELOCITY_CALIBRATION = {
  /** ≤ this many hours ⇒ `very_fast` (register→live inside a day). */
  VERY_FAST_MAX_HOURS: 24,
  /** > very_fast and ≤ this ⇒ `fast` (live within ~3 days). */
  FAST_MAX_HOURS: 72,
  /**
   * Negative-delta tolerance (hours). A delta below `-NEGATIVE_TOLERANCE_HOURS`
   * is NULL'd (data error: backdated/late `first_seen`, clock skew, garbage
   * WHOIS). Ship strict at 0 — any negative ⇒ NULL. Raise later to clamp small
   * VT-vs-feed snapshot skew up toward `very_fast` instead of dropping it.
   */
  NEGATIVE_TOLERANCE_HOURS: 0,
  /**
   * Sentinel floor. A `domain_created_at` parsing to a year before this is a
   * parse artifact, not a real registration (the first commercial `.com`,
   * symbolics.com, was registered 1985-03-15, so nothing legitimate predates
   * it). Catches Unix-epoch-0 (1970) and Windows FILETIME-0 (1601). The guard
   * keys on the ABSOLUTE created year, NEVER on delta magnitude — a genuinely
   * old domain (created 1998, first seen 2026, ~245,000h) is a real
   * purchased-aged domain and classifies `normal`, not NULL.
   */
  DOMAIN_SANITY_FLOOR_YEAR: 1985,
  /**
   * Overflow backstop (~57 years). NULLs any residual absurd delta that slips
   * the year floor. Well beyond any real domain age, so no legitimate
   * post-1985 registration is affected.
   */
  MAX_WEAPONIZATION_HOURS: 500_000,
} as const;

const MS_PER_HOUR = 3_600_000;

// ─── Types ───────────────────────────────────────────────────────────────

export type WeaponizationFlag = 'very_fast' | 'fast' | 'normal';

export interface WeaponizationVelocity {
  /** Whole hours between registration and first-live; NULL when not computable. */
  weaponization_hours: number | null;
  /** Band, or NULL when not computable. NULL ≠ `normal`. */
  weaponization_flag: WeaponizationFlag | null;
}

/** The single not-computable result — both fields NULL. */
const NOT_COMPUTABLE: WeaponizationVelocity = {
  weaponization_hours: null,
  weaponization_flag: null,
};

// ─── Timestamp parsing ───────────────────────────────────────────────────

/**
 * Parse a timestamp to epoch-ms, treating a naive (zone-less) string as UTC.
 *
 * The two inputs differ in format: `domain_created_at` is ISO-8601 (may carry
 * `T`, `Z`, or a `±HH:MM` offset), while `first_seen` is SQLite
 * `datetime('now')` (`YYYY-MM-DD HH:MM:SS`, UTC, no zone marker). This
 * normalizes both robustly:
 *   - an explicit zone (`Z` or `±HH:MM`) is respected as-is;
 *   - a naive string has its space separator normalized to `T` and is stamped
 *     UTC — SQLite datetime and zone-less ISO are both UTC.
 * Returns `NaN` when unparseable.
 */
function parseTimestampUTC(raw: string): number {
  const s = raw.trim();
  if (s === '') return Number.NaN;
  // Explicit zone marker (trailing Z, or a ±HH:MM / ±HHMM offset) — parse as-is.
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    return Date.parse(s);
  }
  // Naive: normalize the SQLite space separator to ISO `T`, then stamp UTC.
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  return Date.parse(`${iso}Z`);
}

// ─── Decide-fn ───────────────────────────────────────────────────────────

/**
 * Compute weaponization velocity for a single threat row from its two raw
 * timestamp columns. Pure and deterministic; all §2 guards inline.
 *
 * Guards (in order):
 *   1. Missing/blank `domainCreatedAt`, or either timestamp unparseable ⇒ NULL.
 *   2. Pre-`DOMAIN_SANITY_FLOOR_YEAR` created date (epoch/FILETIME sentinel)
 *      ⇒ NULL. Keyed on the ABSOLUTE created year, never on delta magnitude,
 *      so a legitimately old post-1985 domain is preserved as `normal`.
 *   3. Negative delta beyond `-NEGATIVE_TOLERANCE_HOURS` ⇒ NULL (strict at 0).
 *      Within-tolerance small negatives clamp to 0.
 *   4. Delta above `MAX_WEAPONIZATION_HOURS` overflow backstop ⇒ NULL.
 *
 * Bands (on the rounded whole-hours delta): `very_fast` ≤ VERY_FAST_MAX_HOURS,
 * `fast` ≤ FAST_MAX_HOURS, `normal` above.
 */
export function decideWeaponizationVelocity(
  domainCreatedAt: string | null,
  firstSeen: string,
): WeaponizationVelocity {
  const cal = WEAPONIZATION_VELOCITY_CALIBRATION;

  // Guard 1: missing input.
  if (domainCreatedAt == null || domainCreatedAt.trim() === '') return NOT_COMPUTABLE;

  const createdMs = parseTimestampUTC(domainCreatedAt);
  if (Number.isNaN(createdMs)) return NOT_COMPUTABLE;

  // `first_seen` is NOT NULL in schema, but never throw — NULL out if unparseable.
  const firstSeenMs = parseTimestampUTC(firstSeen);
  if (Number.isNaN(firstSeenMs)) return NOT_COMPUTABLE;

  // Guard 2: pre-1985 sentinel created date (absolute year, not delta size).
  if (new Date(createdMs).getUTCFullYear() < cal.DOMAIN_SANITY_FLOOR_YEAR) {
    return NOT_COMPUTABLE;
  }

  const deltaHours = (firstSeenMs - createdMs) / MS_PER_HOUR;

  // Guard 3: negative delta beyond tolerance (strict at 0 ⇒ any negative NULLs).
  if (deltaHours < -cal.NEGATIVE_TOLERANCE_HOURS) return NOT_COMPUTABLE;

  // Within-tolerance small negatives clamp to 0 before rounding.
  const hours = Math.round(Math.max(0, deltaHours));

  // Guard 4: overflow backstop for any absurd delta that slipped the year floor.
  if (hours > cal.MAX_WEAPONIZATION_HOURS) return NOT_COMPUTABLE;

  let flag: WeaponizationFlag;
  if (hours <= cal.VERY_FAST_MAX_HOURS) flag = 'very_fast';
  else if (hours <= cal.FAST_MAX_HOURS) flag = 'fast';
  else flag = 'normal';

  return { weaponization_hours: hours, weaponization_flag: flag };
}
