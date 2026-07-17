/**
 * Impersonation Risk Scorer
 *
 * Scores the likelihood that a social media account is impersonating a brand
 * based on multiple signals: name similarity, account characteristics,
 * handle permutation match, verification status, etc.
 */

export interface ImpersonationSignals {
  name_similarity: number;        // 0-1 (Levenshtein-based)
  uses_brand_keywords: boolean;
  account_age_suspicious: boolean;
  low_followers: boolean;
  verified: boolean;
  handle_is_permutation: boolean;
}

export interface ImpersonationResult {
  score: number;          // 0.0-1.0
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reasons: string[];
}

// Signal weights for scoring
const WEIGHTS = {
  name_similarity: 0.30,
  uses_brand_keywords: 0.15,
  account_age_suspicious: 0.10,
  low_followers: 0.10,
  not_verified: 0.10,
  handle_is_permutation: 0.25,
} as const;

/**
 * Score impersonation risk based on multiple signals.
 */
export function scoreImpersonation(signals: ImpersonationSignals): ImpersonationResult {
  const reasons: string[] = [];
  let score = 0;

  // Name similarity contribution
  if (signals.name_similarity > 0.5) {
    score += signals.name_similarity * WEIGHTS.name_similarity;
    if (signals.name_similarity > 0.8) {
      reasons.push(`Account name is very similar to brand (${(signals.name_similarity * 100).toFixed(0)}% match)`);
    } else {
      reasons.push(`Account name resembles brand (${(signals.name_similarity * 100).toFixed(0)}% match)`);
    }
  }

  // Brand keyword usage
  if (signals.uses_brand_keywords) {
    score += WEIGHTS.uses_brand_keywords;
    reasons.push('Account name or bio contains brand keywords');
  }

  // Suspicious account age
  if (signals.account_age_suspicious) {
    score += WEIGHTS.account_age_suspicious;
    reasons.push('Account was recently created');
  }

  // Low follower count
  if (signals.low_followers) {
    score += WEIGHTS.low_followers;
    reasons.push('Account has suspiciously low follower count');
  }

  // Not verified (inverse signal)
  if (!signals.verified) {
    score += WEIGHTS.not_verified;
    reasons.push('Account is not verified');
  }

  // Handle is a known permutation of the brand
  if (signals.handle_is_permutation) {
    score += WEIGHTS.handle_is_permutation;
    reasons.push('Handle is a permutation of the official brand handle');
  }

  // Clamp to [0, 1]
  score = Math.min(1, Math.max(0, score));

  // Determine severity
  let severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  if (score >= 0.9) {
    severity = 'CRITICAL';
  } else if (score >= 0.7) {
    severity = 'HIGH';
  } else if (score >= 0.4) {
    severity = 'MEDIUM';
  } else {
    severity = 'LOW';
  }

  return { score, severity, reasons };
}

/**
 * Compute the Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;

  if (la === 0) return lb;
  if (lb === 0) return la;

  // Use a single-row DP approach for memory efficiency
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);

  for (let j = 0; j <= lb; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,        // deletion
        curr[j - 1]! + 1,    // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[lb]!;
}

/**
 * Compute normalized name similarity between a brand name and an account name.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
export function nameSimilarity(brandName: string, accountName: string): number {
  const a = brandName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = accountName.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;

  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  const similarity = 1 - dist / maxLen;

  // Bonus: check if one contains the other (substring match)
  if (b.includes(a) || a.includes(b)) {
    return Math.min(1, similarity + 0.2);
  }

  return Math.max(0, similarity);
}
