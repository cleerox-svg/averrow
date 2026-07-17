/**
 * Handle Permutation Generator
 *
 * Generates plausible social media handle variations for a brand name.
 * Used by the social monitoring pipeline to detect squatting and impersonation.
 */

export interface HandlePermutation {
  handle: string;
  type: 'separator' | 'suffix' | 'prefix' | 'substitution' | 'truncation';
}

/**
 * Normalize a brand name into a base handle string.
 * Strips non-alphanumeric characters and lowercases.
 */
function toBaseHandle(brandName: string): string {
  return brandName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 30);
}

/**
 * Try to split a concatenated brand name into component words.
 * E.g. "acmecorp" might come from "Acme Corp" — we use the original brand name
 * to detect word boundaries.
 */
function splitBrandWords(brandName: string): string[] {
  // Split on spaces, hyphens, underscores first
  const parts = brandName
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((p) => p.length > 0);

  if (parts.length > 1) return parts;

  // Try to split camelCase: "AcmeCorp" → ["acme", "corp"]
  const camelSplit = brandName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length > 0);

  if (camelSplit.length > 1) return camelSplit;

  // Single word — return as-is
  return [brandName.toLowerCase().replace(/[^a-z0-9]/g, '')];
}

/**
 * Generate handle permutations for a given brand name.
 * Returns a deduplicated list of plausible handles that someone might register
 * to impersonate or squat on the brand.
 */
export function generateHandlePermutations(brandName: string): HandlePermutation[] {
  const base = toBaseHandle(brandName);
  if (!base || base.length < 2) return [];

  const words = splitBrandWords(brandName);
  const seen = new Set<string>();
  const results: HandlePermutation[] = [];

  function add(handle: string, type: HandlePermutation['type']): void {
    const h = handle.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30);
    if (!h || h.length < 2 || h === base || seen.has(h)) return;
    seen.add(h);
    results.push({ handle: h, type });
  }

  // 1. Separator variants (only if we have multiple words)
  if (words.length > 1) {
    add(words.join('_'), 'separator');
    add(words.join('.'), 'separator');
    add(words.join('-'), 'separator');
    // Reversed word order
    const reversed = [...words].reverse();
    add(reversed.join(''), 'separator');
    add(reversed.join('_'), 'separator');
  }

  // 2. Suffix variants
  const suffixes = ['_official', '_hq', '_inc', '_app', '_team', '_real', '_support', '_help'];
  for (const suffix of suffixes) {
    add(base + suffix, 'suffix');
  }

  // 3. Prefix variants
  const prefixes = ['the', 'real', 'official', 'get', 'try'];
  for (const prefix of prefixes) {
    add(prefix + base, 'prefix');
  }

  // 4. Character substitution
  const substitutions: Array<[string, string]> = [
    ['o', '0'],
    ['l', '1'],
    ['e', '3'],
    ['a', '4'],
    ['i', '1'],
    ['s', '5'],
  ];

  for (const [from, to] of substitutions) {
    if (base.includes(from)) {
      // Replace first occurrence only
      add(base.replace(from, to), 'substitution');
    }
  }
  // Append a digit
  add(base + '1', 'substitution');
  add(base + '0', 'substitution');

  // 5. Truncation (for longer handles, >= 6 chars)
  if (base.length >= 6) {
    // Truncate to first word if multi-word
    if (words.length > 1 && words[0]!.length >= 3) {
      add(words[0]!, 'truncation');
    }
    // Truncate at various lengths
    const truncLen = Math.min(base.length - 2, Math.ceil(base.length * 0.6));
    if (truncLen >= 3) {
      add(base.slice(0, truncLen), 'truncation');
    }
    // Truncate at 75%
    const truncLen75 = Math.ceil(base.length * 0.75);
    if (truncLen75 >= 3 && truncLen75 < base.length) {
      add(base.slice(0, truncLen75), 'truncation');
    }
  }

  return results;
}
