/**
 * Scoring utilities — single canonical implementations of exposure and priority scoring.
 *
 * Consolidates:
 *   - computeExposureScore: merged from handlers/scanReport.ts and lib/scoring.ts
 *   - computePriorityScore: moved from handlers/takedowns.ts
 */

// Email letter grade → numeric score (higher = better protected)
const EMAIL_GRADE_SCORE: Record<string, number> = {
  'A+': 100, 'A': 95, 'A-': 90,
  'B+': 85,  'B': 80, 'B-': 75,
  'C+': 70,  'C': 65, 'C-': 60,
  'D+': 55,  'D': 50, 'D-': 45,
  'F': 10,
};

/**
 * Compute a brand exposure score (0–100, higher = more exposed / higher risk).
 *
 * Merges the count-based logic from scanReport.ts with the grade-based input
 * used across the rest of the platform.
 *
 * @param components.emailGrade  - Letter grade from email security scan (A+ through F)
 * @param components.threatCount - Number of active threat hits against this brand
 * @param components.domainRisk  - Number of registered lookalike domains
 * @param components.socialRisk  - Number of social handle issues / impersonation signals
 * @param components.trapCatches - Optional spam trap catches (additional signal)
 */
export function computeExposureScore(components: {
  threatCount: number;
  emailGrade: string | null;
  socialRisk: number;
  domainRisk: number;
  trapCatches?: number;
}): number {
  let score = 0;

  // Email security (0–35 points of exposure)
  const emailNumeric = EMAIL_GRADE_SCORE[(components.emailGrade ?? '').toUpperCase()] ?? 50;
  score += Math.round((100 - emailNumeric) * 0.35);

  // Registered lookalike domains (0–30 points)
  const lookalikes = components.domainRisk;
  if (lookalikes > 10) score += 30;
  else if (lookalikes > 5) score += 22;
  else if (lookalikes > 2) score += 15;
  else if (lookalikes > 0) score += 8;

  // Threat feed hits (0–25 points)
  const threats = components.threatCount;
  if (threats > 10) score += 25;
  else if (threats > 5) score += 18;
  else if (threats > 2) score += 12;
  else if (threats > 0) score += 6;

  // Social handle / impersonation issues (0–7 points)
  score += Math.min(7, components.socialRisk * 2);

  // Spam trap catches bonus (0–3 points)
  if (components.trapCatches && components.trapCatches > 0) {
    score += Math.min(3, components.trapCatches);
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Map a severity string to a numeric priority score used for takedown triage.
 */
export function computePriorityScore(severity: string | null): number {
  switch ((severity || '').toUpperCase()) {
    case 'CRITICAL': return 90;
    case 'HIGH':     return 70;
    case 'MEDIUM':   return 50;
    case 'LOW':      return 30;
    default:         return 50;
  }
}
