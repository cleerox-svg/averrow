/**
 * Brand Exposure Score — composite risk scoring across email security,
 * threat feeds, domain risk, and social risk signals.
 *
 * Produces a 0-100 score, letter grade (A+ through F), and risk level
 * that feeds into Observer briefings and the brand risk dashboard.
 */

// ─── Types ────────────────────────────────────────────────────────

export interface ScoreComponent {
  name: string;
  value: number;     // 0-100
  weight: number;    // 0-1, must sum to 1
  grade?: string;
}

export interface ExposureScoreResult {
  score: number;
  grade: string;
  riskLevel: string;
}

// ─── Grade ↔ Score Conversion ─────────────────────────────────────

const GRADE_TO_SCORE: Record<string, number> = {
  'A+': 100,
  'A':  95,
  'A-': 90,
  'B+': 85,
  'B':  80,
  'B-': 75,
  'C+': 70,
  'C':  65,
  'C-': 60,
  'D+': 55,
  'D':  50,
  'D-': 45,
  'F':  10,
};

/**
 * Convert an email security letter grade (A+ through F) to a numeric 0-100 score.
 */
export function emailGradeToScore(grade: string): number {
  return GRADE_TO_SCORE[grade] ?? 0;
}

/**
 * Convert a numeric 0-100 score to a letter grade.
 */
export function scoreToGrade(score: number): string {
  if (score >= 97) return 'A+';
  if (score >= 93) return 'A';
  if (score >= 90) return 'A-';
  if (score >= 87) return 'B+';
  if (score >= 83) return 'B';
  if (score >= 80) return 'B-';
  if (score >= 77) return 'C+';
  if (score >= 73) return 'C';
  if (score >= 70) return 'C-';
  if (score >= 67) return 'D+';
  if (score >= 63) return 'D';
  if (score >= 60) return 'D-';
  return 'F';
}

// ─── Risk Level ───────────────────────────────────────────────────

function riskLevelFromScore(score: number): string {
  if (score >= 80) return 'LOW';
  if (score >= 60) return 'MODERATE';
  if (score >= 40) return 'HIGH';
  return 'CRITICAL';
}

// ─── Composite Score ──────────────────────────────────────────────

/**
 * Compute a weighted Brand Exposure Score from four signal categories.
 *
 * Weights:
 *   - Email security: 30%  (from email grade)
 *   - Threat feeds:   30%  (inverse of threat count — 100 = no threats)
 *   - Domain risk:    20%  (inverse of lookalike count — 100 = no lookalikes)
 *   - Social risk:    20%  (inverse of impersonation findings — 100 = no issues)
 *
 * All inputs are 0-100 where 100 = best / safest.
 * Returns a composite score (0-100), letter grade, and risk level.
 */
export function computeExposureScore(components: {
  emailSecurity: number;    // 0-100 from email grade
  threatFeeds: number;      // 0-100 (inverse of threat count)
  domainRisk: number;       // 0-100 (inverse of lookalike count)
  socialRisk: number;       // 0-100 (inverse of impersonation findings)
}): ExposureScoreResult {
  const weights = {
    emailSecurity: 0.30,
    threatFeeds:   0.30,
    domainRisk:    0.20,
    socialRisk:    0.20,
  };

  const raw =
    components.emailSecurity * weights.emailSecurity +
    components.threatFeeds   * weights.threatFeeds +
    components.domainRisk    * weights.domainRisk +
    components.socialRisk    * weights.socialRisk;

  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const grade = scoreToGrade(score);
  const riskLevel = riskLevelFromScore(score);

  return { score, grade, riskLevel };
}

/**
 * Build a breakdown of score components for display / audit purposes.
 */
export function buildScoreComponents(components: {
  emailSecurity: number;
  threatFeeds: number;
  domainRisk: number;
  socialRisk: number;
}): ScoreComponent[] {
  return [
    { name: 'Email Security', value: components.emailSecurity, weight: 0.30, grade: scoreToGrade(components.emailSecurity) },
    { name: 'Threat Feeds',   value: components.threatFeeds,   weight: 0.30, grade: scoreToGrade(components.threatFeeds) },
    { name: 'Domain Risk',    value: components.domainRisk,    weight: 0.20, grade: scoreToGrade(components.domainRisk) },
    { name: 'Social Risk',    value: components.socialRisk,    weight: 0.20, grade: scoreToGrade(components.socialRisk) },
  ];
}
