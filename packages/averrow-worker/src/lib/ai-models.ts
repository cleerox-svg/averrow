/**
 * Canonical model constants for Averrow AI call sites.
 * Change HOT_PATH_HAIKU here to update every non-ARCHITECT AI call at once.
 *
 * Cost reference (per 1M tokens, input / output):
 *   claude-haiku-4-5-20251001   $1.00 / $5.00   (current — only available Haiku as of April 2026)
 *
 * Retired models (DO NOT USE — Anthropic returns errors / hangs):
 *   claude-haiku-3-5-20241022   RETIRED 2026-02-19
 *   claude-3-haiku-20240307     RETIRED 2026-02-19
 *
 * History: this constant briefly held the retired claude-3-haiku-20240307
 * during a deprecation grace period when Anthropic was silently routing
 * the retired model ID to Haiku 4.5. The grace period stopped functioning
 * in production around 2026-04-10 12:25 UTC, breaking every wrapper-based
 * Haiku call. Reverted to claude-haiku-4-5-20251001 the same day.
 */
export const HOT_PATH_HAIKU = "claude-haiku-4-5-20251001" as const;

/**
 * Driver model for the agentic tool-use loop (Campaign Hunter and future
 * real agents). Sonnet 4.6 is the cost/quality sweet spot for multi-turn
 * tool use (adaptive thinking + structured outputs); Haiku is too weak for
 * open-ended pivoting and Opus is reserved for a premium tier.
 *
 * Cost reference (per 1M tokens): claude-sonnet-4-6  $3.00 in / $15.00 out.
 * Must be present in COST_PER_MILLION (lib/budgetManager.ts) for the ledger.
 */
export const AGENT_LOOP_SONNET = "claude-sonnet-4-6" as const;
