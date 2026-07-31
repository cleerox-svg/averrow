/**
 * Shared constants for the AI-phishing signal lane
 * (`phishing_pattern_signals`, migration 0023).
 */

/**
 * Minimum `phishing_pattern_signals.ai_generated_probability` (REAL, 0–1)
 * at which a captured message counts as AI-generated.
 *
 * Comparisons are inclusive (`>= AI_GENERATION_PROBABILITY_THRESHOLD`) and
 * NULL-safe by construction: SQLite evaluates `NULL >= 0.7` to NULL, which is
 * falsy in a WHERE clause, so unscored rows are never counted.
 */
export const AI_GENERATION_PROBABILITY_THRESHOLD = 0.7;
