/**
 * Brand Auto-Detection — Match threat domains against known brands.
 *
 * Strategies (in order of confidence):
 * 1. Exact domain match against brands.canonical_domain
 * 2. Substring match: domain contains brand name (e.g., "paypal-secure.com" → PayPal)
 * 3. Obfuscation-stripped match: remove common phishing words then substring check
 * 4. Levenshtein fuzzy match: domain segment within edit distance 2 of a brand name
 */

export interface BrandRow {
  id: string;
  name: string;
  canonical_domain: string;
}

/** Words commonly inserted into typosquat / phishing domains to obfuscate. */
const OBFUSCATION_WORDS = [
  "login", "logon", "log", "signin", "signin", "sign", "verify",
  "secure", "account", "support", "help", "official", "update",
  "confirm", "alert", "service", "customer", "online", "web",
];

const OBFUSCATION_RE = new RegExp(OBFUSCATION_WORDS.join("|"), "gi");

/**
 * Strip common phishing obfuscation words and hyphens from a string.
 */
export function stripObfuscation(input: string): string {
  return input
    .replace(/-/g, "")
    .replace(OBFUSCATION_RE, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "");
}

/**
 * Levenshtein edit distance between two strings.
 * Bails out early if distance exceeds maxDist.
 */
export function levenshtein(a: string, b: string, maxDist = 2): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;

  // Single-row DP with early bail-out
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);

  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    [prev, curr] = [curr, prev];
  }

  return prev[lb];
}

/**
 * Split a domain or URL path into segments for fuzzy matching.
 * "paypa1-login.evil.com/account" → ["paypa1", "login", "evil", "com", "account"]
 */
function segments(input: string): string[] {
  return input.toLowerCase().split(/[.\-\/]+/).filter(s => s.length >= 3);
}

/** Normalized brand name (lowercase, alphanumeric only). */
function normalizeBrand(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Brand names that are too generic — common URL fragments that cause false positives. */
const GENERIC_BRAND_NAMES = new Set([
  "www", "one", "bit", "dns", "app", "web", "api", "cdn", "dev", "net", "goo",
]);

/** Returns true if a normalized brand name should be skipped for fuzzy matching. */
function isGenericBrand(normalized: string): boolean {
  return /^\d+$/.test(normalized) || GENERIC_BRAND_NAMES.has(normalized);
}

/**
 * Load all brands from DB.
 */
async function loadBrands(db: D1Database): Promise<BrandRow[]> {
  const rows = await db.prepare("SELECT id, name, canonical_domain FROM brands").all<BrandRow>();
  return rows.results;
}

/**
 * Try to match a domain to a known brand.
 * Returns brand ID if matched, null otherwise.
 */
function matchBrand(domain: string, brands: BrandRow[]): string | null {
  const lower = domain.toLowerCase();

  // Strategy 1: Exact canonical domain match (strip www.)
  const stripped = lower.replace(/^www\./, "");
  for (const brand of brands) {
    if (stripped === brand.canonical_domain.toLowerCase()) return brand.id;
  }

  // Strategy 2: Domain contains brand name as substring
  for (const brand of brands) {
    const brandLower = normalizeBrand(brand.name);
    if (brandLower.length < 4 || isGenericBrand(brandLower)) continue;
    if (lower.includes(brandLower)) return brand.id;
  }

  return null;
}

/**
 * Fuzzy brand matching — tries all strategies against multiple input strings.
 * Returns the first brand ID matched, or null.
 *
 * @param haystacks - array of non-null strings to check (domain, url, ioc_value)
 * @param brands - list of known brands
 */
export function fuzzyMatchBrand(haystacks: string[], brands: BrandRow[]): string | null {
  for (const raw of haystacks) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    const stripped = lower.replace(/^www\./, "");

    // Strategy 1: Exact canonical domain match
    for (const brand of brands) {
      if (stripped === brand.canonical_domain.toLowerCase()) return brand.id;
    }

    // Strategy 2: Direct substring match (brand name in haystack)
    for (const brand of brands) {
      const brandLower = normalizeBrand(brand.name);
      if (brandLower.length < 4 || isGenericBrand(brandLower)) continue;
      if (lower.includes(brandLower)) return brand.id;
    }

    // Strategy 3: Strip obfuscation words and hyphens, then substring match
    const cleaned = stripObfuscation(lower);
    for (const brand of brands) {
      const brandLower = normalizeBrand(brand.name);
      if (brandLower.length < 4 || isGenericBrand(brandLower)) continue;
      if (cleaned.includes(brandLower)) return brand.id;
    }

    // Strategy 4: Levenshtein on individual segments (require length >= 5)
    const segs = segments(raw);
    for (const seg of segs) {
      for (const brand of brands) {
        const brandLower = normalizeBrand(brand.name);
        if (brandLower.length < 5 || isGenericBrand(brandLower)) continue;
        // Only compare segments of similar length to avoid false positives
        if (Math.abs(seg.length - brandLower.length) > 2) continue;
        if (levenshtein(seg, brandLower) <= 2) return brand.id;
      }
    }
  }

  return null;
}

/**
 * Enrich threats that have a malicious_domain but no target_brand_id.
 * Matches against known brands and updates threats in-place.
 */
export async function enrichBrands(db: D1Database): Promise<{ matched: number; total: number }> {
  const brands = await loadBrands(db);
  if (brands.length === 0) return { matched: 0, total: 0 };

  // Get threats missing brand assignment
  const rows = await db.prepare(
    `SELECT id, malicious_domain FROM threats
     WHERE malicious_domain IS NOT NULL AND target_brand_id IS NULL
     LIMIT 500`,
  ).all<{ id: string; malicious_domain: string }>();

  const total = rows.results.length;
  if (total === 0) return { matched: 0, total: 0 };

  let matched = 0;

  for (const row of rows.results) {
    const brandId = matchBrand(row.malicious_domain, brands);
    if (!brandId) continue;

    try {
      await db.prepare(
        "UPDATE threats SET target_brand_id = ? WHERE id = ? AND target_brand_id IS NULL",
      ).bind(brandId, row.id).run();

      // Increment brand threat count
      await db.prepare(
        `UPDATE brands SET
           threat_count = threat_count + 1,
           last_threat_seen = datetime('now')
         WHERE id = ?`,
      ).bind(brandId).run();

      matched++;
    } catch (err) {
      console.error(`[brand-detect] update failed for ${row.id}:`, err);
    }
  }

  return { matched, total };
}
