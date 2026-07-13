// Averrow — bounded dynamic-regex compilation (defense-in-depth ReDoS guard)
//
// Any `new RegExp(src)` compiled from data rather than a code literal is a
// latent ReDoS vector the day that data becomes attacker-reachable. Today the
// call sites are operator-/code-controlled — the named_threats catalog
// (migration 0204) is operator-curated, and the DMARC tag templates are built
// from hardcoded tag names — so this is forward-looking hardening, NOT a live
// vulnerability. `safeCompilePattern` caps the source length and rejects an
// excessive quantifier count before compiling, returning null (never throwing)
// so callers can skip a rejected pattern instead of breaking a match loop.

/**
 * Max regex source length we will compile from data.
 *
 * The longest pattern in the current named_threats seed catalog (migration
 * 0204) is ~55 chars (`login\.microsoftonline\.com\/[^\s"]*device(?:code|auth)`);
 * the DMARC tag templates are ~35 chars. 512 is a deliberately generous ~9x
 * headroom that no legitimate current pattern approaches, while still bounding
 * the input a pathological pattern could ever be constructed from.
 */
export const MAX_REGEX_SOURCE_LEN = 512;

/**
 * Reject sources carrying more than this many quantifiers (`*`, `+`, or
 * `{n,m}`). Catastrophic backtracking is driven by nested/adjacent unbounded
 * quantifiers; legitimate catalog patterns use a small handful (the current
 * seed maxes out at two). This is a cheap ceiling on obviously pathological
 * input, not a full ReDoS analyzer.
 */
export const MAX_REGEX_QUANTIFIERS = 20;

/**
 * Compile a regex source string with defense-in-depth bounds. Returns the
 * compiled RegExp, or null when the source is over-long, over-complex, or
 * syntactically invalid. Never throws.
 */
export function safeCompilePattern(source: string, flags = ""): RegExp | null {
  if (source.length > MAX_REGEX_SOURCE_LEN) return null;
  // Light complexity heuristic: count unbounded (`*`/`+`) and bounded
  // (`{n,m}`) quantifiers. Not a full analyzer — just a ceiling.
  const quantifiers = (source.match(/[*+]|\{\d+(?:,\d*)?\}/g) ?? []).length;
  if (quantifiers > MAX_REGEX_QUANTIFIERS) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}
